/* Admin panel: edits data/config.json + media/ and commits them to GitHub in one go. */
const $ = (s, el = document) => el.querySelector(s);
const { esc, uid } = RB;

const state = {
  cfg: null,
  tab: 'rooms',
  dirty: false,
  store: null,
  canPush: false,
  remoteUpdatedAt: null,
  pending: new Map(),   // repo path -> { base64 }   (new uploads not yet committed)
  localUrls: new Map(), // repo path -> blob: URL     (instant previews, kept for the session)
  deletes: new Set(),   // repo paths to remove on next save
  plSel: null,
  bkDate: null,
  busy: false
};

const MODES = [
  { id: 'karaoke', label: 'คาราโอเกะ' },
  { id: 'auto', label: 'อัตโนมัติ' },
  { id: 'playlist', label: 'เล่นสื่อ' },
  { id: 'message', label: 'ข้อความ' },
  { id: 'logo', label: 'โลโก้' },
  { id: 'off', label: 'ปิดจอ' }
];
const SCREEN_MODES = [
  { id: 'lobby', label: 'จอง+สไลด์' },
  { id: 'bookings', label: 'รายการจอง' },
  { id: 'playlist', label: 'เล่นสื่อ' },
  { id: 'message', label: 'ข้อความ' },
  { id: 'logo', label: 'โลโก้' },
  { id: 'off', label: 'ปิดจอ' }
];
const BK_STATUS = [
  { id: 'booked', label: 'จองแล้ว' },
  { id: 'arrived', label: 'มาแล้ว' },
  { id: 'cancelled', label: 'ยกเลิก' }
];
const NOTE_TPL = ['สุขสันต์วันเกิด', 'ครบรอบแต่งงาน', 'เลี้ยงบริษัท', 'เลี้ยงรุ่น', 'VIP'];
const MSG_TEMPLATES = ['เหลือเวลาอีก 15 นาที', 'หมดเวลาใช้บริการแล้ว\nกรุณาติดต่อพนักงาน', 'ห้องนี้ถูกจองแล้ว', 'ขอบคุณที่ใช้บริการ\nแล้วพบกันใหม่'];
const TAGS = ['แนะนำ', 'ขายดี', 'ใหม่', 'เผ็ด', 'โปรฯ'];
const TYPE_LABEL = { image: 'รูปภาพ', video: 'วิดีโอ', menu: 'เมนูอาหาร', promo: 'โปรโมชั่น' };

const ICONS = {
  up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8z M4 16V4h12', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  tv: 'M3 5h18v12H3z M8 21h8 M12 17v4', refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  plus: 'M12 5v14 M5 12h14', upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16', link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'
};
const icon = n => `<svg viewBox="0 0 24 24"><path d="${ICONS[n]}"/></svg>`;

/* ---------- GitHub connection ---------- */
function ghDefaults() {
  const h = location.hostname;
  if (h.endsWith('.github.io')) {
    return { owner: h.split('.')[0], repo: location.pathname.split('/').filter(Boolean)[0] || '', branch: 'main', token: '' };
  }
  return { owner: 'patpon', repo: 'WebAppcontrolTV', branch: 'main', token: '' };
}
function ghLoad() {
  try { return { ...ghDefaults(), ...JSON.parse(localStorage.getItem('rb_gh') || '{}') }; } catch (_) { return ghDefaults(); }
}
function ghSave(v) { localStorage.setItem('rb_gh', JSON.stringify(v)); }

function setConn(kind, text) {
  $('#conn').className = 'conn ' + kind;
  $('#connText').textContent = text;
}

async function connect() {
  const gh = ghLoad();
  state.store = null;
  state.canPush = false;
  if (!gh.token) { setConn('warn', 'ยังไม่เชื่อม GitHub (ดูอย่างเดียว)'); return null; }
  try {
    state.store = new GitHubStore(gh);
    const info = await state.store.check();
    state.canPush = info.canPush;
    setConn(info.canPush ? 'ok' : 'warn', info.canPush ? `เชื่อมแล้ว · ${gh.owner}/${gh.repo}` : 'Token ไม่มีสิทธิ์เขียน');
    try { return JSON.parse(await state.store.readText(RB.CONFIG_PATH)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  } catch (e) {
    setConn('err', 'เชื่อมต่อไม่ได้: ' + e.message);
    state.store = null;
    return null;
  }
}

async function init() {
  let raw = await connect();
  if (!raw) {
    try {
      const r = await fetch(RB.CONFIG_PATH + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) raw = await r.json();
    } catch (_) {}
  }
  state.cfg = RB.normalize(raw);
  state.remoteUpdatedAt = raw ? raw.updatedAt : null;
  state.plSel = state.cfg.playlists[0] ? state.cfg.playlists[0].id : null;
  render();
  writeDraft();
}

/* ---------- state helpers ---------- */
function setPath(obj, path, val) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = val;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

let draftTimer;
function markDirty() {
  state.dirty = true;
  updateSaveBtn();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 300);
}
function updateSaveBtn() {
  const b = $('#saveBtn');
  b.disabled = !state.dirty;
  b.classList.toggle('dirty', state.dirty);
  $('#brandName').textContent = state.cfg ? state.cfg.shop.name : 'ระเบียงบัว';
}

/* tv.html?draft=1 reads this so staff can preview before publishing. Pending uploads use blob: URLs. */
function writeDraft() {
  if (!state.cfg) return;
  const c = JSON.parse(JSON.stringify(state.cfg));
  c.media.forEach(m => { if (state.localUrls.has(m.src)) m.src = state.localUrls.get(m.src); });
  try { localStorage.setItem('rb_draft', JSON.stringify(c)); } catch (_) {}
}

function mediaSrc(m) { return state.localUrls.get(m.src) || RB.mediaUrl(m.src); }
function media(id) { return RB.byId(state.cfg.media, id); }

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), ms);
}
function progress(msg) {
  $('#progress').classList.toggle('hidden', !msg);
  $('#progressText').textContent = msg || '';
}

function tvUrl(roomId, extra = '') {
  return new URL(`tv.html?room=${encodeURIComponent(roomId)}${extra}`, location.href).href;
}

function fmtSec(s) {
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)} นาที ${s % 60 ? (s % 60) + ' วิ' : ''}` : `${s} วิ`;
}
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }

/* ---------- rendering ---------- */
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const views = { rooms: viewRooms, bookings: viewBookings, playlists: viewPlaylists, menu: viewMenu, media: viewMedia, settings: viewSettings };
  $('#view').innerHTML = (state.store && state.canPush ? '' : connectBanner()) + views[state.tab]();
  updateSaveBtn();
}

function connectBanner() {
  return `<div class="banner"><b>โหมดดูอย่างเดียว</b><span class="muted">แก้ไขได้ แต่ต้องเชื่อม GitHub Token ก่อนจึงจะ “บันทึก & ส่งขึ้นจอ” ได้</span>
    <button class="btn small" data-act="tab" data-tab="settings">ไปตั้งค่าการเชื่อมต่อ</button></div>`;
}

function plOptions(sel) {
  return state.cfg.playlists.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

/* Rooms */
function viewRooms() {
  const c = state.cfg;
  return `
  <div class="page-head">
    <div><h1>ห้องคาราโอเกะ (${c.rooms.length} ห้อง)</h1><p>เลือกสิ่งที่จะแสดงบนจอแต่ละห้อง แล้วกด “บันทึก &amp; ส่งขึ้นจอ”</p></div>
    <div class="card bulk">ทุกห้อง:
      <select id="bulkPl">${plOptions(c.playlists[0] && c.playlists[0].id)}</select>
      <button class="btn small" data-act="bulkPlaylist">ใช้เพลย์ลิสต์นี้</button>
      ${c.settings.bridgeEnabled ? `<button class="btn small" data-act="bulkMode" data-mode="karaoke">คาราโอเกะ</button>
      <button class="btn small" data-act="bulkMode" data-mode="auto">อัตโนมัติ</button>` : ''}
      <button class="btn small" data-act="bulkMode" data-mode="logo">โลโก้</button>
      <button class="btn small" data-act="bulkMode" data-mode="off">ปิดจอ</button>
    </div>
  </div>
  <div class="rooms-grid">${c.rooms.map((r, i) => roomCard(r, i, 'rooms')).join('')}</div>`;
}

// karaoke/auto drive the room's karaoke box over ADB — hidden unless the shop opts in to the bridge
function roomModes(r) {
  const bridge = state.cfg.settings.bridgeEnabled;
  return MODES.filter(m => bridge || (m.id !== 'karaoke' && m.id !== 'auto') || m.id === r.mode);
}

function todayBookings(roomId) {
  const c = state.cfg;
  return RB.bookingsFor(c, RB.businessDate(new Date(), c.settings.dayStartHour)).filter(b => String(b.room) === String(roomId));
}

/* coll = 'rooms' (karaoke rooms) or 'screens' (entrance / special screens) */
function roomCard(r, i, coll) {
  const p = `${coll}.${i}`;
  const at = `data-coll="${coll}" data-i="${i}"`;
  const modes = coll === 'screens' ? SCREEN_MODES : roomModes(r);
  let body = '';
  if (r.mode === 'playlist' || r.mode === 'auto' || r.mode === 'lobby') {
    body = (r.mode === 'auto'
      ? `<p class="muted small-text" style="margin:0">ไม่มีคนกดรีโมต ${esc(state.cfg.settings.idleMinutes)} นาที → แสดงโปรโมท · กดรีโมตปุ่มไหนก็ได้ → กลับแอปคาราโอเกะ</p>`
      : r.mode === 'lobby' ? `<p class="muted small-text" style="margin:0">ซ้าย: รายการจองวันนี้ · ขวา: สไลด์จากเพลย์ลิสต์</p>` : '') + `
      <label class="f">เพลย์ลิสต์<select data-path="${p}.playlist">${plOptions(r.playlist)}</select></label>
      <label class="f">ข้อความต้อนรับ (เด้งขึ้นทุก 1 นาที)
        <input data-path="${p}.welcome" value="${esc(r.welcome)}" placeholder="เช่น สุขสันต์วันเกิดคุณเอ"></label>`;
  } else if (r.mode === 'message') {
    body = `
      <label class="f">ข้อความเต็มจอ<textarea rows="3" data-path="${p}.message" placeholder="พิมพ์ข้อความ">${esc(r.message)}</textarea></label>
      <div class="chips">${MSG_TEMPLATES.map((t, k) => `<button class="chip" data-act="msgTpl" ${at} data-k="${k}">${esc(t.replace('\n', ' '))}</button>`).join('')}</div>`;
  } else if (r.mode === 'bookings') {
    body = `<p class="muted small-text">แสดงรายการจองวันนี้เต็มจอ (แก้ในตารางด้านบน)</p>`;
  } else if (r.mode === 'karaoke') {
    body = `<p class="muted small-text">เปิดแอปคาราโอเกะบนกล่อง (ลูกค้ากำลังใช้ห้อง)</p>`;
  } else if (r.mode === 'logo') {
    body = `<p class="muted small-text">แสดงโลโก้ร้านเต็มจอ (เหมาะตอนห้องว่าง)</p>`;
  } else {
    body = `<p class="muted small-text">จอดำ</p>`;
  }
  const bks = coll === 'rooms' ? todayBookings(r.id) : [];
  const bkLine = bks.length
    ? `<div class="bk-line">จองวันนี้: ${bks.map(b => `${esc(b.time)} ${esc(b.name)}${b.guests ? ` (${esc(b.guests)})` : ''}`).join(', ')}</div>` : '';
  return `
  <article class="card room mode-${r.mode}">
    <div class="room-top"><input class="room-name" data-path="${p}.name" value="${esc(r.name)}" aria-label="ชื่อห้อง"></div>
    ${bkLine}
    <div class="seg">${modes.map(m => `<button class="${r.mode === m.id ? 'on' : ''}" data-act="setMode" ${at} data-mode="${m.id}">${m.label}</button>`).join('')}</div>
    ${body}
    <div class="room-actions">
      <a class="btn small" href="${esc(tvUrl(r.id))}" target="_blank" rel="noopener">${icon('tv')} จอจริง</a>
      <a class="btn small" href="${esc(tvUrl(r.id, '&draft=1'))}" target="_blank" rel="noopener">${icon('eye')} ตัวอย่าง</a>
      <button class="btn small" data-act="reloadRoom" ${at} title="สั่งให้จอนี้โหลดหน้าใหม่">${icon('refresh')} รีโหลดจอ</button>
      ${coll === 'screens' ? `<button class="btn icon small danger" data-act="delScreen" data-i="${i}" title="ลบจอนี้">${icon('trash')}</button>` : ''}
    </div>
  </article>`;
}

/* Bookings + special screens */
function viewBookings() {
  const c = state.cfg, h = c.settings.dayStartHour;
  const date = state.bkDate || (state.bkDate = RB.businessDate(new Date(), h));
  const list = c.bookings.map((b, i) => ({ b, i })).filter(x => x.b.date === date)
    .sort((x, y) => RB.bookingMinutes(x.b.time, h) - RB.bookingMinutes(y.b.time, h));
  const active = list.filter(x => x.b.status !== 'cancelled');
  const guests = active.reduce((n, x) => n + (Number(x.b.guests) || 0), 0);
  const roomOpts = sel => '<option value="">— ไม่ระบุห้อง —</option>' +
    c.rooms.map(r => `<option value="${esc(r.id)}" ${String(r.id) === String(sel) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const lobby = c.screens[0];
  return `
  <div class="page-head">
    <div><h1>การจอง &amp; จอทางเข้า</h1><p>รายชื่อจองขึ้นบนจอทางเข้า และจอห้องที่ถูกจองจะขึ้น “ยินดีต้อนรับ + ชื่อ” ให้อัตโนมัติ</p></div>
    <div class="row"><input type="date" id="bkDate" value="${esc(date)}" style="width:auto"><button class="btn small" data-act="bkToday">วันนี้</button>
      ${lobby ? `<a class="btn small" href="${esc(tvUrl(lobby.id, '&draft=1'))}" target="_blank" rel="noopener">${icon('eye')} ดูจอทางเข้า</a>` : ''}</div>
  </div>
  <div class="banner small-text">ข้อมูลบน GitHub เป็นสาธารณะ — ใส่แค่ <b>ชื่อที่จะโชว์บนจอ</b> (เช่น คุณเอ) <b>ห้ามใส่เบอร์โทร</b> · การจองที่เก่ากว่าเมื่อวานจะถูกลบอัตโนมัติตอนบันทึก</div>
  <section class="card cat">
    <div class="cat-head"><h2 style="flex:1;font-size:17px">${active.length} การจอง · ${guests} ท่าน</h2>
      <button class="btn primary small" data-act="addBooking">${icon('plus')} เพิ่มการจอง</button></div>
    <table class="menu-table bk-table">
      <thead><tr><th>เวลา</th><th>ชื่อ (โชว์บนจอ)</th><th>ห้อง</th><th>คน</th><th>โอกาส / หมายเหตุ</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>${list.map(({ b, i }) => `
        <tr class="${b.status === 'cancelled' ? 'na' : ''}" data-bk="${esc(b.id)}">
          <td style="width:120px"><input type="time" data-path="bookings.${i}.time" data-rerender value="${esc(b.time)}"></td>
          <td><input data-path="bookings.${i}.name" value="${esc(b.name)}" placeholder="เช่น คุณเอ"></td>
          <td style="width:140px"><select data-path="bookings.${i}.room" data-rerender>${roomOpts(b.room)}</select></td>
          <td style="width:80px"><input type="number" min="0" data-type="num" data-path="bookings.${i}.guests" value="${esc(b.guests)}"></td>
          <td><input list="noteList" data-path="bookings.${i}.note" value="${esc(b.note)}" placeholder="เช่น สุขสันต์วันเกิด"></td>
          <td style="width:120px"><select data-path="bookings.${i}.status" data-rerender>${BK_STATUS.map(st => `<option value="${st.id}" ${b.status === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}</select></td>
          <td><button class="btn icon small danger" data-act="delBooking" data-i="${i}" title="ลบ">${icon('trash')}</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">ยังไม่มีการจองวันนี้</td></tr>'}</tbody>
    </table>
    <datalist id="noteList">${NOTE_TPL.map(t => `<option value="${t}">`).join('')}</datalist>
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:14px">
      <label class="check"><input type="checkbox" data-path="settings.autoWelcome" ${c.settings.autoWelcome ? 'checked' : ''}> จอห้องที่ถูกจองขึ้น “ยินดีต้อนรับ + ชื่อ + โอกาส” อัตโนมัติ (1 ชม. ก่อนเวลาจอง ถึง 4 ชม. หลัง)</label>
      <label class="check"><input type="checkbox" data-path="settings.maskNames" ${c.settings.maskNames ? 'checked' : ''}> ย่อนามสกุลบนจอ (สมชาย ใจดี → สมชาย ใ.)</label>
    </div>
  </section>

  <div class="page-head" style="margin-top:28px">
    <div><h1 style="font-size:22px">จอพิเศษ</h1><p>จอทางเข้า / หน้าร้าน — เปิดลิงก์ “จอจริง” บนทีวีที่ทางเข้า</p></div>
    <button class="btn" data-act="addScreen">${icon('plus')} เพิ่มจอพิเศษ</button>
  </div>
  <div class="rooms-grid">${c.screens.map((sc, i) => roomCard(sc, i, 'screens')).join('') || '<div class="card empty">ยังไม่มีจอพิเศษ</div>'}</div>`;
}

/* Playlists */
function playlistSeconds(pl) {
  return pl.items.filter(it => it.enabled !== false).reduce((sum, it) => {
    if (it.type === 'menu') {
      const cats = it.category === '*' ? state.cfg.menu.categories : [RB.byId(state.cfg.menu.categories, it.category)].filter(Boolean);
      const pages = cats.reduce((n, c) => n + Math.ceil(c.items.filter(x => x.available !== false).length / (Number(it.perPage) || 6)), 0);
      return sum + pages * (Number(it.duration) || 12);
    }
    if (it.type === 'video' && !Number(it.duration)) { const m = media(it.media); return sum + ((m && m.duration) || 0); }
    return sum + (Number(it.duration) || 10);
  }, 0);
}

function viewPlaylists() {
  const c = state.cfg;
  let pi = c.playlists.findIndex(p => p.id === state.plSel);
  if (pi < 0 && c.playlists.length) { pi = 0; state.plSel = c.playlists[0].id; }
  const pl = c.playlists[pi];
  const used = id => c.rooms.concat(c.screens).filter(r => r.playlist === id && r.mode !== 'bookings').length;
  return `
  <div class="page-head"><div><h1>เพลย์ลิสต์</h1><p>ชุดสื่อที่วนเล่นบนจอ — 1 ห้องเลือกได้ 1 เพลย์ลิสต์</p></div>
    <button class="btn" data-act="addPlaylist">${icon('plus')} เพลย์ลิสต์ใหม่</button></div>
  <div class="split">
    <div class="card pl-list">${c.playlists.map(p => `
      <button class="item ${p.id === state.plSel ? 'on' : ''}" data-act="selPl" data-id="${esc(p.id)}">
        <b>${esc(p.name)}</b><small>${p.items.length} รายการ · ${fmtSec(playlistSeconds(p))} · ใช้ ${used(p.id)} ห้อง</small></button>`).join('')}
    </div>
    ${pl ? playlistEditor(pl, pi) : '<div class="card empty">ยังไม่มีเพลย์ลิสต์</div>'}
  </div>`;
}

function playlistEditor(pl, pi) {
  const firstRoom = (state.cfg.rooms.find(r => r.playlist === pl.id) || state.cfg.rooms[0] || { id: '1' }).id;
  return `
  <section class="card pl-editor">
    <div class="row">
      <input style="flex:1;font-weight:600;font-size:17px" data-path="playlists.${pi}.name" value="${esc(pl.name)}">
      <a class="btn" href="${esc(tvUrl(firstRoom, '&draft=1&playlist=' + encodeURIComponent(pl.id)))}" target="_blank" rel="noopener">${icon('eye')} ดูตัวอย่าง</a>
      <button class="btn icon" title="ทำสำเนา" data-act="dupPlaylist" data-pi="${pi}">${icon('copy')}</button>
      <button class="btn icon danger" title="ลบเพลย์ลิสต์" data-act="delPlaylist" data-pi="${pi}">${icon('trash')}</button>
    </div>
    <p class="muted small-text" style="margin:0">รวมประมาณ ${fmtSec(playlistSeconds(pl))} ต่อรอบ</p>
    <div class="pl-items">${pl.items.map((it, ii) => itemRow(it, pi, ii, pl.items.length)).join('') || '<div class="empty">ยังไม่มีรายการ — เพิ่มจากปุ่มด้านล่าง</div>'}</div>
    <div class="add-row">
      <button class="btn" data-act="addItem" data-pi="${pi}" data-type="image">${icon('plus')} รูปภาพ</button>
      <button class="btn" data-act="addItem" data-pi="${pi}" data-type="video">${icon('plus')} วิดีโอ</button>
      <button class="btn" data-act="addItem" data-pi="${pi}" data-type="menu">${icon('plus')} หน้าเมนูอาหาร</button>
      <button class="btn" data-act="addItem" data-pi="${pi}" data-type="promo">${icon('plus')} สไลด์โปรโมชั่น</button>
    </div>
  </section>`;
}

function thumbHtml(id, kind, path) {
  const m = media(id);
  let inner = 'เลือกไฟล์';
  if (m) inner = m.type === 'video' ? `<video src="${esc(mediaSrc(m))}#t=1" muted preload="metadata"></video>` : `<img src="${esc(mediaSrc(m))}" alt="">`;
  return `<button class="thumb" data-act="pick" data-path="${path}" data-kind="${kind}" title="เลือกจากคลังสื่อ">${inner}</button>`;
}

function itemRow(it, pi, ii, n) {
  const p = `playlists.${pi}.items.${ii}`;
  const num = (field, label, ph = '') =>
    `<label class="f">${label}<input type="number" min="0" data-type="num" data-path="${p}.${field}" value="${esc(it[field])}" placeholder="${ph}"></label>`;
  let preview, fields;
  if (it.type === 'image' || it.type === 'video') {
    preview = thumbHtml(it.media, it.type, `${p}.media`);
    const m = media(it.media);
    fields = `
      <div class="wide"><span class="type-badge ${it.type}">${TYPE_LABEL[it.type]}</span> <span class="small-text">${m ? esc(m.name) : '<span class="muted">ยังไม่เลือกไฟล์ — กดที่กรอบภาพ</span>'}</span></div>
      ${num('duration', it.type === 'video' ? 'วินาที (0 = เล่นจนจบ)' : 'แสดงกี่วินาที')}
      <label class="f">การจัดภาพ<select data-path="${p}.fit">
        <option value="contain" ${it.fit !== 'cover' ? 'selected' : ''}>พอดีจอ (ไม่ตัด)</option>
        <option value="cover" ${it.fit === 'cover' ? 'selected' : ''}>เต็มจอ (ตัดขอบ)</option></select></label>
      ${it.type === 'video' ? `<label class="check"><input type="checkbox" data-path="${p}.sound" ${it.sound ? 'checked' : ''}> เปิดเสียง (ปกติปิด เพื่อไม่กวนการร้องเพลง)</label>` : ''}`;
  } else if (it.type === 'menu') {
    const cats = state.cfg.menu.categories;
    preview = `<div class="thumb promo-prev" style="background:#7a5a1c">เมนู</div>`;
    fields = `
      <div class="wide"><span class="type-badge menu">${TYPE_LABEL.menu}</span></div>
      <label class="f">หมวด<select data-path="${p}.category" data-rerender>
        <option value="*" ${it.category === '*' ? 'selected' : ''}>ทุกหมวด (วนทีละหมวด)</option>
        ${cats.map(c => `<option value="${esc(c.id)}" ${c.id === it.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      ${num('perPage', 'จำนวนเมนูต่อหน้า')}
      ${num('duration', 'วินาทีต่อหน้า')}`;
  } else {
    const bg = media(it.bg);
    preview = `<button class="thumb promo-prev" data-act="pick" data-path="${p}.bg" data-kind="image" title="เลือกรูปพื้นหลัง"
      style="${bg ? `background-image:url('${esc(mediaSrc(bg))}')` : `background:${esc(it.color || state.cfg.shop.theme.primary)}`}">${esc(it.title || 'โปรฯ')}</button>`;
    fields = `
      <div class="wide"><span class="type-badge promo">${TYPE_LABEL.promo}</span> <span class="muted small-text">กดกรอบซ้ายเพื่อเลือกรูปพื้นหลัง (ไม่ใส่ก็ได้)</span></div>
      <label class="f">หัวข้อเล็ก<input data-path="${p}.eyebrow" value="${esc(it.eyebrow)}" placeholder="เช่น HAPPY HOUR"></label>
      <label class="f wide">ข้อความหลัก<input data-path="${p}.title" value="${esc(it.title)}" placeholder="เช่น เบียร์ 3 ขวด 199"></label>
      <label class="f wide">รายละเอียด<input data-path="${p}.subtitle" value="${esc(it.subtitle)}" placeholder="เช่น ทุกวัน 17:00–20:00 น."></label>
      ${num('price', 'ราคา (ว่าง = ไม่แสดง)')}
      <label class="f">สีเน้น<input type="color" data-path="${p}.color" value="${esc(it.color || state.cfg.shop.theme.primary)}"></label>
      ${num('duration', 'แสดงกี่วินาที')}
      ${it.bg ? `<button class="btn small" data-act="clearPath" data-path="${p}.bg">เอารูปพื้นหลังออก</button>` : ''}`;
  }
  return `
  <div class="pl-item ${it.enabled === false ? 'off' : ''}">
    <div class="num">${ii + 1}</div>
    ${preview}
    <div class="fields">${fields}</div>
    <div class="tools">
      <button class="btn icon small" title="ขึ้น" data-act="moveItem" data-pi="${pi}" data-ii="${ii}" data-d="-1" ${ii === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button class="btn icon small" title="ลง" data-act="moveItem" data-pi="${pi}" data-ii="${ii}" data-d="1" ${ii === n - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button class="btn icon small" title="ทำสำเนา" data-act="dupItem" data-pi="${pi}" data-ii="${ii}">${icon('copy')}</button>
      <label class="check" title="เปิด/ปิดชั่วคราว"><input type="checkbox" data-path="${p}.enabled" data-rerender ${it.enabled !== false ? 'checked' : ''}></label>
      <button class="btn icon small danger" title="ลบ" data-act="delItem" data-pi="${pi}" data-ii="${ii}">${icon('trash')}</button>
    </div>
  </div>`;
}

/* Menu */
function viewMenu() {
  const cats = state.cfg.menu.categories;
  return `
  <div class="page-head"><div><h1>เมนูอาหาร &amp; เครื่องดื่ม</h1><p>ราคาที่แก้ตรงนี้จะขึ้นบนจอทุกห้องที่มีสไลด์ “หน้าเมนูอาหาร” — ไม่ต้องทำภาพใหม่</p></div>
    <button class="btn" data-act="addCat">${icon('plus')} หมวดใหม่</button></div>
  ${cats.length ? cats.map(catCard).join('') : '<div class="card empty">ยังไม่มีหมวดเมนู</div>'}`;
}

function catCard(c, ci) {
  const p = `menu.categories.${ci}`;
  return `
  <section class="card cat">
    <div class="cat-head">
      <input data-path="${p}.name" value="${esc(c.name)}">
      <button class="btn icon small" data-act="moveCat" data-ci="${ci}" data-d="-1" ${ci === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button class="btn icon small" data-act="moveCat" data-ci="${ci}" data-d="1" ${ci === state.cfg.menu.categories.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button class="btn icon small danger" data-act="delCat" data-ci="${ci}">${icon('trash')}</button>
    </div>
    <table class="menu-table">
      <thead><tr><th>รูป</th><th>ชื่อเมนู</th><th>คำอธิบาย</th><th>ราคา</th><th>ป้าย</th><th>มีขาย</th><th></th></tr></thead>
      <tbody>${c.items.map((x, xi) => {
        const q = `${p}.items.${xi}`;
        return `<tr class="${x.available === false ? 'na' : ''}">
          <td>${thumbHtml(x.image, 'image', `${q}.image`)}</td>
          <td><input data-path="${q}.name" value="${esc(x.name)}" placeholder="ชื่อเมนู"></td>
          <td><input data-path="${q}.desc" value="${esc(x.desc)}" placeholder="(ไม่ใส่ก็ได้)"></td>
          <td class="price"><input type="number" min="0" data-type="num" data-path="${q}.price" value="${esc(x.price)}"></td>
          <td class="tagc"><input list="tagList" data-path="${q}.tag" value="${esc(x.tag)}"></td>
          <td><input type="checkbox" data-path="${q}.available" data-rerender ${x.available !== false ? 'checked' : ''} title="ติ๊กออก = ของหมด ไม่โชว์บนจอ"></td>
          <td class="row" style="flex-wrap:nowrap">
            <button class="btn icon small" data-act="moveMenuItem" data-ci="${ci}" data-xi="${xi}" data-d="-1" ${xi === 0 ? 'disabled' : ''}>${icon('up')}</button>
            <button class="btn icon small danger" data-act="delMenuItem" data-ci="${ci}" data-xi="${xi}">${icon('trash')}</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <datalist id="tagList">${TAGS.map(t => `<option value="${t}">`).join('')}</datalist>
    <button class="btn small" style="margin-top:10px" data-act="addMenuItem" data-ci="${ci}">${icon('plus')} เพิ่มเมนู</button>
  </section>`;
}

/* Media */
function usageCount(id) {
  const c = state.cfg;
  let n = c.shop.logo === id ? 1 : 0;
  c.playlists.forEach(p => p.items.forEach(it => { if (it.media === id || it.bg === id) n++; }));
  c.menu.categories.forEach(cat => cat.items.forEach(x => { if (x.image === id) n++; }));
  return n;
}

function viewMedia() {
  const list = state.cfg.media;
  return `
  <div class="page-head"><div><h1>คลังสื่อ</h1><p>รูปภาพ (JPG/PNG) และวิดีโอ (MP4) — รูปจะถูกย่อให้ไม่เกิน 1920px อัตโนมัติ</p></div></div>
  <div class="drop" id="drop" data-act="upload">
    ${icon('upload')}<div><b>ลากไฟล์มาวาง</b> หรือคลิกเพื่อเลือก</div>
    <div class="small-text">วิดีโอแนะนำ MP4 (H.264) 720p–1080p ขนาดไม่เกิน ~50 MB ต่อไฟล์</div>
  </div>
  ${list.length ? `<div class="media-grid">${list.map((m, mi) => `
    <div class="card media-card">
      <div class="pv">${m.type === 'video' ? `<video src="${esc(mediaSrc(m))}#t=1" muted preload="metadata"></video>` : `<img src="${esc(mediaSrc(m))}" alt="" loading="lazy">`}
        <span class="kind">${m.type === 'video' ? 'วิดีโอ' + (m.duration ? ' · ' + fmtSec(m.duration) : '') : 'รูปภาพ'}</span>
        ${state.pending.has(m.src) ? '<span class="pending">รอบันทึก</span>' : ''}</div>
      <div class="meta">
        <input data-path="media.${mi}.name" value="${esc(m.name)}">
        <div class="row small-text muted" style="justify-content:space-between">
          <span>${m.size ? fmtSize(m.size) : ''} · ใช้ ${usageCount(m.id)} ที่</span>
          <button class="btn icon small danger" data-act="delMedia" data-mi="${mi}" title="ลบไฟล์">${icon('trash')}</button>
        </div>
      </div>
    </div>`).join('')}</div>` : '<div class="card empty">ยังไม่มีไฟล์</div>'}`;
}

/* Settings */
function viewSettings() {
  const c = state.cfg, gh = ghLoad();
  const logo = media(c.shop.logo);
  return `
  <div class="page-head"><div><h1>ตั้งค่า</h1></div></div>
  <div class="settings-grid">
    <section class="card">
      <h2>ร้าน &amp; หน้าตาจอ</h2>
      <div class="grid2">
        <label class="f">ชื่อร้าน<input data-path="shop.name" value="${esc(c.shop.name)}"></label>
        <label class="f">คำโปรย<input data-path="shop.tagline" value="${esc(c.shop.tagline)}"></label>
      </div>
      <div class="row">${thumbHtml(c.shop.logo, 'image', 'shop.logo')}
        <span class="small-text muted">โลโก้ร้าน (PNG พื้นใส) ${logo ? `<button class="btn small" data-act="clearPath" data-path="shop.logo">ใช้โลโก้ดอกบัวเดิม</button>` : ''}</span></div>
      <div class="grid3">
        <label class="f">สีหลัก<input type="color" data-path="shop.theme.primary" value="${esc(c.shop.theme.primary)}"></label>
        <label class="f">สีรอง<input type="color" data-path="shop.theme.accent" value="${esc(c.shop.theme.accent)}"></label>
        <label class="f">สีพื้นหลัง<input type="color" data-path="shop.theme.bg" value="${esc(c.shop.theme.bg)}"></label>
      </div>
      <label class="check"><input type="checkbox" data-path="settings.showClock" ${c.settings.showClock ? 'checked' : ''}> แสดงนาฬิกามุมจอ</label>
    </section>

    <section class="card">
      <h2>ตัววิ่งด้านล่างจอ (ทุกห้อง)</h2>
      <label class="check"><input type="checkbox" data-path="ticker.enabled" ${c.ticker.enabled ? 'checked' : ''}> เปิดตัววิ่ง</label>
      <label class="f">ข้อความ<textarea rows="3" data-path="ticker.text">${esc(c.ticker.text)}</textarea></label>
      <label class="f">ความเร็ว (ยิ่งมากยิ่งเร็ว)<input type="number" min="20" max="300" data-type="num" data-path="ticker.speed" value="${esc(c.ticker.speed)}"></label>
    </section>

    <section class="card">
      <h2>ห้อง &amp; ลิงก์สำหรับกล่อง Android</h2>
      <p class="small-text muted" style="margin:0">ตั้งให้กล่องแต่ละห้องเปิดลิงก์ของห้องนั้น (ดูวิธีใน README)</p>
      <div class="url-list">${c.screens.map(sc => `
        <div class="u"><b style="min-width:64px">${esc(sc.name)}</b><code>${esc(tvUrl(sc.id))}</code>
          <button class="btn icon small" data-act="copy" data-text="${esc(tvUrl(sc.id))}" title="คัดลอก">${icon('link')}</button></div>`).join('')}${c.rooms.map((r, i) => `
        <div class="u"><b style="min-width:64px">${esc(r.name)}</b><code>${esc(tvUrl(r.id))}</code>
          <button class="btn icon small" data-act="copy" data-text="${esc(tvUrl(r.id))}" title="คัดลอก">${icon('link')}</button>
          <button class="btn icon small danger" data-act="delRoom" data-i="${i}" title="ลบห้อง">${icon('trash')}</button></div>`).join('')}</div>
      <div class="row">
        <button class="btn small" data-act="addRoom">${icon('plus')} เพิ่มห้อง</button>
        <button class="btn small" data-act="reloadAll">${icon('refresh')} สั่งรีโหลดทุกจอ</button>
      </div>
      <label class="f">จอเช็คข้อมูลใหม่ทุก (วินาที)<input type="number" min="10" data-type="num" data-path="settings.pollSeconds" value="${esc(c.settings.pollSeconds)}"></label>
    </section>

    <section class="card">
      <h2>(ขั้นสูง) สลับแอปบนกล่องคาราโอเกะ</h2>
      <p class="small-text muted" style="margin:0">ใช้โปรแกรม <b>bridge</b> สั่งกล่องคาราโอเกะผ่าน ADB — <b>เปิดใช้เฉพาะเมื่อเจ้าของระบบคาราโอเกะอนุญาต</b> (ดู <code>bridge/README.md</code>)</p>
      <label class="check"><input type="checkbox" data-path="settings.bridgeEnabled" data-rerender ${c.settings.bridgeEnabled ? 'checked' : ''}> เปิดโหมด “คาราโอเกะ” และ “อัตโนมัติ”</label>
      <div class="grid2">
        <label class="f">แอปคาราโอเกะ (package)<input data-path="settings.karaokeApp" value="${esc(c.settings.karaokeApp)}" placeholder="ดูจาก bridge -Status"></label>
        <label class="f">แอปแสดงโปรโมท (package)<input data-path="settings.promoApp" value="${esc(c.settings.promoApp)}"></label>
      </div>
      <label class="f">อัตโนมัติ: ไม่มีคนกดรีโมตกี่นาทีจึงเปลี่ยนเป็นโปรโมท<input type="number" min="1" data-type="num" data-path="settings.idleMinutes" value="${esc(c.settings.idleMinutes)}"></label>
      <label class="check"><input type="checkbox" data-path="settings.idleIgnoreAudio" ${c.settings.idleIgnoreAudio ? 'checked' : ''}> ไม่ต้องรอให้เสียงเงียบ (ใช้เมื่อแอปคาราโอเกะเปิดเพลงพื้นหลังตลอด)</label>
    </section>

    <section class="card">
      <h2>เชื่อมต่อ GitHub</h2>
      <p class="small-text muted" style="margin:0">ใช้ Fine-grained token สิทธิ์ <b>Contents: Read and write</b> เฉพาะ repo นี้ — Token เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ใช้บนคอมกลางของร้าน อย่าใช้บนเครื่องสาธารณะ</p>
      <div class="grid3">
        <label class="f">Owner<input id="ghOwner" value="${esc(gh.owner)}"></label>
        <label class="f">Repo<input id="ghRepo" value="${esc(gh.repo)}"></label>
        <label class="f">Branch<input id="ghBranch" value="${esc(gh.branch)}"></label>
      </div>
      <label class="f">Token<input id="ghToken" type="password" value="${esc(gh.token)}" placeholder="github_pat_…" autocomplete="off"></label>
      <div class="row">
        <button class="btn primary" data-act="ghConnect">เชื่อมต่อ &amp; โหลดข้อมูลล่าสุด</button>
        ${gh.token ? `<button class="btn danger" data-act="ghForget">ลบ Token จากเครื่องนี้</button>` : ''}
      </div>
    </section>

    <section class="card">
      <h2>สำรองข้อมูล</h2>
      <div class="row">
        <button class="btn" data-act="exportJson">ดาวน์โหลด config.json</button>
        <button class="btn" data-act="importJson">นำเข้า config.json</button>
      </div>
      <p class="small-text muted" style="margin:0">ประวัติการแก้ทุกครั้งถูกเก็บใน GitHub (commit history) ย้อนกลับได้เสมอ</p>
    </section>
  </div>`;
}

/* ---------- media picker ---------- */
let pickCb = null;
function openPicker(kind, cb) {
  pickCb = cb;
  const list = state.cfg.media.filter(m => kind === 'any' || m.type === kind);
  $('#modalBox').innerHTML = `
    <div class="modal-head"><h3>เลือก${kind === 'video' ? 'วิดีโอ' : 'รูปภาพ'}</h3>
      <button class="btn small" data-act="upload">${icon('upload')} อัปโหลดใหม่</button>
      <button class="btn small" data-act="closeModal">ปิด</button></div>
    <div class="modal-body">${list.length ? `<div class="pick-grid">${list.map(m => `
      <button data-act="pickDone" data-id="${esc(m.id)}"><div class="pv">${m.type === 'video'
        ? `<video src="${esc(mediaSrc(m))}#t=1" muted preload="metadata"></video>` : `<img src="${esc(mediaSrc(m))}" alt="" loading="lazy">`}</div>
        <span>${esc(m.name)}</span></button>`).join('')}</div>`
      : '<div class="empty">ยังไม่มีไฟล์ประเภทนี้ — กด “อัปโหลดใหม่”</div>'}</div>`;
  $('#modal').classList.remove('hidden');
  $('#modal').dataset.kind = kind;
}
function closeModal() { $('#modal').classList.add('hidden'); pickCb = null; }

/* ---------- uploads ---------- */
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function shrinkImage(file) {
  if (/gif|svg/.test(file.type)) return { blob: file, ext: file.type.includes('gif') ? 'gif' : 'svg' };
  const bmp = await createImageBitmap(file);
  const max = 1920, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const png = file.type === 'image/png';
  if (scale === 1 && file.size < 900 * 1024) return { blob: file, ext: png ? 'png' : 'jpg' };
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.86));
  return { blob, ext: png ? 'png' : 'jpg' };
}

function videoDuration(url) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => res(Math.round(v.duration) || 0);
    v.onerror = () => res(0);
    v.src = url;
  });
}

function newPath(ext) {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return `media/${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

async function handleFiles(files) {
  const added = [];
  for (const f of files) {
    const isVideo = f.type.startsWith('video/');
    if (!isVideo && !f.type.startsWith('image/')) { toast(`ข้าม ${f.name} — ไม่ใช่รูป/วิดีโอ`); continue; }
    if (isVideo && f.size > 95 * 1048576) {
      alert(`${f.name} ใหญ่เกิน (${fmtSize(f.size)})\nGitHub รับได้ไม่เกิน ~95 MB ต่อไฟล์ — ลองย่อเป็น 720p ด้วย HandBrake หรือ CapCut ก่อน`);
      continue;
    }
    progress(`กำลังเตรียม ${f.name}…`);
    try {
      const { blob, ext } = isVideo ? { blob: f, ext: (f.name.split('.').pop() || 'mp4').toLowerCase() } : await shrinkImage(f);
      const path = newPath(ext);
      const url = URL.createObjectURL(blob);
      state.pending.set(path, { base64: await blobToBase64(blob) });
      state.localUrls.set(path, url);
      const m = { id: uid('m'), type: isVideo ? 'video' : 'image', name: f.name.replace(/\.[^.]+$/, ''), src: path, size: blob.size };
      if (isVideo) m.duration = await videoDuration(url);
      state.cfg.media.push(m);
      added.push(m);
      if (isVideo && f.size > 50 * 1048576) toast(`${f.name} ค่อนข้างใหญ่ (${fmtSize(f.size)}) จอจะโหลดนานในครั้งแรก`, 5000);
    } catch (e) {
      alert(`อ่านไฟล์ ${f.name} ไม่ได้: ${e.message}`);
    }
  }
  progress('');
  if (added.length) markDirty();
  return added;
}

/* ---------- save ---------- */
async function save() {
  if (state.busy) return;
  if (!state.store || !state.canPush) {
    alert('ยังไม่ได้เชื่อม GitHub Token ที่มีสิทธิ์เขียน\nไปที่แท็บ “ตั้งค่า” → เชื่อมต่อ GitHub');
    state.tab = 'settings';
    render();
    return;
  }
  state.busy = true;
  progress('ตรวจสอบข้อมูลล่าสุด…');
  try {
    let remote = null;
    try { remote = JSON.parse(await state.store.readText(RB.CONFIG_PATH)); } catch (e) { if (e.status !== 404) throw e; }
    if (remote && state.remoteUpdatedAt && remote.updatedAt !== state.remoteUpdatedAt &&
        !confirm('มีการบันทึกจากเครื่องอื่นหลังจากคุณเปิดหน้านี้\nกด OK เพื่อเขียนทับด้วยข้อมูลของคุณ หรือ Cancel แล้วรีเฟรชหน้าเพื่อโหลดข้อมูลใหม่')) {
      return;
    }
    const cfg = state.cfg;
    // bookings are personal data in a public repo: keep only yesterday onwards
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const keepFrom = RB.businessDate(y, cfg.settings.dayStartHour);
    cfg.bookings = cfg.bookings.filter(b => b.date >= keepFrom);
    cfg.version = Math.max(Number(remote && remote.version) || 0, Number(cfg.version) || 0) + 1;
    cfg.updatedAt = new Date().toISOString();

    const files = [...state.pending].map(([path, p]) => ({ path, base64: p.base64 }));
    files.push({ path: RB.CONFIG_PATH, text: JSON.stringify(cfg, null, 2) + '\n' });
    let deletes = [];
    if (state.deletes.size) {
      const existing = await state.store.listPaths('media/');
      deletes = [...state.deletes].filter(p => existing.has(p));
    }
    await state.store.commit(`Update TV content v${cfg.version}`, files, deletes, progress);

    state.pending.clear();
    state.deletes.clear();
    state.remoteUpdatedAt = cfg.updatedAt;
    state.dirty = false;
    toast('บันทึกแล้ว ✓ จอทุกห้องจะเปลี่ยนภายใน ~1–2 นาที', 5000);
  } catch (e) {
    alert('บันทึกไม่สำเร็จ: ' + e.message);
  } finally {
    state.busy = false;
    progress('');
    render();
  }
}

/* ---------- actions ---------- */
const NEW_ITEM = {
  image: () => ({ id: uid('it'), type: 'image', media: '', duration: 10, fit: 'contain' }),
  video: () => ({ id: uid('it'), type: 'video', media: '', duration: 0, sound: false, fit: 'contain' }),
  menu: () => ({ id: uid('it'), type: 'menu', category: '*', perPage: 6, duration: 12 }),
  promo: () => ({ id: uid('it'), type: 'promo', eyebrow: 'โปรโมชั่น', title: '', subtitle: '', price: '', bg: '', color: '', duration: 10 })
};

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function change(fn) { fn(state.cfg); markDirty(); render(); }

const actions = {
  save,
  tab: d => { state.tab = d.tab; render(); },
  setMode: d => change(c => { c[d.coll || 'rooms'][d.i].mode = d.mode; }),
  msgTpl: d => change(c => { c[d.coll || 'rooms'][d.i].message = MSG_TEMPLATES[d.k]; }),
  reloadRoom: d => change(c => { c[d.coll || 'rooms'][d.i].reload = Date.now(); toast('สั่งรีโหลดแล้ว — กดบันทึกเพื่อส่งคำสั่ง'); }),

  bkToday: () => { state.bkDate = RB.businessDate(new Date(), state.cfg.settings.dayStartHour); render(); },
  addBooking: () => {
    const b = { id: uid('bk'), date: state.bkDate, time: '19:00', name: '', room: '', guests: '', note: '', status: 'booked' };
    change(c => c.bookings.push(b));
    const input = document.querySelector(`tr[data-bk="${b.id}"] input[data-path$=".name"]`);
    if (input) input.focus();
  },
  delBooking: d => {
    const b = state.cfg.bookings[d.i];
    if (confirm(`ลบการจอง ${b.time} ${b.name || ''}?`)) change(c => c.bookings.splice(d.i, 1));
  },
  addScreen: () => {
    const name = prompt('ชื่อจอ (เช่น ทางเข้าร้าน, หน้าบาร์)', 'จอพิเศษ');
    if (!name) return;
    change(c => {
      const sc = RB.defaultScreen();
      sc.id = 'screen-' + Math.random().toString(36).slice(2, 7);
      sc.name = name;
      sc.playlist = c.playlists[0] ? c.playlists[0].id : '';
      c.screens.push(sc);
    });
  },
  delScreen: d => { if (confirm(`ลบจอ ${state.cfg.screens[d.i].name}?`)) change(c => c.screens.splice(d.i, 1)); },
  reloadAll: () => change(c => { c.reload = Date.now(); toast('สั่งรีโหลดทุกจอ — กดบันทึกเพื่อส่งคำสั่ง'); }),
  bulkPlaylist: () => { const id = $('#bulkPl').value; change(c => c.rooms.forEach(r => { r.mode = 'playlist'; r.playlist = id; })); },
  bulkMode: d => change(c => c.rooms.forEach(r => { r.mode = d.mode; })),
  addRoom: () => change(c => {
    const n = c.rooms.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
    const r = RB.defaultRoom(n);
    r.playlist = c.playlists[0] ? c.playlists[0].id : '';
    c.rooms.push(r);
  }),
  delRoom: d => { if (confirm(`ลบ ${state.cfg.rooms[d.i].name}?`)) change(c => c.rooms.splice(d.i, 1)); },

  selPl: d => { state.plSel = d.id; render(); },
  addPlaylist: () => {
    const name = prompt('ชื่อเพลย์ลิสต์ใหม่', 'เพลย์ลิสต์ใหม่');
    if (!name) return;
    const pl = { id: uid('pl'), name, items: [] };
    state.plSel = pl.id;
    change(c => c.playlists.push(pl));
  },
  dupPlaylist: d => {
    const src = state.cfg.playlists[d.pi];
    const pl = JSON.parse(JSON.stringify(src));
    pl.id = uid('pl');
    pl.name = src.name + ' (สำเนา)';
    pl.items.forEach(it => { it.id = uid('it'); });
    state.plSel = pl.id;
    change(c => c.playlists.push(pl));
  },
  delPlaylist: d => {
    const c = state.cfg, pl = c.playlists[d.pi];
    if (c.playlists.length === 1) return alert('ต้องมีอย่างน้อย 1 เพลย์ลิสต์');
    const using = c.rooms.filter(r => r.playlist === pl.id);
    if (!confirm(`ลบ “${pl.name}”?${using.length ? `\n${using.length} ห้องที่ใช้อยู่จะเปลี่ยนไปใช้เพลย์ลิสต์แรกแทน` : ''}`)) return;
    change(c => {
      c.playlists.splice(d.pi, 1);
      using.forEach(r => { r.playlist = c.playlists[0].id; });
      state.plSel = c.playlists[0].id;
    });
  },
  addItem: d => {
    const it = NEW_ITEM[d.type]();
    change(c => c.playlists[d.pi].items.push(it));
    if (d.type === 'image' || d.type === 'video') {
      const ii = state.cfg.playlists[d.pi].items.length - 1;
      openPicker(d.type, id => { setPath(state.cfg, `playlists.${d.pi}.items.${ii}.media`, id); });
    }
  },
  moveItem: d => change(c => move(c.playlists[d.pi].items, +d.ii, +d.d)),
  dupItem: d => change(c => {
    const items = c.playlists[d.pi].items;
    items.splice(+d.ii + 1, 0, { ...JSON.parse(JSON.stringify(items[d.ii])), id: uid('it') });
  }),
  delItem: d => change(c => c.playlists[d.pi].items.splice(d.ii, 1)),

  addCat: () => change(c => c.menu.categories.push({ id: uid('cat'), name: 'หมวดใหม่', items: [] })),
  moveCat: d => change(c => move(c.menu.categories, +d.ci, +d.d)),
  delCat: d => {
    const cat = state.cfg.menu.categories[d.ci];
    if (!confirm(`ลบหมวด “${cat.name}” และเมนู ${cat.items.length} รายการ?`)) return;
    change(c => {
      c.menu.categories.splice(d.ci, 1);
      c.playlists.forEach(p => p.items.forEach(it => { if (it.type === 'menu' && it.category === cat.id) it.category = '*'; }));
    });
  },
  addMenuItem: d => change(c => c.menu.categories[d.ci].items.push({ id: uid('mi'), name: '', desc: '', price: '', image: '', tag: '', available: true })),
  moveMenuItem: d => change(c => move(c.menu.categories[d.ci].items, +d.xi, +d.d)),
  delMenuItem: d => change(c => c.menu.categories[d.ci].items.splice(d.xi, 1)),

  upload: () => $('#fileInput').click(),
  delMedia: d => {
    const m = state.cfg.media[d.mi];
    const n = usageCount(m.id);
    if (!confirm(`ลบ “${m.name}”?${n ? `\nไฟล์นี้ถูกใช้อยู่ ${n} ที่ จะถูกเอาออกจากที่ใช้ด้วย` : ''}`)) return;
    change(c => {
      c.media.splice(d.mi, 1);
      if (c.shop.logo === m.id) c.shop.logo = '';
      c.playlists.forEach(p => {
        p.items = p.items.filter(it => it.media !== m.id);
        p.items.forEach(it => { if (it.bg === m.id) it.bg = ''; });
      });
      c.menu.categories.forEach(cat => cat.items.forEach(x => { if (x.image === m.id) x.image = ''; }));
      if (state.pending.has(m.src)) state.pending.delete(m.src);
      else if (!/^https?:/.test(m.src)) state.deletes.add(m.src);
    });
  },

  pick: d => openPicker(d.kind, id => { setPath(state.cfg, d.path, id); }),
  pickDone: d => { const cb = pickCb; closeModal(); if (cb) { cb(d.id); markDirty(); render(); } },
  closeModal,
  clearPath: d => change(c => setPath(c, d.path, '')),
  copy: d => { navigator.clipboard.writeText(d.text).then(() => toast('คัดลอกลิงก์แล้ว')); },

  ghConnect: async () => {
    ghSave({
      owner: $('#ghOwner').value.trim(), repo: $('#ghRepo').value.trim(),
      branch: $('#ghBranch').value.trim() || 'main', token: $('#ghToken').value.trim()
    });
    if (state.dirty && !confirm('มีการแก้ไขที่ยังไม่บันทึก — โหลดข้อมูลจาก GitHub ทับหรือไม่?\n(Cancel = เชื่อมต่ออย่างเดียว เก็บงานที่แก้ไว้)')) {
      await connect();
      return render();
    }
    progress('กำลังเชื่อมต่อ…');
    const raw = await connect();
    progress('');
    if (state.store) {
      if (raw) { state.cfg = RB.normalize(raw); state.remoteUpdatedAt = raw.updatedAt; state.dirty = false; }
      toast(state.canPush ? 'เชื่อมต่อสำเร็จ' : 'เชื่อมได้ แต่ Token ไม่มีสิทธิ์เขียน');
    }
    render();
  },
  ghForget: () => { const g = ghLoad(); g.token = ''; ghSave(g); connect().then(render); },
  exportJson: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.cfg, null, 2)], { type: 'application/json' }));
    a.download = 'config.json';
    a.click();
  },
  importJson: () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try {
        const cfg = RB.normalize(JSON.parse(await inp.files[0].text()));
        if (!confirm('แทนที่ข้อมูลทั้งหมดด้วยไฟล์นี้?')) return;
        state.cfg = cfg;
        markDirty();
        render();
      } catch (e) { alert('ไฟล์ไม่ถูกต้อง: ' + e.message); }
    };
    inp.click();
  }
};

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = actions[b.dataset.act];
  if (fn) { e.preventDefault(); fn({ ...b.dataset }, b); }
});

function onBind(e) {
  const el = e.target;
  if (el.id === 'bkDate') { if (e.type === 'change' && el.value) { state.bkDate = el.value; render(); } return; }
  const path = el.dataset && el.dataset.path;
  if (!path || !state.cfg) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'num') v = v === '' ? '' : Number(v);
  if (getPath(state.cfg, path) === v) return;
  setPath(state.cfg, path, v);
  markDirty();
  if (el.hasAttribute('data-rerender') && e.type === 'change') render();
}
document.addEventListener('input', onBind);
document.addEventListener('change', onBind);

$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (state.dirty) save(); }
});

$('#fileInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  const added = await handleFiles(files);
  const kind = $('#modal').dataset.kind;
  if (pickCb && added.length) {
    const m = added.find(x => kind === 'any' || x.type === kind);
    if (m) return actions.pickDone({ id: m.id });
  }
  render();
});

document.addEventListener('dragover', e => {
  const drop = e.target.closest && e.target.closest('#drop');
  if (drop) { e.preventDefault(); drop.classList.add('over'); }
});
document.addEventListener('dragleave', e => { const d = e.target.closest && e.target.closest('#drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', async e => {
  const drop = e.target.closest && e.target.closest('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('over');
  await handleFiles([...e.dataTransfer.files]);
  render();
});

window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

init();
