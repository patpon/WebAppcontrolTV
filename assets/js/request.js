/* request.html — guests (via the QR on the music screen) search the shop's own music folder or YouTube,
   or paste a YouTube link, to queue a song.
   Staff who log in get remote controls (pause/skip/volume/reorder) and the jukebox settings. */
(function () {
  'use strict';

  var POLL_MS = 4000;
  var PROFILE_KEY = 'rb_jb_profile';
  var $ = function (id) { return document.getElementById(id); };
  var esc = RB.esc;

  var s = null;            // last state
  var fetchedAt = 0;
  var cfg = null;
  var profile = loadProfile();
  var results = [];
  var pending = null;      // song waiting for the name form
  var settingsShown = false;
  var timer = null;
  var volDragging = false;
  var searching = false;

  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch (_) { return null; }
  }
  function saveProfile(p) {
    profile = p;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (_) {}
  }

  /* ---------- polling ---------- */
  function poll() {
    clearTimeout(timer);
    timer = setTimeout(poll, POLL_MS);
    if (document.visibilityState === 'hidden') return;
    JB.call('state', { query: 'dev=' + encodeURIComponent(JB.device()) })
      .then(function (d) { s = d; fetchedAt = Date.now(); render(); })
      .catch(function (err) {
        if (err.status === 404) $('nowTitle').textContent = 'ระบบขอเพลงยังไม่เปิดใช้บน Host นี้';
        else $('nowTitle').textContent = 'เชื่อมต่อไม่ได้ — กำลังลองใหม่';
      });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); });

  function useState(d) { s = d; fetchedAt = Date.now(); render(); }

  /* ---------- render ---------- */
  function who(it) {
    if (it.src === 'fallback') return 'เพลงเปิดรอ';
    if (it.kind === 'local' && !it.by) return 'เพลงในร้าน';
    return 'ขอโดย ' + esc(it.by || 'ลูกค้า') + (it.room ? ' · ' + esc(it.room) : '');
  }

  function render() {
    var staff = !!s.staff;
    $('meBtn').classList.toggle('hidden', !profile || staff);
    if (profile) $('meBtn').textContent = '👤 ' + profile.name + (profile.room ? ' · ' + profile.room : '');

    // now playing
    var n = s.now;
    $('nowThumb').src = n ? JB.thumbOf(n) : 'assets/img/lotus.svg';
    $('nowLabel').textContent = !n ? 'ยังไม่มีเพลง' : (s.player.paused ? 'หยุดชั่วคราว' : 'กำลังเล่น');
    $('nowTitle').textContent = n ? n.title : 'ขอเพลงแรกได้เลย';
    $('nowBy').innerHTML = n ? who(n) + (n.mine ? ' <span class="tag" style="color:#241a05;background:var(--gold);border-radius:99px;padding:1px 8px;font-size:11px">เพลงของคุณ</span>' : '') : '';
    progress();

    // staff controls
    $('staffCtl').classList.toggle('hidden', !staff);
    if (staff) {
      $('playBtn').textContent = s.player.paused ? '▶ เล่นต่อ' : '⏸ หยุด';
      if (!volDragging) { $('vol').value = s.player.volume; $('volText').textContent = s.player.volume; }
      $('playerState').innerHTML = s.player.online ? '<span style="color:var(--ok)">● เครื่องเล่นออนไลน์</span>'
        : '<span style="color:var(--danger)">● เครื่องเล่นออฟไลน์</span> — เปิด <a href="music.html" target="_blank">music.html</a> ที่คอมกลาง';
    }

    var open = s.rules.guestRequests || staff;
    $('closed').classList.toggle('hidden', open);
    $('searchCard').classList.toggle('hidden', !open);
    var canSearch = s.rules.canSearch || s.rules.hasLibrary;
    $('q').placeholder = canSearch ? 'ค้นหาชื่อเพลง / ศิลปิน หรือวางลิงก์ YouTube' : 'วางลิงก์ YouTube ที่นี่';
    if (!results.length && !searching) {
      $('hint').innerHTML = canSearch ? 'ขอได้ครั้งละ ' + (s.rules.maxPerGuest || 'ไม่จำกัด') + ' เพลง' + (s.rules.maxMinutes ? ' · ยาวไม่เกิน ' + s.rules.maxMinutes + ' นาที' : '')
        : 'วิธีขอเพลง: เปิดแอป YouTube → เลือกเพลง → กด <b>แชร์</b> → <b>คัดลอกลิงก์</b> → กลับมาวางที่ช่องด้านบน ' +
          '<a class="btn small" href="https://m.youtube.com/" target="_blank" rel="noopener">เปิด YouTube</a>';
    }

    // queue
    $('qCount').textContent = s.queue.length ? '(' + s.queue.length + ' เพลง)' : '';
    $('queue').innerHTML = s.queue.length ? s.queue.map(function (q, i) {
      var tools = staff ? '<span class="tools">' +
        (i > 0 ? '<button class="btn icon small" data-act="top" data-id="' + q.id + '" title="เล่นถัดไป">⤒</button>' +
                 '<button class="btn icon small" data-act="up" data-id="' + q.id + '" title="เลื่อนขึ้น">▲</button>' : '') +
        '<button class="btn icon small danger" data-act="remove" data-id="' + q.id + '" title="ลบ">✕</button></span>' : '';
      return '<li class="' + (q.mine ? 'mine' : '') + '"><span class="n">' + (i + 1) + '</span>' +
        '<img src="' + JB.thumbOf(q) + '" alt="" loading="lazy">' +
        '<span class="t"><b>' + esc(q.title) + '</b><span>' + who(q) + (q.dur ? ' · ' + JB.fmt(q.dur) : '') +
        (q.mine ? '<span class="tag">ของคุณ</span>' : '') + '</span></span>' + tools + '</li>';
    }).join('') : '<li class="empty">คิวว่าง — ขอเพลงได้เลย</li>';

    var hist = (s.history || []).filter(function (h) { return h.src !== 'fallback'; }).slice(0, 5);
    $('histSec').classList.toggle('hidden', !hist.length);
    $('history').innerHTML = hist.map(function (h) {
      return '<li><img src="' + JB.thumbOf(h) + '" alt=""" loading="lazy"><span class="t"><b>' + esc(h.title) + '</b><span>' + esc(h.by || '') + '</span></span></li>';
    }).join('');

    // staff settings
    $('staffBtn').textContent = staff ? 'ออกจากโหมดพนักงาน' : 'สำหรับพนักงาน';
    $('staffSet').classList.toggle('hidden', !staff);
    if (staff && !settingsShown) renderSettings();
    if (!staff) settingsShown = false;
  }

  function progress() {
    if (!s || !s.now) { $('nowBar').style.width = '0'; return; }
    var p = s.player;
    var pos = p.id === s.now.id ? p.pos : 0;
    if (!p.paused && p.online && p.id === s.now.id) pos += (Date.now() - fetchedAt) / 1000;
    var dur = p.id === s.now.id && p.dur ? p.dur : s.now.dur;
    $('nowBar').style.width = dur ? Math.min(100, pos / dur * 100) + '%' : '0';
  }

  function renderSettings() {
    settingsShown = true;
    var c = s.settings || {};
    $('staffSet').innerHTML =
      '<h2>ตั้งค่าเครื่องเล่นเพลง</h2>' +
      '<label class="check"><input type="checkbox" id="setGuest"' + (c.guestRequests ? ' checked' : '') + '> เปิดให้ลูกค้าสแกน QR ขอเพลง</label>' +
      '<div class="grid3">' +
        '<label class="f">ขอได้คนละ (เพลงในคิว)<input type="number" min="0" max="20" id="setPer" value="' + esc(c.maxPerGuest) + '"></label>' +
        '<label class="f">ยาวไม่เกิน (นาที)<input type="number" min="0" max="600" id="setMax" value="' + esc(c.maxMinutes) + '"></label>' +
        '<label class="f">ห้ามขอซ้ำภายใน (นาที)<input type="number" min="0" max="1440" id="setRepeat" value="' + esc(c.noRepeatMinutes) + '"></label>' +
      '</div>' +
      '<p class="small-text muted" style="margin:0">ใส่ 0 = ไม่จำกัด · ข้อจำกัดใช้กับลูกค้าเท่านั้น พนักงานขอได้ทุกเพลง</p>' +
      '<label class="f">คำต้องห้ามในชื่อเพลง (คั่นด้วย ,)<input id="setBlock" value="' + esc(c.blockWords) + '" placeholder="เช่น reaction, ตลก"></label>' +
      '<h2 style="margin-top:8px">เพลงเปิดรอ (เมื่อไม่มีคนขอ)</h2>' +
      '<label class="f">ลิงก์ YouTube บรรทัดละ 1 ลิงก์ — ใส่ได้ทั้งเพลงเดี่ยว, เพลงยาว (รวมเพลง 1–3 ชม.) และเพลย์ลิสต์' +
        '<textarea rows="6" id="setFallback" placeholder="https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/playlist?list=...">' + esc(c.fallback) + '</textarea></label>' +
      '<p class="small-text muted" style="margin:0">ตอนนี้มี ' + (c.poolCount || 0) + ' เพลงจาก YouTube ในรายการเปิดรอ · เพลย์ลิสต์ต้องมี API key</p>' +
      '<label class="f">เปิดรอจาก<select id="setSource">' +
        [['both', 'YouTube + ไฟล์ในคอมกลาง'], ['local', 'ไฟล์ในคอมกลางอย่างเดียว'], ['youtube', 'YouTube อย่างเดียว']].map(function (o) {
          return '<option value="' + o[0] + '"' + (c.fallbackSource === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></label>' +
      '<p class="small-text muted" style="margin:0">ไฟล์ในคอมกลาง: ' + (c.libraryCount
        ? c.libraryCount + ' เพลง' + (c.libraryAt ? ' (อ่านล่าสุด ' + new Date(c.libraryAt * 1000).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) + ')' : '') +
          (c.playerFolder ? '' : ' — <b style="color:var(--danger)">เครื่องเล่นยังไม่ได้อนุญาตโฟลเดอร์</b> กด "เริ่มเล่นเพลง" ที่คอมกลาง')
        : 'ยังไม่ได้เลือก — ที่คอมกลางเปิด music.html แล้วกด 📁 เลือกโฟลเดอร์ MP3/MP4') + '</p>' +
      '<label class="check"><input type="checkbox" id="setShuffle"' + (c.fallbackShuffle ? ' checked' : '') + '> สุ่มลำดับเพลงเปิดรอ</label>' +
      '<label class="check"><input type="checkbox" id="setInterrupt"' + (c.interruptFallback ? ' checked' : '') + '> มีคนขอเพลง → ตัดเพลงเปิดรอทันที (แล้วกลับมาเล่นต่อจากเดิม)</label>' +
      '<h2 style="margin-top:8px">ค้นหาเพลงด้วยชื่อ (YouTube API key)</h2>' +
      '<p class="small-text muted" style="margin:0">ไม่มี key ก็ใช้ได้ (ลูกค้าวางลิงก์แทน) · มี key = ค้นหาด้วยชื่อเพลงได้ ' +
        (c.hasKey ? '— วันนี้ค้นไป ' + c.searchesToday + '/' + c.searchesMax + ' ครั้ง (ค้นซ้ำคำเดิมไม่นับ)' : '') + '</p>' +
      '<div class="search-row"><input type="password" id="setKey" autocomplete="off" placeholder="' + (c.hasKey ? 'ตั้งแล้ว ✓ — ใส่ใหม่เพื่อเปลี่ยน' : 'AIza…') + '">' +
        (c.hasKey ? '<button class="btn danger" data-act="removeKey">ลบ key</button>' : '') + '</div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:6px">' +
        '<button class="btn danger" data-act="clear">ล้างคิวทั้งหมด</button>' +
        '<a class="btn" href="music.html" target="_blank">เปิดหน้าเครื่องเล่น</a>' +
        '<button class="btn primary" data-act="saveSettings">บันทึกการตั้งค่า</button>' +
      '</div>';
  }

  /* ---------- actions ---------- */
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }

  function modal(html) {
    $('modalBox').innerHTML = html;
    $('modal').classList.remove('hidden');
    var f = $('modalBox').querySelector('input, select, button.primary');
    if (f) setTimeout(function () { f.focus(); }, 50);
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  $('modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });

  function roomOptions(sel) {
    var names = [];
    if (cfg) cfg.rooms.concat(cfg.screens).forEach(function (r) { names.push(r.name); });
    names.push('โต๊ะในร้าน');
    return '<option value="">— ไม่ระบุ —</option>' + names.map(function (n) {
      return '<option' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
  }

  function profileForm() {
    var p = profile || { name: '', room: '' };
    modal('<div class="modal-head"><h3>ชื่อที่จะแสดงบนจอ</h3></div><form class="modal-body" id="profileForm">' +
      '<label class="f">ชื่อเล่น<input id="pfName" maxlength="20" required value="' + esc(p.name) + '" placeholder="เช่น ต้น"></label>' +
      '<label class="f">นั่งที่<select id="pfRoom">' + roomOptions(p.room) + '</select></label>' +
      '<div class="actions"><button type="button" class="btn" data-act="close">ยกเลิก</button><button class="btn primary" type="submit">ตกลง</button></div></form>');
  }

  function askSong(song) {
    pending = song;
    var staff = s && s.staff;
    if (!staff && !profile) { profileForm(); return; }
    modal('<div class="modal-head"><h3>ขอเพลงนี้?</h3></div><div class="modal-body">' +
      '<div class="pick"><img src="' + JB.thumbOf(song) + '" alt=""><div><b>' + esc(song.title || 'เพลงจากลิงก์ที่วาง') + '</b>' +
      (song.dur ? '<div class="muted small-text">' + JB.fmt(song.dur) + '</div>' : '') + '</div></div>' +
      '<div class="actions"><button class="btn" data-act="close">ยกเลิก</button>' +
      (staff ? '<button class="btn" data-act="addNext">เล่นถัดไป</button>' : '') +
      '<button class="btn primary" data-act="add">ขอเพลง</button></div></div>');
  }

  function add(next) {
    var song = pending;
    if (!song) return;
    closeModal();
    var body = { dev: JB.device(), next: !!next,
      name: profile ? profile.name : '', room: profile ? profile.room : '' };
    if (song.kind === 'local') body.path = song.path;
    else body.vid = song.vid;
    JB.call('add', { json: body }).then(function (r) {
      pending = null;
      toast(r.playing ? '♪ เล่นเพลงของคุณแล้ว' : '✓ ได้คิวที่ ' + r.position);
      results = [];
      $('results').innerHTML = '';
      $('q').value = '';
      poll();
    }).catch(function (err) { toast(err.message); });
  }

  function parseVid(text) {
    var t = String(text).trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
    var m = t.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : '';
  }

  $('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('q').value.trim();
    if (!q) return;
    $('q').blur();
    if (JB.looksLikeLink(q)) {
      var vid = parseVid(q);
      if (!vid) { toast('ลิงก์นี้ไม่ใช่วิดีโอ YouTube'); return; }
      askSong({ vid: vid, title: '' });
      return;
    }
    if (!s || !(s.rules.canSearch || s.rules.hasLibrary)) { toast('ค้นหาด้วยชื่อยังไม่เปิดใช้ — วางลิงก์ YouTube แทน'); return; }
    search(q, s.rules.hasLibrary ? 'local' : 'yt');
  });

  /* the shop's own folder first (free, works without an API key), YouTube on request */
  function search(q, src) {
    searching = true;
    results = [];
    $('results').innerHTML = '<p class="muted small-text">กำลังค้นหา…</p>';
    JB.call('search', { query: 'q=' + encodeURIComponent(q) + '&dev=' + encodeURIComponent(JB.device()) + (src === 'local' ? '&src=local' : '') }).then(function (d) {
      results = d.results || [];
      if (src === 'local' && !results.length && s.rules.canSearch) { search(q, 'yt'); return; }
      searching = false;
      lastQ = q;
      $('hint').textContent = results.length ? 'ผลการค้นหา "' + q + '"' + (src === 'local' ? ' — เพลงในร้าน' : ' — YouTube') : 'ไม่พบเพลง ลองคำอื่น';
      $('results').innerHTML = results.map(function (r, i) {
        var local = r.kind === 'local';
        var sub = local ? 'เพลงในร้าน' : esc(r.channel) + ' · ' + JB.fmt(r.dur) + (r.tooLong ? ' · ยาวเกินกำหนด' : '');
        return '<div class="res' + (r.tooLong ? ' off' : '') + '"><img src="' + JB.thumbOf(r) + '" alt="" loading="lazy">' +
          '<span class="t"><b>' + esc(r.title) + '</b><span>' + sub + '</span></span>' +
          '<button class="btn primary small" data-act="pick" data-i="' + i + '"' + (r.tooLong ? ' disabled' : '') + '>ขอเพลง</button></div>';
      }).join('') + (src === 'local' && s.rules.canSearch ? '<button class="btn" data-act="searchYt">ค้นใน YouTube แทน</button>' : '');
    }).catch(function (err) { searching = false; $('results').innerHTML = ''; toast(err.message); });
  }
  var lastQ = '';

  function cmd(type, extra) {
    var body = extra || {};
    body.type = type;
    return JB.call('cmd', { json: body }).then(useState).catch(function (err) {
      toast(err.message);
      if (err.status === 401) poll();
    });
  }

  function saveSettings() {
    var body = {
      guestRequests: $('setGuest').checked,
      maxPerGuest: +$('setPer').value || 0,
      maxMinutes: +$('setMax').value || 0,
      noRepeatMinutes: +$('setRepeat').value || 0,
      blockWords: $('setBlock').value,
      fallback: $('setFallback').value,
      fallbackShuffle: $('setShuffle').checked,
      fallbackSource: $('setSource').value,
      interruptFallback: $('setInterrupt').checked
    };
    if ($('setKey').value.trim()) body.apiKey = $('setKey').value.trim();
    toast('กำลังบันทึก…');
    return JB.call('settings', { json: { settings: body } }).then(function (d) {
      useState(d);
      renderSettings();
      toast(d.warnings && d.warnings.length ? '⚠ ' + d.warnings[0] : '✓ บันทึกแล้ว');
    }).catch(function (err) { toast(err.message); });
  }

  function staffLogin() {
    modal('<div class="modal-head"><h3>เข้าสู่ระบบพนักงาน</h3></div><form class="modal-body" id="loginForm">' +
      '<label class="f">รหัสผ่าน (เดียวกับแผงควบคุม)<input type="password" id="lgPw" autocomplete="current-password" required></label>' +
      '<div class="actions"><button type="button" class="btn" data-act="close">ยกเลิก</button><button class="btn primary" type="submit">เข้าสู่ระบบ</button></div></form>');
  }

  document.addEventListener('submit', function (e) {
    if (e.target.id === 'profileForm') {
      e.preventDefault();
      var name = $('pfName').value.trim();
      if (!name) return;
      saveProfile({ name: name.slice(0, 20), room: $('pfRoom').value });
      closeModal();
      if (s) render();
      if (pending) askSong(pending);
    } else if (e.target.id === 'loginForm') {
      e.preventDefault();
      JB.login($('lgPw').value).then(function () { closeModal(); toast('✓ เข้าสู่โหมดพนักงาน'); poll(); })
        .catch(function (err) { toast(err.message); });
    }
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act, id = b.dataset.id;
    if (act === 'close') { closeModal(); pending = null; }
    else if (act === 'profile') { pending = null; profileForm(); }
    else if (act === 'pick') askSong(results[+b.dataset.i]);
    else if (act === 'searchYt') search(lastQ, 'yt');
    else if (act === 'add') add(false);
    else if (act === 'addNext') add(true);
    else if (act === 'toggle') cmd(s.player.paused ? 'play' : 'pause');
    else if (act === 'skip') cmd('skip');
    else if (act === 'remove') cmd('remove', { id: id });
    else if (act === 'top') cmd('top', { id: id });
    else if (act === 'up') cmd('up', { id: id });
    else if (act === 'clear') { if (confirm('ล้างคิวเพลงทั้งหมด?')) cmd('clear'); }
    else if (act === 'saveSettings') saveSettings();
    else if (act === 'removeKey') {
      if (confirm('ลบ YouTube API key? (ลูกค้าจะต้องวางลิงก์แทนการค้นหา)')) {
        JB.call('settings', { json: { settings: { removeKey: true } } }).then(function (d) { useState(d); renderSettings(); toast('ลบ key แล้ว'); })
          .catch(function (err) { toast(err.message); });
      }
    }
    else if (act === 'staff') {
      if (s && s.staff) { JB.setToken(''); settingsShown = false; poll(); toast('ออกจากโหมดพนักงานแล้ว'); }
      else staffLogin();
    }
  });

  $('vol').addEventListener('input', function () { volDragging = true; $('volText').textContent = this.value; });
  $('vol').addEventListener('change', function () { volDragging = false; cmd('volume', { value: +this.value }); });

  fetch(RB.CONFIG_PATH + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { cfg = RB.normalize(c); $('shop').textContent = cfg.shop.name; }).catch(function () {});

  setInterval(progress, 1000);
  poll();
})();
