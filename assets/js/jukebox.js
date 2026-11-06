/* Client for api/jukebox.php, shared by music.html (player) and request.html (guests & staff).
   The staff token is the same one admin.html stores after login (localStorage rb_srv_token). */
var JB = (function () {
  var TOKEN_KEY = 'rb_srv_token';
  var DEV_KEY = 'rb_jb_dev';

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
  }

  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  /* random id per phone, so guests can see and limit "their" songs without an account */
  function device() {
    var d = '';
    try { d = localStorage.getItem(DEV_KEY) || ''; } catch (_) {}
    if (!d) {
      d = 'd' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      try { localStorage.setItem(DEV_KEY, d); } catch (_) {}
    }
    return d;
  }

  async function call(action, opts) {
    opts = opts || {};
    var headers = {};
    var t = token();
    if (t) headers['X-Auth'] = t;
    if (opts.json) headers['Content-Type'] = 'application/json';
    var url = 'api/jukebox.php?action=' + action + (opts.query ? '&' + opts.query : '');
    var res = await fetch(url, {
      method: opts.json ? 'POST' : 'GET', headers: headers, cache: 'no-store',
      body: opts.json ? JSON.stringify(opts.json) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || data.ok === false) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      if (res.status === 401) setToken('');
      throw err;
    }
    return data;
  }

  async function login(password) {
    var res = await fetch('api/?action=login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ password: password })
    });
    var d = null;
    try { d = await res.json(); } catch (_) {}
    if (!res.ok || !d || !d.token) throw new Error((d && d.error) || ('HTTP ' + res.status));
    setToken(d.token);
  }

  function thumb(vid) { return 'https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/mqdefault.jpg'; }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function looksLikeLink(s) {
    return /youtu\.?be|^[A-Za-z0-9_-]{11}$/.test(String(s).trim());
  }

  function requestUrl() {
    return location.href.replace(/[^/]*([?#].*)?$/, '') + 'request.html';
  }

  return { token: token, setToken: setToken, device: device, call: call, login: login,
    thumb: thumb, fmt: fmt, looksLikeLink: looksLikeLink, requestUrl: requestUrl };
})();
