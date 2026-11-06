/* Background-music player for the shop PC: follows the queue in api/jukebox.php.
   Two engines:
   - YouTube songs play in the official embedded player (kept visible, as YouTube's API terms require).
   - Local songs (MP3/MP4 in a folder on this PC, picked with the File System Access API) play from the
     disk with a <video> element. Only their file names are sent to the server, so guests can search them.
   When the internet is down the player keeps going with random songs from the local folder. */
(function () {
  'use strict';

  var POLL_MS = 3000;
  var MEDIA_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm)$/i;
  var VIDEO_RE = /\.(mp4|m4v|webm)$/i;
  var $ = function (id) { return document.getElementById(id); };
  var esc = RB.esc;
  var vid = $('local');

  var yt = null;            // YT.Player
  var ytReady = false;
  var unlocked = false;     // browser allowed sound (user clicked once)
  var cur = null;           // item currently loaded
  var loadAt = 0;           // when cur was loaded (stall detection)
  var playingSeen = false;  // cur actually started playing
  var last = null;          // last state from the server
  var lastAdvance = 0;
  var knownQueue = null;    // queue ids seen before, to announce new requests
  var appliedVol = -1;
  var busy = false;
  var timer = null;
  var fails = 0;            // consecutive failed server calls
  var objUrl = '';

  // local folder
  var dir = null;           // FileSystemDirectoryHandle
  var dirOk = false;        // read permission granted
  var files = {};           // relative path -> FileSystemFileHandle
  var songs = [];           // [{p, t}]
  var libHash = '';
  var libSent = '';
  var libErr = '';          // last error sending the song list
  var libRetryAt = 0;
  var scanning = false;
  var offlineRecent = [];

  /* ---------- gate (login / click-to-start) ---------- */
  function gate(kind, text) {
    $('gate').classList.toggle('hidden', !kind);
    $('loginForm').classList.toggle('hidden', kind !== 'login');
    $('startBtn').classList.toggle('hidden', kind !== 'start');
    $('gateDir').classList.toggle('hidden', kind !== 'start');
    $('gateText').textContent = text || '';
    $('gateErr').textContent = '';
    dirInfo();
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
    // asking again is instant when Chrome already remembers "allow on every visit"
    if (dir && !dirOk) {
      dir.requestPermission({ mode: 'read' }).then(function (p) { if (p === 'granted') { dirOk = true; scan(); } }).catch(function () {});
    }
    resume();
    tick();
  });

  // the remote opens in its own tab so this tab keeps playing; the same tab is reused on every click
  function openRemote() { window.open('request.html', 'rb-remote'); }
  $('remoteBtn').addEventListener('click', openRemote);

  // typing another address in this tab would stop the music: ask first once playback has started
  window.addEventListener('beforeunload', function (e) {
    if (unlocked && cur) { e.preventDefault(); e.returnValue = ''; }
  });

  $('gateDir').addEventListener('click', pickDir);
  $('dirBtn').addEventListener('click', pickDir);

  /* ---------- local folder ---------- */
  function canPick() { return 'showDirectoryPicker' in window; }

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open('rb-music', 1);
      open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var tx = open.result.transaction('kv', mode);
        var req = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }

  function pickDir() {
    if (!canPick()) {
      toast('เบราว์เซอร์นี้เปิดโฟลเดอร์เพลงไม่ได้ — ใช้ Google Chrome หรือ Microsoft Edge บนคอมพิวเตอร์', 12000);
      return;
    }
    window.showDirectoryPicker({ id: 'rb-music', mode: 'read' }).then(function (h) {
      dir = h;
      dirOk = true;
      idb('readwrite', function (s) { return s.put(h, 'dir'); }).catch(function () {});
      scan();
    }).catch(function (err) {
      // Chrome refuses whole drives, Desktop, Downloads and system folders, and then reports a plain cancel
      if (err && err.name === 'AbortError') toast('ยังไม่ได้เลือกโฟลเดอร์ — ถ้า Chrome แจ้งว่า "มีไฟล์ระบบ" ให้ย้ายเพลงไปไว้ในโฟลเดอร์ย่อย เช่น D:\\เพลง แล้วเลือกโฟลเดอร์นั้น (เลือกทั้งไดรฟ์, Desktop, Downloads ไม่ได้)', 15000);
      else toast('เปิดโฟลเดอร์ไม่ได้: ' + (err && err.message), 12000);
    });
  }

  function restoreDir() {
    if (!canPick()) return Promise.resolve();
    return idb('readonly', function (s) { return s.get('dir'); }).then(function (h) {
      if (!h) return;
      dir = h;
      return h.queryPermission({ mode: 'read' }).then(function (p) { if (p === 'granted') { dirOk = true; return scan(); } });
    }).catch(function () {});
  }

  async function walk(handle, prefix, depth, outFiles, outSongs) {
    for await (var entry of handle.values()) {
      if (entry.name.charAt(0) === '.' || entry.name.charAt(0) === '$') continue;
      var rel = prefix + entry.name;
      if (entry.kind === 'directory') {
        if (depth < 8) await walk(entry, rel + '/', depth + 1, outFiles, outSongs);
      } else if (MEDIA_RE.test(entry.name)) {
        outFiles[rel] = entry;
        outSongs.push({ p: rel, t: titleOf(entry.name) });
      }
    }
  }

  // display/search title from a file name: drop extensions and downloader junk such as
  // "onlymp3.to - " or "-<youtube id>-192k-<timestamp>"
  function titleOf(name) {
    var t = name.replace(/\.[^.]+$/, '').replace(/\.(mp3|mp4|m4a|wav)$/i, '')
      .replace(/^onlymp3\.to\s*-\s*/i, '')
      .replace(/-[A-Za-z0-9_-]{11}-\d{2,3}k-\d{9,}$/, '')
      .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return t || name;
  }

  function hashOf(list) {
    var h = 5381;
    var s = list.map(function (x) { return x.p; }).join('\n');
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + 'n' + list.length.toString(36);
  }

  async function scan() {
    if (!dir || !dirOk || scanning) return;
    scanning = true;
    dirInfo('กำลังอ่านโฟลเดอร์…');
    try {
      var f = {}, list = [];
      await walk(dir, '', 0, f, list);
      list.sort(function (a, b) { return a.p.localeCompare(b.p, 'th'); });
      files = f;
      songs = list;
      libHash = hashOf(list);
      libErr = '';
      libRetryAt = 0;
      if (!list.length) toast('ไม่พบไฟล์ MP3/MP4 ในโฟลเดอร์ "' + dir.name + '" (รวมโฟลเดอร์ย่อยแล้ว)', 12000);
      else toast('พบ ' + list.length + ' เพลงในโฟลเดอร์ "' + dir.name + '"');
    } catch (err) {
      toast('อ่านโฟลเดอร์ไม่ได้: ' + err.message, 12000);
      dirOk = false;
    }
    scanning = false;
    dirInfo();
    if (last && last.settings) syncLibrary(last.settings);
  }

  /* send the list of file names when it differs from what the server has */
  function syncLibrary(set) {
    if (!dirOk || scanning || !libHash || set.libraryHash === libHash || libSent === libHash || Date.now() < libRetryAt) return;
    libSent = libHash;
    dirInfo('กำลังส่งรายชื่อเพลง…');
    JB.call('library', { json: { hash: libHash, songs: songs } })
      .then(function (r) {
        libErr = '';
        dirInfo();
        toast('ส่งรายชื่อเพลงขึ้นระบบแล้ว ' + r.count + ' เพลง — ลูกค้าค้นเพลงในร้านได้แล้ว');
      })
      .catch(function (err) {
        libSent = '';
        libErr = (err && err.message) || 'error';
        libRetryAt = Date.now() + 60000;
        dirInfo();
        toast('ส่งรายชื่อเพลงไม่สำเร็จ: ' + libErr + ' — จะลองใหม่ใน 1 นาที', 12000);
      });
  }

  function dirInfo(msg) {
    var pickable = canPick();
    $('dirBtn').classList.remove('hidden');
    $('dirInfo').textContent = msg || (!pickable ? 'ใช้ Chrome/Edge' : dir ? (dirOk ? songs.length + ' เพลง' + (libErr ? ' · ส่งไม่สำเร็จ' : '') : 'รออนุญาต') : 'โฟลเดอร์เพลง');
    $('gateDirInfo').textContent = !pickable ? 'เบราว์เซอร์นี้เปิดเพลงในเครื่องไม่ได้ — ใช้ Chrome หรือ Edge' : msg || (dir
      ? 'โฟลเดอร์ "' + dir.name + '"' + (dirOk ? ' · ' + songs.length + ' เพลง' : ' — กดเริ่มแล้วเลือก "อนุญาตทุกครั้ง"')
      : 'ไม่บังคับ — ใช้เปิดเพลงจากเครื่องนี้ได้ แม้เน็ตหลุด');
  }

  /* ---------- YouTube engine ---------- */
  window.onYouTubeIframeAPIReady = function () {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0 },
      events: {
        onReady: function () {
          ytReady = true;
          appliedVol = -1;
          if (cur && cur.kind !== 'local') { var c = cur; cur = null; load(c, c.start || 0); }
          if (last) apply(last);
        },
        onStateChange: function (e) {
          if (!cur || cur.kind === 'local') return;
          if (e.data === YT.PlayerState.PLAYING) {
            playingSeen = true;
            if (paused()) yt.pauseVideo();
          }
          if (e.data === YT.PlayerState.ENDED) finished();
        },
        onError: function (e) {
          // 101/150: owner blocks embedding, 100: removed/private, 2: bad id, 5: html5 error
          if (cur && cur.kind !== 'local') failed(e.data || 1);
        }
      }
    });
  };

  function loadScript() {
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = function () { s.remove(); setTimeout(loadScript, 15000); };
    document.head.appendChild(s);
  }

  function ytPlaying() { return ytReady && yt.getPlayerState() === YT.PlayerState.PLAYING; }

  /* ---------- local engine ---------- */
  vid.addEventListener('playing', function () { if (cur && cur.kind === 'local') playingSeen = true; });
  vid.addEventListener('ended', function () { if (cur && cur.kind === 'local') finished(); });
  vid.addEventListener('error', function () {
    if (cur && cur.kind === 'local' && vid.getAttribute('src')) failed(vid.error ? 900 + vid.error.code : 900);
  });
  vid.addEventListener('loadedmetadata', function () {
    if (!cur || cur.kind !== 'local') return;
    $('art').classList.toggle('hidden', VIDEO_RE.test(cur.path) && vid.videoWidth > 0);
    var s = cur.start || 0;
    if (s > 0 && s < vid.duration - 5) vid.currentTime = s;
  });

  function playLocal(item) {
    var h = files[item.path];
    if (!h) {
      // renamed/removed since the last scan, or the folder is not allowed yet
      if (dirOk) scan();
      setTimeout(function () { if (cur === item) failed(404); }, 1500);
      return;
    }
    h.getFile().then(function (file) {
      if (cur !== item) return;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(file);
      vid.src = objUrl;
      vid.volume = volume() / 100;
      if (unlocked && !paused()) vid.play().catch(function () {});
    }).catch(function () { if (cur === item) failed(404); });
  }

  function stopLocal() {
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = ''; }
    $('art').classList.add('hidden');
  }

  /* ---------- both engines ---------- */
  function paused() { return !!(last && last.player.paused && !(cur && cur.src === 'offline')); }
  function volume() { return last ? last.player.volume : 80; }

  function load(item, startAt) {
    var local = item.kind === 'local';
    if (cur && cur.kind === 'local') stopLocal();
    else if (ytReady && cur) yt.stopVideo();
    cur = item;
    cur.start = startAt || 0;
    loadAt = Date.now();
    playingSeen = false;
    $('stage').classList.toggle('is-local', local);
    $('artTitle').textContent = local ? item.title : '';
    if (local) {
      $('art').classList.remove('hidden');
      playLocal(item);
      return;
    }
    if (!ytReady) return; // onReady loads it
    yt.loadVideoById({ videoId: item.vid, startSeconds: startAt || 0 });
    if (paused()) setTimeout(function () { yt.pauseVideo(); }, 800);
  }

  function stopAll() {
    if (cur && cur.kind === 'local') stopLocal();
    else if (ytReady && cur) yt.stopVideo();
    cur = null;
    $('stage').classList.remove('is-local');
  }

  function resume() {
    if (!cur || paused()) return;
    if (cur.kind === 'local') { if (vid.getAttribute('src')) vid.play().catch(function () {}); }
    else if (ytReady) yt.playVideo();
  }

  function position() {
    if (!cur) return { pos: 0, dur: 0 };
    if (cur.kind === 'local') return { pos: vid.currentTime || 0, dur: isFinite(vid.duration) ? vid.duration : 0 };
    if (ytReady && yt.getCurrentTime) return { pos: yt.getCurrentTime() || 0, dur: yt.getDuration() || 0 };
    return { pos: 0, dur: 0 };
  }

  function finished() {
    var item = cur;
    if (item.kind === 'local') offlineRecent.unshift(item.path);
    if (item.src === 'offline') { stopAll(); offlineNext(); return; }
    advance(item.id, 0);
  }

  function failed(code) {
    var item = cur;
    toast('ข้ามเพลง: ' + item.title + ' (เปิดไม่ได้)');
    setTimeout(function () {
      if (cur !== item) return;
      if (item.src === 'offline') { stopAll(); offlineNext(); } else advance(item.id, code);
    }, 1500);
  }

  /* ---------- offline: keep the music going from the local folder ---------- */
  function offline() { return fails >= 2; }

  function offlineNext() {
    if (!offline() || !songs.length || !unlocked) { render(last); tick(); return; }
    var pick = null;
    for (var i = 0; i < 30 && !pick; i++) {
      var c = songs[Math.floor(Math.random() * songs.length)];
      if (offlineRecent.indexOf(c.p) < 0 || songs.length < 3) pick = c;
    }
    pick = pick || songs[0];
    offlineRecent.unshift(pick.p);
    offlineRecent = offlineRecent.slice(0, Math.min(30, Math.floor(songs.length / 2)));
    load({ id: 'off' + Date.now(), kind: 'local', path: pick.p, vid: '', title: pick.t, src: 'offline', by: '' }, 0);
    render(last);
  }

  function checkOffline() {
    if (!offline() || !songs.length || !unlocked) return;
    if (cur && cur.src === 'offline') return;
    if (cur && last && last.player.paused) return; // staff paused the music
    // a YouTube song may still play from its buffer, a local one from the disk: switch when it stops
    if (cur && cur.kind !== 'local' && ytPlaying()) return;
    if (cur && cur.kind === 'local' && !vid.paused && !vid.ended) return;
    stopAll();
    toast('อินเทอร์เน็ตหลุด — เปิดเพลงจากเครื่องแทน');
    offlineNext();
  }

  /* ---------- server sync ---------- */
  function playerInfo() {
    var p = position();
    return {
      id: cur && cur.src !== 'offline' ? cur.id : '', pos: Math.floor(p.pos), dur: Math.floor(p.dur),
      local: dirOk && songs.length > 0
    };
  }

  function advance(fromId, error) {
    lastAdvance = Date.now();
    return JB.call('advance', { json: { from: fromId || '', error: error || 0 } }).then(ok).catch(onErr);
  }

  function tick() {
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS);
    if (busy) return;
    if (!JB.token()) { gate('login', 'เครื่องนี้ใช้เปิดเพลงหลักของร้าน — เข้าสู่ระบบด้วยรหัสผ่านเดียวกับแผงควบคุม (ทำครั้งเดียว)'); return; }
    if (!unlocked && $('gate').classList.contains('hidden')) gate('start', 'กดปุ่มเพื่อเริ่มเปิดเพลง');
    busy = true;
    JB.call('report', { json: playerInfo() }).then(ok).catch(onErr).then(function () { busy = false; });
  }

  function ok(s) {
    fails = 0;
    apply(s);
  }

  function onErr(err) {
    if (err.status === 401 || err.status === 403) { gate('login', 'กรุณาเข้าสู่ระบบใหม่'); return; }
    fails++;
    if (err.status === 404) status('ไม่พบ api/jukebox.php บน Host', true);
    else status(songs.length ? 'ออฟไลน์ — เปิดเพลงจากเครื่อง' : 'ออฟไลน์ — กำลังลองใหม่', true);
    checkOffline();
  }

  function apply(s) {
    last = s;
    if (s.settings) syncLibrary(s.settings);
    if (cur && cur.src === 'offline') {
      // back online: let the local song finish, then pick up the queue
      status('', false);
      render(s);
      return;
    }
    status(s.now && cur && s.now.id === cur.id && playingSeen ? '' : (s.now ? 'กำลังโหลดเพลง…' : ''), false);
    if (!s.now) {
      if (cur) stopAll();
      if ((s.queue.length || s.rules.hasFallback) && Date.now() - lastAdvance > 15000) advance('', 0);
    } else if (!cur || s.now.id !== cur.id) {
      var start = s.now.start || 0;
      if (s.player.id === s.now.id && s.player.pos > 5) start = s.player.pos; // page reloaded mid-song
      load(s.now, start);
    } else if (cur.kind === 'local') {
      if (s.player.paused && !vid.paused) vid.pause();
      if (!s.player.paused && unlocked && vid.paused && vid.getAttribute('src') && !vid.ended) vid.play().catch(function () {});
      if (!playingSeen && unlocked && !s.player.paused && Date.now() - loadAt > 15000) { toast('ข้ามเพลงที่เปิดไม่ขึ้น'); advance(cur.id, 998); }
    } else if (ytReady) {
      var st = yt.getPlayerState();
      if (s.player.paused && st === YT.PlayerState.PLAYING) yt.pauseVideo();
      if (!s.player.paused && unlocked && (st === YT.PlayerState.PAUSED || st === YT.PlayerState.CUED)) yt.playVideo();
      // stuck loading (no network, region block without an error event): move on.
      // Wait 90 s, not less: YouTube may show ads before the song and those must not count as a stall.
      if (!playingSeen && unlocked && !s.player.paused && Date.now() - loadAt > 90000) { toast('ข้ามเพลงที่โหลดไม่ขึ้น'); advance(cur.id, 999); }
    }
    if (s.player.volume !== appliedVol) {
      vid.volume = s.player.volume / 100;
      if (ytReady) yt.setVolume(s.player.volume);
      appliedVol = ytReady ? s.player.volume : -1;
    }
    render(s);
  }

  /* ---------- view ---------- */
  function who(it) {
    if (!it) return '';
    if (it.src === 'offline') return 'เพลงในเครื่อง (ออฟไลน์)';
    if (it.src === 'fallback') return it.kind === 'local' ? 'เพลงเปิดรอ · ในเครื่อง' : 'เพลงเปิดรอ';
    return 'ขอโดย <b>' + esc(it.by || 'ลูกค้า') + '</b>' + (it.room ? ' · ' + esc(it.room) : '');
  }

  function render(s) {
    var now = cur && cur.src === 'offline' ? cur : s && s.now;
    var isPaused = now && now.src !== 'offline' && s && s.player.paused;
    $('idle').classList.toggle('hidden', !!now);
    $('nowLabel').textContent = now ? (isPaused ? 'หยุดชั่วคราว' : 'กำลังเล่น') : 'ว่าง';
    $('nowTitle').textContent = now ? now.title : 'ยังไม่มีเพลง';
    $('nowBy').innerHTML = who(now);
    if (!s) return;

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
        '<img src="' + JB.thumbOf(q) + '" alt="" loading="lazy">' +
        '<span class="t"><b>' + esc(q.title) + '</b><span>' + who(q).replace(/<\/?b>/g, '') + '</span></span></li>';
    }).join('') + (s.queue.length > max ? '<li class="more">และอีก ' + (s.queue.length - max) + ' เพลง</li>' : '')
      : '<li class="empty">' + (s.rules.hasFallback ? 'ระหว่างนี้เปิดเพลงรอไปก่อน' : 'คิวว่าง') + ' — สแกน QR เพื่อขอเพลง</li>';

    // recently played fills the space left under a short queue
    var room = Math.min(4, max - Math.min(s.queue.length, max));
    var played = (s.history || []).slice(0, room);
    $('playedHead').classList.toggle('hidden', !played.length);
    $('played').innerHTML = played.map(function (h) {
      return '<li><span class="n">✓</span><img src="' + JB.thumbOf(h) + '" alt="" loading="lazy">' +
        '<span class="t"><b>' + esc(h.title) + '</b><span>' + who(h).replace(/<\/?b>/g, '') + '</span></span></li>';
    }).join('');
  }

  function progress() {
    var p = position();
    $('tPos').textContent = JB.fmt(p.pos);
    $('tDur').textContent = JB.fmt(p.dur);
    $('bar').style.width = p.dur ? Math.min(100, p.pos / p.dur * 100) + '%' : '0';
  }

  var toastT = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('long', msg.length > 60);
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, ms || 5000);
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
    if (e.key === 'r' || e.key === 'R') openRemote();
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

  // cache the page itself so it still opens when the internet is down
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});

  fetch(RB.CONFIG_PATH + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { if (c && c.shop && c.shop.name) $('shop').textContent = c.shop.name; }).catch(function () {});

  // pick up files added to the folder while the shop is open
  setInterval(function () { if (dirOk && !offline()) scan(); }, 30 * 60 * 1000);

  drawQr();
  clock();
  dirInfo();
  setInterval(clock, 10000);
  setInterval(progress, 1000);
  loadScript();
  restoreDir().then(tick);
})();
