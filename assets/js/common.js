/* Shared helpers for the admin panel and the TV player.
   Written in ES2017-level syntax (no optional chaining) so older Smart-TV browsers can run it. */
var RB = (function () {
  var CONFIG_PATH = 'data/config.json';

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPrice(n) {
    if (n === '' || n == null || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('th-TH');
  }

  function defaultRoom(i) {
    return { id: String(i), name: 'ห้อง ' + i, mode: 'playlist', playlist: 'pl_main', welcome: '', message: '', reload: 0 };
  }

  function defaultConfig() {
    var rooms = ['V1', 'V2', 'V3', 'V4', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map(function (id, i) {
      var r = defaultRoom(i + 1);
      r.id = id;
      r.name = id;
      return r;
    });
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      shop: { name: 'ระเบียงบัว', tagline: 'อาหาร • เครื่องดื่ม • คาราโอเกะ', logo: '', theme: { primary: '#d9a845', accent: '#e98aa6', bg: '#0e1f1a' } },
      ticker: { enabled: true, text: 'ยินดีต้อนรับสู่ระเบียงบัว • สั่งอาหารเพิ่มได้ที่ปุ่มเรียกพนักงาน', speed: 60 },
      settings: { pollSeconds: 30, showClock: true, karaokeApp: '', promoApp: 'de.ozerov.fully', idleMinutes: 10, idleIgnoreAudio: false, bridgeEnabled: false,
        maskNames: false, autoWelcome: true, dayStartHour: 6 },
      reload: 0,
      media: [],
      menu: { categories: [] },
      playlists: [{ id: 'pl_main', name: 'เพลย์ลิสต์หลัก', items: [] }],
      rooms: rooms,
      screens: [defaultScreen()],
      bookings: []
    };
  }

  /* Special screens (e.g. the entrance) use the same fields as rooms plus the 'lobby' / 'bookings' modes. */
  function defaultScreen() {
    return { id: 'lobby', name: 'ทางเข้าร้าน', mode: 'lobby', playlist: 'pl_main', welcome: '', message: '', reload: 0 };
  }

  /* Fill in any missing fields so older/hand-edited configs never crash the UI. */
  function normalize(cfg) {
    var d = defaultConfig();
    cfg = cfg || {};
    var out = {};
    for (var k in d) out[k] = cfg[k] !== undefined ? cfg[k] : d[k];
    out.shop = Object.assign({}, d.shop, cfg.shop || {});
    out.shop.theme = Object.assign({}, d.shop.theme, (cfg.shop && cfg.shop.theme) || {});
    out.ticker = Object.assign({}, d.ticker, cfg.ticker || {});
    out.settings = Object.assign({}, d.settings, cfg.settings || {});
    out.menu = { categories: (cfg.menu && cfg.menu.categories) || [] };
    out.media = Array.isArray(cfg.media) ? cfg.media : [];
    out.playlists = Array.isArray(cfg.playlists) ? cfg.playlists : d.playlists;
    out.rooms = (Array.isArray(cfg.rooms) ? cfg.rooms : d.rooms).map(function (r, i) {
      return Object.assign(defaultRoom(i + 1), r);
    });
    out.screens = (Array.isArray(cfg.screens) ? cfg.screens : d.screens).map(function (sc) {
      return Object.assign(defaultScreen(), sc);
    });
    out.bookings = Array.isArray(cfg.bookings) ? cfg.bookings : [];
    return out;
  }

  function byId(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function mediaUrl(src) {
    if (!src) return '';
    if (/^(https?:|data:|blob:)/.test(src)) return src;
    return new URL(src, document.baseURI).href;
  }

  function findRoom(cfg, id) {
    var all = cfg.rooms.concat(cfg.screens || []);
    for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
    return null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* The shop is open past midnight: before dayStartHour still counts as the previous business day. */
  function businessDate(now, startHour) {
    var d = new Date(now.getTime());
    if (d.getHours() < (startHour == null ? 6 : startHour)) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* Minutes since the start of the business day's calendar date; 01:30 becomes 25:30. */
  function bookingMinutes(time, startHour) {
    var m = /^(\d{1,2}):(\d{2})/.exec(time || '');
    if (!m) return 0;
    var h = Number(m[1]);
    if (h < (startHour == null ? 6 : startHour)) h += 24;
    return h * 60 + Number(m[2]);
  }

  function nowMinutes(now, startHour) {
    return bookingMinutes(pad2(now.getHours()) + ':' + pad2(now.getMinutes()), startHour);
  }

  function bookingsFor(cfg, date) {
    var start = cfg.settings.dayStartHour;
    return (cfg.bookings || []).filter(function (b) { return b.date === date && b.status !== 'cancelled'; })
      .sort(function (a, b) { return bookingMinutes(a.time, start) - bookingMinutes(b.time, start); });
  }

  /* "สมชาย ใจดี" -> "สมชาย ใ." when masking is on (entrance screens are public). */
  function displayName(name, mask) {
    name = String(name || '').trim();
    if (!mask) return name;
    var parts = name.split(/\s+/);
    if (parts.length < 2) return name;
    var last = parts[parts.length - 1];
    return parts.slice(0, -1).join(' ') + ' ' + last.charAt(0) + '.';
  }

  /* The booking a room should greet right now: from 60 min before until 4 h after the booked time. */
  function currentBooking(cfg, roomId, now) {
    var start = cfg.settings.dayStartHour;
    var nm = nowMinutes(now, start);
    var list = bookingsFor(cfg, businessDate(now, start)).filter(function (b) {
      var t = bookingMinutes(b.time, start);
      return String(b.room) === String(roomId) && nm >= t - 60 && nm <= t + 240;
    });
    return list.length ? list[list.length - 1] : null;
  }

  return {
    CONFIG_PATH: CONFIG_PATH, uid: uid, esc: esc, fmtPrice: fmtPrice,
    defaultConfig: defaultConfig, defaultRoom: defaultRoom, normalize: normalize,
    byId: byId, mediaUrl: mediaUrl, findRoom: findRoom, defaultScreen: defaultScreen,
    businessDate: businessDate, bookingMinutes: bookingMinutes, nowMinutes: nowMinutes,
    bookingsFor: bookingsFor, displayName: displayName, currentBooking: currentBooking
  };
})();
