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
    var rooms = [];
    for (var i = 1; i <= 10; i++) rooms.push(defaultRoom(i));
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      shop: { name: 'ระเบียงบัว', tagline: 'อาหาร • เครื่องดื่ม • คาราโอเกะ', logo: '', theme: { primary: '#d9a845', accent: '#e98aa6', bg: '#0e1f1a' } },
      ticker: { enabled: true, text: 'ยินดีต้อนรับสู่ระเบียงบัว • สั่งอาหารเพิ่มได้ที่ปุ่มเรียกพนักงาน', speed: 60 },
      settings: { pollSeconds: 30, showClock: true },
      reload: 0,
      media: [],
      menu: { categories: [] },
      playlists: [{ id: 'pl_main', name: 'เพลย์ลิสต์หลัก', items: [] }],
      rooms: rooms
    };
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
    for (var i = 0; i < cfg.rooms.length; i++) if (String(cfg.rooms[i].id) === String(id)) return cfg.rooms[i];
    return null;
  }

  return {
    CONFIG_PATH: CONFIG_PATH, uid: uid, esc: esc, fmtPrice: fmtPrice,
    defaultConfig: defaultConfig, defaultRoom: defaultRoom, normalize: normalize,
    byId: byId, mediaUrl: mediaUrl, findRoom: findRoom
  };
})();
