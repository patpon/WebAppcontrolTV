/* Minimal GitHub REST client used by the admin panel.
   Writes go through the Git Data API so config + media land in ONE atomic commit. */
class GitHubStore {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
  }

  async api(path, { method = 'GET', body, accept } = {}) {
    const res = await fetch(this.base + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch (_) {}
      const err = new Error(`GitHub ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    if (accept && accept.includes('raw')) return res.text();
    return res.status === 204 ? null : res.json();
  }

  /** Returns repo info and whether the token can push. */
  async check() {
    const info = await this.api('');
    return { canPush: !!(info.permissions && info.permissions.push), private: info.private, defaultBranch: info.default_branch };
  }

  async head() {
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commit = await this.api(`/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  async readText(path) {
    return this.api(`/contents/${path}?ref=${encodeURIComponent(this.branch)}`, { accept: 'application/vnd.github.raw+json' });
  }

  /**
   * files:   [{ path, text }] or [{ path, blob }]
   * deletes: [path]
   * onProgress(msg)
   */
  async commit(message, files, deletes = [], onProgress = () => {}) {
    const { commitSha, treeSha } = await this.head();
    const tree = [];
    let n = 0;
    for (const f of files) {
      n++;
      onProgress(`อัปโหลด ${n}/${files.length}: ${f.path}`);
      const blob = await this.api('/git/blobs', {
        method: 'POST',
        body: f.blob ? { content: await GitHubStore.toBase64(f.blob), encoding: 'base64' } : { content: f.text, encoding: 'utf-8' }
      });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const p of deletes) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

    onProgress('สร้าง commit…');
    const newTree = await this.api('/git/trees', { method: 'POST', body: { base_tree: treeSha, tree } });
    const newCommit = await this.api('/git/commits', {
      method: 'POST',
      body: { message, tree: newTree.sha, parents: [commitSha] }
    });
    await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH',
      body: { sha: newCommit.sha }
    });
    return newCommit.sha;
  }

  static toBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  /** Paths that currently exist in the branch (used to skip deleting files that were never pushed). */
  async listPaths(prefix) {
    const { treeSha } = await this.head();
    const t = await this.api(`/git/trees/${treeSha}?recursive=1`);
    return new Set(t.tree.filter(x => x.type === 'blob' && x.path.startsWith(prefix)).map(x => x.path));
  }
}
