/* Storage backend for self-hosted deployments: talks to api/index.php on the same host.
   Same interface as GitHubStore (readText / commit) so admin.js can use either. */
class ServerStore {
  constructor(status) {
    this.base = 'api/';
    this.status = status || {};
    this.token = '';
    try { this.token = localStorage.getItem('rb_srv_token') || ''; } catch (_) {}
  }

  /** Returns the API status when api/index.php is reachable on this host, else null (e.g. GitHub Pages). */
  static async detect() {
    try {
      const r = await fetch('api/?action=status', { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.ok ? d : null;
    } catch (_) {
      return null;
    }
  }

  setToken(t) {
    this.token = t || '';
    try { t ? localStorage.setItem('rb_srv_token', t) : localStorage.removeItem('rb_srv_token'); } catch (_) {}
  }

  async call(action, { method = 'GET', json, form } = {}) {
    const headers = {};
    if (this.token) headers['X-Auth'] = this.token;
    if (json) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}?action=${action}`, {
      method, headers, cache: 'no-store',
      body: json ? JSON.stringify(json) : form
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async setup(password) { this.setToken((await this.call('setup', { method: 'POST', json: { password } })).token); }
  async login(password) { this.setToken((await this.call('login', { method: 'POST', json: { password } })).token); }
  async changePassword(oldPw, newPw) {
    this.setToken((await this.call('password', { method: 'POST', json: { old: oldPw, new: newPw } })).token);
  }
  logout() { this.setToken(''); }

  /** true when the saved token is still valid */
  async check() {
    if (!this.token) return false;
    try { await this.call('whoami'); return true; } catch (e) { if (e.status === 401) this.setToken(''); return false; }
  }

  async readText() {
    const res = await fetch(`${this.base}?action=config`, { cache: 'no-store' });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.text();
  }

  /** Upload in chunks so large videos work even when the host's upload limit is small. */
  async upload(path, blob, onProgress) {
    const limit = Number(this.status.maxUpload) || 2 * 1048576;
    const size = Math.max(256 * 1024, Math.min(8 * 1048576, Math.floor(limit * 0.8)));
    const total = Math.max(1, Math.ceil(blob.size / size));
    const uploadId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    for (let i = 0; i < total; i++) {
      const form = new FormData();
      form.append('path', path);
      form.append('uploadId', uploadId);
      form.append('index', String(i));
      form.append('total', String(total));
      form.append('chunk', blob.slice(i * size, (i + 1) * size), 'chunk');
      await this.call('upload', { method: 'POST', form });
      onProgress(Math.round(((i + 1) / total) * 100));
    }
  }

  /** files: [{ path, blob }] media and [{ path, text }] for config.json */
  async commit(message, files, deletes = [], onProgress = () => {}) {
    const media = files.filter(f => f.blob);
    let n = 0;
    for (const f of media) {
      n++;
      await this.upload(f.path, f.blob, pct => onProgress(`อัปโหลด ${n}/${media.length}: ${f.path} (${pct}%)`));
    }
    onProgress('บันทึกข้อมูล…');
    const cfgFile = files.find(f => f.text != null);
    await this.call('save', { method: 'POST', json: { config: JSON.parse(cfgFile.text), deletes } });
  }
}
