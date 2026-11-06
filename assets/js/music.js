/* Background-music player for the shop PC: follows the queue in api/jukebox.php and plays it
   with the official YouTube embedded player (kept visible, as YouTube's API terms require). */
(function () {
  'use strict';

  var POLL_MS = 3000;
  var $ = function (id) { return document.getElementById(id); };
  var esc = RB.esc;

  var yt = null;            // YT.Player
  var ytReady = false;
  var unlocked = false;     // browser allowed sound (user clicked once)
  var cur = null;           // item currently loaded in the player
  var loadAt = 0;           // when cur was loaded (stall detection)
  var playingSeen = false;  // cur reached PLAYING at least once
  var last = null;          // last state from the server
  var lastAdvance = 0;
  var knownQueue = null;    // queue ids seen before, to announce new requests
  var appliedVol = -1;
  var busy = false;
  var timer = null;

  /* ---------- gate (login / click-to-start) ---------- */
  function gate(kind, text) {
    $('gate').classList.toggle('hidden', !kind);
    $('loginForm').classList.toggle('hidden', kind !== 'login');
    $('startBtn').classList.toggle('hidden', kind !== 'start');
    $('gateText').textContent = text || '';
    $('gateErr').textContent = '';
    if (kind === 'login') setTimeout(function () { $('pw').focus(); }, 50);
    if (kind === 'start') setTimeout(function () { $('startBtn').focus(); }, 50);
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    JB.login($('pw').value).then(function () {
      $('pw').value = '';
      gate('start', 'กดปุ่มเพื่อเริ่ม — เบราว์เซอร์ต้องให้กดหนึ่งครั้งก่อนจึงจะเปิดเสียงได้');
      tick();
    }).catch(function (err) { $('gateErr').textContent = err.message; });
  });

  $('startBtn').addEventListener('click', function () {
    unlocked = true;
    gate(null);
    if (yt && ytReady && cur) { yt.playVideo(); }
    tick();
  });

  /* ---------- YouTube player ---------- */
  window.onYouTubeIframeAPIReady = function () {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0 },
      events: {
        onReady: function () { ytReady = true; appliedVol = -1; if (last) apply(last); },
        onStateChange: onState,
        onError: function (e) {
          var item = cur;
          if (!item) return;
          // 101/150: owner blocks embedding, 100: removed/private, 2: bad id, 5: html5 error
          toast('ข้ามเพลง: ' + item.title + ' (เปิดไม่ได้)');
          setTimeout(function () { advance(item.id, e.data || 1); }, 1500);
        }
      }
    });
  };

  function onState(e) {
    if (!cur) return;
    if (e.data === YT.PlayerState.PLAYING) {
      playingSeen = true;
      if (last && last.player.paused) yt.pauseVideo();
    }
    if (e.data === YT.PlayerState.ENDED) advance(cur.id, 0);
  }

  function loadScript() {
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = function () { status('โหลด YouTube ไม่ได้ — เช็คอินเทอร์เน็ต', true); setTimeout(loadScript, 15000); };
    document.head.appendChild(s);
  }

  function load(item, startAt) {
    cur = item;
    loadAt = Date.now();
    playingSeen = false;
    if (!ytReady) return;
    yt.loadVideoById({ videoId: item.vid, startSeconds: startAt || 0 });
    if (last && last.player.paused) setTimeout(function () { yt.pauseVideo(); }, 800);
  }

  /* ---------- server sync ---------- */
  function playerInfo() {
    var info = { id: cur ? cur.id : '', pos: 0, dur: 0 };
    if (yt && ytReady && cur && yt.getCurrentTime) {
      info.pos = Math.floor(yt.getCurrentTime() || 0);
      info.dur = Math.floor(yt.getDuration() || 0);
    }
    return info;
  }

  function advance(fromId, error) {
    lastAdvance = Date.now();
    return JB.call('advance', { json: { from: fromId || '', error: error || 0 } })
      .then(apply).catch(onErr);
  }

  function tick() {
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS);
    if (busy) return;
    if (!JB.token()) { gate('login', 'เครื่องนี้ใช้เปิดเพลงหลักของร้าน — เข้าสู่ระบบด้วยรหัสผ่านเดียวกับแผงควบคุม (ทำครั้งเดียว)'); return; }
    busy = true;
    JB.call('report', { json: playerInfo() })
      .then(function (s) { if (!unlocked && $('gate').classList.contains('hidden')) gate('start', 'กดปุ่มเพื่อเริ่มเปิดเพลง'); apply(s); })
      .catch(onErr)
      .then(function () { busy = false; });
  }

  function onErr(err) {
    if (err.status === 401 || err.status === 403) { gate('login', 'กรุณาเข้าสู่ระบบใหม่'); return; }
    if (err.status === 404) { status('ไม่พบ api/jukebox.php บน Host', true); return; }
    status('ออฟไลน์ — กำลังลองใหม่', true);
  }

  function apply(s) {
    last = s;
    status(s.now && cur && s.now.id === cur.id && playingSeen ? '' : (s.now ? 'กำลังโหลดเพลง…' : ''), false);
    if (!s.now) {
      if (cur) { cur = null; if (ytReady) yt.stopVideo(); }
      if ((s.queue.length || s.rules.hasFallback) && Date.now() - lastAdvance > 15000) advance('', 0);
    } else if (!cur || s.now.id !== cur.id) {
      var start = s.now.start || 0;
      if (s.player.id === s.now.id && s.player.pos > 5) start = s.player.pos; // page reloaded mid-song
      load(s.now, start);
    } else if (ytReady) {
      var st = yt.getPlayerState();
      if (s.player.paused && st === YT.PlayerState.PLAYING) yt.pauseVideo();
      if (!s.player.paused && unlocked && (st === YT.PlayerState.PAUSED || st === YT.PlayerState.CUED)) yt.playVideo();
      // stuck loading for 25 s (no network, region block without an error event): move on
      if (!playingSeen && unlocked && !s.player.paused && Date.now() - loadAt > 25000) { toast('ข้ามเพลงที่โหลดไม่ขึ้น'); advance(cur.id, 999); }
    }
    if (ytReady && s.player.volume !== appliedVol) { yt.setVolume(s.player.volume); appliedVol = s.player.volume; }
    render(s);
  }

  /* ---------- view ---------- */
  function who(it) {
    if (!it) return '';
    if (it.src === 'fallback') return 'เพลงเปิดรอ';
    return 'ขอโดย <b>' + esc(it.by || 'ลูกค้า') + '</b>' + (it.room ? ' · ' + esc(it.room) : '');
  }

  function render(s) {
    $('idle').classList.toggle('hidden', !!s.now);
    $('nowLabel').textContent = s.now ? (s.player.paused ? 'หยุดชั่วคราว' : 'กำลังเล่น') : 'ว่าง';
    $('nowTitle').textContent = s.now ? s.now.title : 'ยังไม่มีเพลง';
    $('nowBy').innerHTML = who(s.now);

    var fresh = {};
    if (knownQueue) s.queue.forEach(function (q) { if (!knownQueue[q.id]) fresh[q.id] = 1; });
    var ids = {};
    s.queue.forEach(function (q) { ids[q.id] = 1; });
    if (knownQueue) {
      var added = s.queue.filter(function (q) { return fresh[q.id]; });
      if (added.length) toast('♪ ' + (added[0].by || 'ลูกค้า') + ' ขอเพลง ' + added[0].title);
    }
    knownQueue = ids;

    var max = 6;
    $('qCount').textContent = s.queue.length ? s.queue.length + ' เพลง' : '';
    $('queue').innerHTML = s.queue.length ? s.queue.slice(0, max).map(function (q, i) {
      return '<li class="' + (fresh[q.id] ? 'new' : '') + '"><span class="n">' + (i + 1) + '</span>' +
        '<img src="' + JB.thumb(q.vid) + '" alt="" loading="lazy">' +
        '<span class="t"><b>' + esc(q.title) + '</b><span>' + who(q).replace(/<\/?b>/g, '') + '</span></span></li>';
    }).join('') + (s.queue.length > max ? '<li class="more">และอีก ' + (s.queue.length - max) + ' เพลง</li>' : '')
      : '<li class="empty">' + (s.rules.hasFallback ? 'ระหว่างนี้เปิดเพลงรอไปก่อน' : 'คิวว่าง') + ' — สแกน QR เพื่อขอเพลง</li>';
  }

  function progress() {
    var pos = 0, dur = 0;
    if (yt && ytReady && cur && yt.getCurrentTime) { pos = yt.getCurrentTime() || 0; dur = yt.getDuration() || 0; }
    $('tPos').textContent = JB.fmt(pos);
    $('tDur').textContent = JB.fmt(dur);
    $('bar').style.width = dur ? Math.min(100, pos / dur * 100) + '%' : '0';
  }

  var toastT = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 5000);
  }

  function status(msg, warn) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.classList.toggle('warn', !!warn);
  }

  function clock() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    $('clock').textContent = p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function drawQr() {
    var url = JB.requestUrl();
    $('qrUrl').textContent = url.replace(/^https?:\/\//, '');
    try {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (_) {
      $('qr').innerHTML = '';
      $('qr').style.display = 'none';
    }
  }

  /* ---------- misc ---------- */
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  }
  $('fsBtn').addEventListener('click', fullscreen);
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'f' || e.key === 'F') fullscreen();
  });

  var idleT = null;
  document.addEventListener('mousemove', function () {
    document.body.classList.remove('cursor-off');
    clearTimeout(idleT);
    idleT = setTimeout(function () { document.body.classList.add('cursor-off'); }, 4000);
  });

  if ('wakeLock' in navigator) {
    var lock = function () { navigator.wakeLock.request('screen').catch(function () {}); };
    lock();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') lock(); });
  }

  fetch(RB.CONFIG_PATH + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { if (c && c.shop && c.shop.name) $('shop').textContent = c.shop.name; }).catch(function () {});

  drawQr();
  clock();
  setInterval(clock, 10000);
  setInterval(progress, 1000);
  loadScript();
  tick();
})();
