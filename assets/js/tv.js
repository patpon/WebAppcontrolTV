/* TV player: tv.html?room=3
   - polls data/config.json and plays the room's playlist (image / video / menu / promo slides)
   - keeps working offline with the last good config + service-worker media cache
   Kept to conservative JS so Android-TV / Tizen / webOS browsers can run it. */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var ROOM = qs.get('room') || '1';
  var DRAFT = qs.get('draft') === '1';          // preview unsaved changes from the admin tab
  var FORCE_PL = qs.get('playlist');             // preview one playlist regardless of room
  var CACHE_KEY = 'rb_tv_cfg';
  var BOOT = Date.now();

  // Remember which room this box belongs to, so index.html can reopen it next time.
  if (!DRAFT && !FORCE_PL && qs.get('room')) {
    try { localStorage.setItem('rb_room', ROOM); } catch (e) {}
  }

  var cfg = null, room = null, rotation = null;
  var queue = [], idx = -1, timer = null, sig = '', reloadSig = null;
  var pollTimer = null, welcomeTimer = null;
  var unlocked = false;

  function $(id) { return document.getElementById(id); }
  var esc = RB.esc;

  /* ---------- config loading ---------- */
  function fetchConfig() {
    if (DRAFT) {
      try {
        var d = localStorage.getItem('rb_draft');
        if (d) return Promise.resolve(JSON.parse(d));
      } catch (e) { /* fall through to network */ }
    }
    return fetch(RB.CONFIG_PATH + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (c) {
        setOnline(true);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {}
        return c;
      })
      .catch(function (err) {
        setOnline(false);
        var cached = null;
        try { cached = localStorage.getItem(CACHE_KEY); } catch (e) {}
        if (cached) return JSON.parse(cached);
        throw err;
      });
  }

  function load() {
    return fetchConfig().then(apply).catch(function (err) {
      console.error(err);
      if (!cfg) showScreen('<h1>กำลังเชื่อมต่อ…</h1><p>' + esc(err.message) + '</p>');
    });
  }

  /* ---------- screen rotation ----------
     For a TV mounted portrait while the device still outputs landscape (most smart TVs / boxes):
     the whole page is turned 90° in CSS (html.rot-90 / html.rot-270), and html.portrait switches
     the entrance layout to "board on top, slides below". */
  function rotationOf(r) {
    var d = Number(r && r.rotate) || 0;
    return d === 90 || d === 270 ? d : 0;
  }
  function isRotated() {
    var c = document.documentElement.classList;
    return c.contains('rot-90') || c.contains('rot-270');
  }
  function viewWidth() { return isRotated() ? window.innerHeight : window.innerWidth; }
  function updatePortrait() {
    var w = viewWidth(), h = isRotated() ? window.innerWidth : window.innerHeight;
    document.documentElement.classList.toggle('portrait', h >= w);
  }
  function applyRotation(deg) {
    var c = document.documentElement.classList;
    c.toggle('rot-90', deg === 90);
    c.toggle('rot-270', deg === 270);
    updatePortrait();
  }
  window.addEventListener('resize', updatePortrait);
  // Turn the page before the first paint using the last config this screen saw.
  (function () {
    var saved = null;
    try { saved = localStorage.getItem(CACHE_KEY); } catch (e) {}
    var r = null;
    try { r = saved ? RB.findRoom(RB.normalize(JSON.parse(saved)), ROOM) : null; } catch (e) {}
    applyRotation(rotationOf(r));
  })();

  function setOnline(ok) { $('netStatus').classList.toggle('hidden', ok); }

  function apply(raw) {
    cfg = RB.normalize(raw);
    room = RB.findRoom(cfg, ROOM);
    if (!room) {
      room = RB.defaultRoom(ROOM);
      room.mode = 'message';
      room.message = 'ไม่พบห้อง "' + ROOM + '" ในระบบ';
    }

    // Remote "reload" command from admin (global or per room)
    var rs = String(cfg.reload) + '|' + String(room.reload);
    if (reloadSig === null) reloadSig = rs;
    else if (rs !== reloadSig) { location.reload(); return; }

    // Rotation changes the whole layout, so a change after boot just reloads the page.
    var rot = rotationOf(room);
    if (rotation === null) { rotation = rot; applyRotation(rot); }
    else if (rot !== rotation) { location.reload(); return; }

    applyTheme();
    applyHud();
    applyTicker();
    applyWelcome();
    renderBoard();

    var plId = FORCE_PL || room.playlist;
    var newSig = JSON.stringify([room.mode, room.message, plId, RB.byId(cfg.playlists, plId), cfg.menu, cfg.media, cfg.shop]);
    if (newSig !== sig) { sig = newSig; start(); pruneMediaCache(); }

    schedulePoll();
  }

  function pruneMediaCache() {
    var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw || DRAFT) return;
    var urls = cfg.media.map(function (m) { var u = new URL(RB.mediaUrl(m.src)); return u.origin + u.pathname; });
    sw.postMessage({ type: 'keep-media', urls: urls });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    var sec = Math.max(10, Number(cfg.settings.pollSeconds) || 30);
    pollTimer = setTimeout(load, sec * 1000);
  }

  /* ---------- chrome: theme, hud, ticker, welcome ---------- */
  function applyTheme() {
    var t = cfg.shop.theme, s = document.documentElement.style;
    s.setProperty('--primary', t.primary);
    s.setProperty('--accent', t.accent);
    s.setProperty('--bg', t.bg);
    document.title = cfg.shop.name + ' — ' + room.name;
  }

  function logoUrl() {
    var m = RB.byId(cfg.media, cfg.shop.logo);
    return m ? RB.mediaUrl(m.src) : 'assets/img/lotus.svg';
  }

  function applyHud() {
    $('hudLogo').src = logoUrl();
    $('hudShop').textContent = cfg.shop.name;
    $('hudRoom').textContent = room.name;
    document.body.classList.toggle('no-clock', !cfg.settings.showClock);
  }

  var lastTicker = '';
  function applyTicker() {
    var on = cfg.ticker.enabled && cfg.ticker.text;
    $('ticker').classList.toggle('hidden', !on);
    document.body.classList.toggle('no-ticker', !on);
    if (!on) return;
    var key = cfg.ticker.text + '|' + cfg.ticker.speed;
    if (key === lastTicker) return;
    lastTicker = key;
    var el = $('tickerText');
    el.textContent = cfg.ticker.text;
    el.style.animation = 'none';
    // measure after layout, then run at a constant px/sec speed
    setTimeout(function () {
      var win = el.parentNode.offsetWidth, w = el.offsetWidth;
      var pxPerSec = Math.max(20, Number(cfg.ticker.speed) || 60) * (viewWidth() / 1280);
      el.style.setProperty('--from', win + 'px');
      el.style.animation = 'tick ' + ((w + win) / pxPerSec).toFixed(1) + 's linear infinite';
    }, 50);
  }

  /* Manual welcome text wins; otherwise karaoke rooms greet today's booking automatically. */
  function welcomeText() {
    var t = (room.welcome || '').trim();
    if (t || !cfg.settings.autoWelcome || cfg.rooms.indexOf(room) < 0) return t;
    var b = RB.currentBooking(cfg, room.id, new Date());
    if (!b || !b.name) return '';
    return RB.displayName(b.name, cfg.settings.maskNames) + (b.note ? ' · ' + b.note : '');
  }

  var lastWelcome = null;
  function applyWelcome() {
    var text = isPlaylistMode() ? welcomeText() : '';
    if (text === lastWelcome) return; // re-arming on every poll would show the banner every 30 s
    lastWelcome = text;
    var box = $('welcome');
    $('welcomeText').textContent = text;
    clearInterval(welcomeTimer);
    if (!text) { box.classList.remove('on'); return; }
    var cycle = function () {
      box.classList.add('on');
      setTimeout(function () { box.classList.remove('on'); }, 15000);
    };
    cycle();
    welcomeTimer = setInterval(cycle, 60000);
  }

  // 'auto' = playlist while the room is idle; the bridge on the central PC switches to the karaoke app on remote input
  function isPlaylistMode() { return room.mode === 'playlist' || room.mode === 'auto' || room.mode === 'lobby'; }

  /* ---------- entrance booking board (modes: lobby = board + slides, bookings = board only) ---------- */
  var boardPage = 0, boardTimer = null, boardHtml = '';
  function renderBoard() {
    var on = room.mode === 'lobby' || room.mode === 'bookings';
    if (!$('board')) return; // stale cached tv.html from before the board existed
    document.body.classList.toggle('layout-lobby', room.mode === 'lobby');
    document.body.classList.toggle('layout-bookings', room.mode === 'bookings');
    $('board').classList.toggle('hidden', !on);
    if (!on) { clearInterval(boardTimer); boardTimer = null; boardHtml = ''; return; }

    var now = new Date();
    var date = RB.businessDate(now, cfg.settings.dayStartHour);
    var ses = RB.currentSession(cfg, now);
    var list = RB.bookingsFor(cfg, date, ses.id);
    var per = room.mode === 'bookings' ? 9 : 7;
    var pages = Math.max(1, Math.ceil(list.length / per));
    if (boardPage >= pages) boardPage = 0;

    var rows = list.slice(boardPage * per, boardPage * per + per).map(function (b, i) {
      var r = RB.findRoom(cfg, b.room);
      var sub = [b.note, b.status === 'arrived' ? 'มาแล้ว' : ''].filter(Boolean).join(' · ');
      return '<div class="bk' + (b.status === 'arrived' ? ' arrived' : '') + '" style="animation-delay:' + (i * 0.06) + 's">' +
        '<span class="r">' + esc(r ? r.name : (b.room || '—')) + '</span>' +
        '<span class="n">' + esc(RB.displayName(b.name, cfg.settings.maskNames)) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        '<span class="g">' + (b.guests ? esc(b.guests) + ' ท่าน' : '') + '</span></div>';
    }).join('');

    var dateText = new Date(date + 'T12:00:00').toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    // while the day session runs, tease how many rooms are already booked for the next session
    var ss = RB.sessions(cfg), later = '';
    var nextSes = ss[ss.indexOf(ses) + 1];
    if (nextSes) {
      var n = RB.bookingsFor(cfg, date, nextSes.id).length;
      if (n) later = '<div class="board-next">' + esc(nextSes.name) + ' ' + esc(nextSes.start) + '–' + esc(nextSes.end) + ' · จองแล้ว ' + n + ' ห้อง</div>';
    }
    var html = '<div class="board-head"><div><h2>การจองวันนี้</h2><span class="ses">' + esc(ses.name) + ' ' + esc(ses.start) + '–' + esc(ses.end) + '</span></div>' +
      '<span class="date">' + esc(dateText) + '</span></div>' +
      (list.length ? '<div class="board-list">' + rows + '</div>'
                   : '<div class="board-empty"><b>ยังมีห้องว่าง</b><span>Walk-in ยินดีต้อนรับ</span></div>') +
      (pages > 1 ? '<div class="board-page">หน้า ' + (boardPage + 1) + ' / ' + pages + '</div>' : '') + later;
    if (html !== boardHtml) { boardHtml = html; $('board').innerHTML = html; }
    if (!boardTimer) boardTimer = setInterval(function () { boardPage++; renderBoard(); }, 8000);
  }

  function tickClock() {
    var d = new Date();
    $('hudClock').textContent = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- modes ---------- */
  function showScreen(html, cls) {
    var s = $('screen');
    s.className = 'screen' + (cls ? ' ' + cls : '');
    s.innerHTML = html;
  }
  function hideScreen() { $('screen').className = 'screen hidden'; $('screen').innerHTML = ''; }

  function clearStage() {
    clearTimeout(timer);
    var st = $('stage');
    Array.prototype.forEach.call(st.querySelectorAll('video'), function (v) { v.pause(); v.removeAttribute('src'); v.load(); });
    st.innerHTML = '';
  }

  function logoScreen(sub) {
    return '<img class="logo" src="' + esc(logoUrl()) + '" alt=""><h1>' + esc(cfg.shop.name) + '</h1>' +
      '<p>' + esc(sub != null ? sub : cfg.shop.tagline) + '</p>';
  }

  function start() {
    document.body.classList.toggle('mode-off', room.mode === 'off');
    $('singHint').classList.add('hidden');
    clearStage();
    if (room.mode === 'off') return showScreen('', 'off');
    if (room.mode === 'logo') return showScreen(logoScreen());
    if (room.mode === 'karaoke') return showScreen(logoScreen('โหมดคาราโอเกะ'));
    if (room.mode === 'message') {
      return showScreen('<div class="msg-label">' + esc(room.name) + '</div><div class="msg">' + esc(room.message || '') + '</div>');
    }
    hideScreen();
    $('singHint').classList.toggle('hidden', room.mode !== 'auto');
    if (room.mode === 'bookings') return;
    buildQueue();
    if (!queue.length) {
      if (room.mode === 'lobby') { $('stage').innerHTML = '<div class="slide show s-logo">' + logoScreen() + '</div>'; return; }
      return showScreen(logoScreen('ยังไม่มีสื่อในเพลย์ลิสต์นี้'));
    }
    idx = -1;
    next();
  }

  /* ---------- playlist ---------- */
  function buildQueue() {
    queue = [];
    var pl = RB.byId(cfg.playlists, FORCE_PL || room.playlist);
    if (!pl) return;
    pl.items.forEach(function (it) {
      if (it.enabled === false) return;
      var dur = Number(it.duration) || 0;
      if (it.type === 'menu') {
        var cats = it.category === '*' ? cfg.menu.categories : [RB.byId(cfg.menu.categories, it.category)];
        cats.forEach(function (cat) {
          if (!cat) return;
          var avail = (cat.items || []).filter(function (x) { return x.available !== false; });
          var per = Math.max(1, Number(it.perPage) || 6);
          var pages = Math.ceil(avail.length / per);
          for (var p = 0; p < pages; p++) {
            queue.push({ type: 'menu', cat: cat, items: avail.slice(p * per, p * per + per), page: p + 1, pages: pages, duration: dur || 12 });
          }
        });
      } else if (it.type === 'image' || it.type === 'video') {
        var m = RB.byId(cfg.media, it.media);
        if (!m) return;
        queue.push(Object.assign({}, it, { src: RB.mediaUrl(m.src), duration: dur || (it.type === 'image' ? 10 : 0) }));
      } else if (it.type === 'promo') {
        var bg = RB.byId(cfg.media, it.bg);
        queue.push(Object.assign({}, it, { bgSrc: bg ? RB.mediaUrl(bg.src) : '', duration: dur || 10 }));
      }
    });
  }

  function step(delta) {
    clearTimeout(timer);
    if (!queue.length) return;
    idx = (idx + delta + queue.length) % queue.length;
    show(queue[idx]);
  }
  function next() { step(1); }

  function show(item) {
    var st = $('stage');
    var el = render(item);
    el.style.setProperty('--dur', (item.duration || 12) + 's');
    var olds = Array.prototype.slice.call(st.children);
    st.appendChild(el);
    void el.offsetWidth; // commit initial opacity before fading in
    el.classList.add('show');
    olds.forEach(function (o) {
      o.classList.remove('show');
      setTimeout(function () {
        var v = o.querySelector('video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        if (o.parentNode) o.parentNode.removeChild(o);
      }, 1000);
    });

    if (item.type === 'video') {
      var v = el.querySelector('video');
      var advanced = false;
      var go = function () { if (!advanced) { advanced = true; next(); } };
      v.addEventListener('ended', go);
      v.addEventListener('error', function () { timer = setTimeout(go, 1500); });
      v.muted = !(item.sound && unlocked);
      var p = v.play();
      if (p && p.catch) p.catch(function () { v.muted = true; v.play().catch(function () { timer = setTimeout(go, 3000); }); });
      if (item.duration > 0) timer = setTimeout(go, item.duration * 1000);
      else timer = setTimeout(go, 10 * 60 * 1000); // safety net if "ended" never fires
    } else {
      timer = setTimeout(next, item.duration * 1000);
    }
    preload(queue[(idx + 1) % queue.length]);
  }

  function preload(item) {
    if (!item) return;
    var src = item.type === 'image' ? item.src : item.bgSrc;
    if (src) { var i = new Image(); i.src = src; }
    if (item.type === 'menu') item.items.forEach(function (x) {
      var m = RB.byId(cfg.media, x.image);
      if (m) { var j = new Image(); j.src = RB.mediaUrl(m.src); }
    });
  }

  function div(cls, html) {
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    return d;
  }

  function render(item) {
    if (item.type === 'image') {
      var u = esc(item.src);
      return div('slide s-image' + (item.fit === 'cover' ? ' cover' : ''),
        '<div class="blur" style="background-image:url(\'' + u + '\')"></div><img class="fg kenburns" src="' + u + '" alt="">');
    }
    if (item.type === 'video') {
      return div('slide s-video' + (item.fit === 'cover' ? ' cover' : ''),
        '<video playsinline webkit-playsinline muted preload="auto" src="' + esc(item.src) + '"></video>');
    }
    if (item.type === 'promo') {
      var el = div('slide s-promo' + (item.bgSrc ? '' : ' plain'),
        (item.bgSrc ? '<div class="bg kenburns" style="background-image:url(\'' + esc(item.bgSrc) + '\')"></div><div class="shade"></div>' : '') +
        '<div class="content">' +
          (item.eyebrow ? '<div class="eyebrow rise">' + esc(item.eyebrow) + '</div>' : '') +
          '<h1 class="rise d2">' + esc(item.title || '') + '</h1>' +
          (item.subtitle ? '<p class="rise d3">' + esc(item.subtitle) + '</p>' : '') +
          (item.price !== '' && item.price != null ? '<div class="price rise d4">' + esc(RB.fmtPrice(item.price)) + '<small>บาท</small></div>' : '') +
        '</div>');
      if (item.color) el.style.setProperty('--slide-color', item.color);
      return el;
    }
    return renderMenu(item);
  }

  function renderMenu(item) {
    var withImg = item.items.some(function (x) { return RB.byId(cfg.media, x.image); });
    var head = '<div class="menu-head"><h2>' + esc(item.cat.name) + '</h2>' +
      (item.pages > 1 ? '<span class="page">' + item.page + ' / ' + item.pages + '</span>' : '') + '</div>';
    var body;
    if (withImg) {
      var n = item.items.length;
      var cols = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
      var rows = Math.ceil(n / cols);
      body = '<div class="menu-grid" style="grid-template-columns:repeat(' + cols + ',1fr);grid-template-rows:repeat(' + rows + ',1fr)">' +
        item.items.map(function (x, i) {
          var m = RB.byId(cfg.media, x.image);
          var ph = m ? '<div class="ph" style="background-image:url(\'' + esc(RB.mediaUrl(m.src)) + '\')"></div>'
                     : '<div class="ph empty">' + esc((x.name || '?').charAt(0)) + '</div>';
          return '<div class="menu-card" style="animation-delay:' + (i * 0.08) + 's">' + ph +
            (x.tag ? '<span class="tag">' + esc(x.tag) + '</span>' : '') +
            '<div class="info"><div><div class="name">' + esc(x.name) + '</div>' +
            (x.desc ? '<div class="desc">' + esc(x.desc) + '</div>' : '') + '</div>' +
            '<div class="price">' + esc(RB.fmtPrice(x.price)) + '<small>฿</small></div></div></div>';
        }).join('') + '</div>';
    } else {
      body = '<div class="menu-list">' + item.items.map(function (x, i) {
        return '<div class="menu-row" style="animation-delay:' + (i * 0.06) + 's"><div class="line"><span class="name">' + esc(x.name) +
          (x.tag ? '<span class="tag-inline">' + esc(x.tag) + '</span>' : '') + '</span><span class="dots"></span>' +
          '<span class="price">' + esc(RB.fmtPrice(x.price)) + '</span></div>' +
          (x.desc ? '<div class="desc">' + esc(x.desc) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
    }
    return div('slide s-menu', head + body);
  }

  /* ---------- device integration ---------- */
  function unlock() {
    unlocked = true;
    $('tapHint').classList.add('gone');
    var de = document.documentElement;
    var rfs = de.requestFullscreen || de.webkitRequestFullscreen;
    if (rfs && !document.fullscreenElement && !document.webkitFullscreenElement) {
      try { var r = rfs.call(de); if (r && r.catch) r.catch(function () {}); } catch (e) {}
    }
    var item = queue[idx];
    var v = $('stage').querySelector('.slide.show video');
    if (v && item && item.sound) v.muted = false;
    keepAwake();
  }

  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  // Home button stays hidden on the TV; mouse/touch or ↑ on the remote reveals it for a few seconds.
  var uiTimer = null;
  function showUi() {
    document.body.classList.add('show-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(function () {
      document.body.classList.remove('show-ui');
      $('homeBtn').blur();
    }, 4000);
  }
  document.addEventListener('mousemove', showUi);
  document.addEventListener('touchstart', showUi, { passive: true });

  document.addEventListener('click', unlock);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp') { e.preventDefault(); showUi(); $('homeBtn').focus(); }
    else if (e.key === 'ArrowDown') { document.body.classList.remove('show-ui'); $('homeBtn').blur(); }
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Enter' || e.key === ' ') unlock();
    else if (e.key === 'r' || e.key === 'R') location.reload();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { keepAwake(); load(); } });
  if (DRAFT) window.addEventListener('storage', function (e) { if (e.key === 'rb_draft') load(); });

  setTimeout(function () { $('tapHint').classList.add('gone'); }, 8000);
  tickClock();
  setInterval(tickClock, 10000);

  // Long-running TV browsers leak memory; refresh every 12h while online.
  setInterval(function () { if (navigator.onLine && Date.now() - BOOT > 12 * 3600 * 1000) location.reload(); }, 10 * 60 * 1000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  keepAwake();
  load();
})();
