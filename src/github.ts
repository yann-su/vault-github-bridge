import { blobHash, inScope, validatePaths, type RemotePort, type RemoteSnapshot, type Scope } from './model';

export interface HttpResponse { status: number; headers: Record<string, string>; json: unknown }
export type Transport = (method: string, path: string, body?: unknown) => Promise<HttpResponse>;
export class GitHubError extends Error {
  constructor(message: string, public status: number, public retryAfterMs = 0) { super(message); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 返回了无效数据。');
  return value as Record<string, unknown>;
}
function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GitHub 响应缺少必要字段。');
  return value;
}
function sha(value: unknown): string {
  const s = str(value);
  if (!/^[0-9a-f]{40}$/.test(s)) throw new Error('GitHub 返回了无效的对象哈希。');
  return s;
}
export function toBase64(data: Uint8Array): string {
  let result = '';
  for (let i = 0; i < data.length; i += 0x8000) result += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(result);
}
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0));
}

export class GitHubRemote implements RemotePort {
  private root: string;
  private branchPath: string;
  private uploaded = new Set<string>();
  private readSequence = 0;
  constructor(private http: Transport, owner: string, repo: string, branch: string, private scope: Scope, private device: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') throw new Error('请填写有效的 GitHub 用户名和仓库名。');
    if (!branch || /[\s~^:?*\[\\]|\.\.|@\{|^\/|\/$|\/\//.test(branch)) throw new Error('分支名无效。');
    this.root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.branchPath = branch.split('/').map(encodeURIComponent).join('/');
  }
  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.http(method, this.root + path, body);
    if (response.status >= 200 && response.status < 300) return record(response.json);
    const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const retry = Number(headers['retry-after']);
    const reset = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
    const isLimited = response.status === 429 || (response.status === 403 && (headers['x-ratelimit-remaining'] === '0' || Boolean(headers['retry-after'])));
    const wait = isLimited ? Math.max(60_000, (retry || 0) * 1000, headers['x-ratelimit-remaining'] === '0' ? reset : 0) : 0;
    const messages: Record<number, string> = {
      401: 'GitHub 凭据无效或已过期，请在设置中更新。',
      403: 'GitHub 拒绝请求：请检查仓库 Contents 权限、分支规则或请求额度。',
      404: '找不到仓库或分支。请检查权限，并先在 GitHub 创建至少一个提交（例如 README）。',
      409: '远端已变化，需要重新比较。',
      422: 'GitHub 拒绝更新，可能是分支已变化、分支受保护或请求过于频繁。',
      429: 'GitHub 请求受到限流，稍后自动重试。'
    };
    throw new GitHubError(messages[response.status] ?? `GitHub 请求失败（HTTP ${response.status}）。`, response.status, wait);
  }
  async snapshot(): Promise<RemoteSnapshot> {
    // This mutable ref has a different URL from the PATCH /git/refs endpoint.
    // Native HTTP caches must not replay an older head after a successful push.
    const ref = await this.request('GET', `/git/ref/heads/${this.branchPath}?bridge_sync=${Date.now()}-${++this.readSequence}`);
    const head = sha(record(ref.object).sha);
    const commit = await this.request('GET', `/git/commits/${head}`);
    const tree = sha(record(commit.tree).sha);
    const response = await this.request('GET', `/git/trees/${tree}?recursive=1`);
    const entries: Array<{ path: string; value: Record<string, unknown> }> = [];
    const append = (value: Record<string, unknown>, prefix: string) => {
      if (!Array.isArray(value.tree)) throw new Error('GitHub 文件清单不完整，已停止同步。');
      for (const item of value.tree) {
        const v = record(item);
        entries.push({ path: prefix + str(v.path), value: v });
      }
    };
    if (response.truncated === false) append(response, '');
    else if (response.truncated === true) {
      const queue = [{ id: tree, prefix: '' }];
      let visited = 0;
      while (queue.length) {
        if (++visited > 20_000) throw new Error('仓库目录过多，已停止同步；请使用独立笔记仓库。');
        const item = queue.shift()!;
        const sub = await this.request('GET', `/git/trees/${item.id}`);
        if (sub.truncated !== false || !Array.isArray(sub.tree)) throw new Error('GitHub 文件清单仍被截断，已停止同步。');
        for (const raw of sub.tree) {
          const v = record(raw), path = item.prefix + str(v.path);
          if (v.type === 'tree') queue.push({ id: sha(v.sha), prefix: path + '/' });
          else entries.push({ path, value: v });
        }
      }
    } else throw new Error('无法确认 GitHub 文件清单完整性，已停止同步。');
    const files = new Map<string, string>();
    for (const { path, value } of entries) {
      if (value.type === 'tree' || !inScope(path, this.scope)) continue;
      if (value.type !== 'blob' || !['100644', '100755'].includes(str(value.mode))) throw new Error(`不支持同步符号链接或子模块：${path}`);
      if (typeof value.size !== 'number' || value.size > this.scope.maxBytes) throw new Error(`远端文件超过大小限制：${path}。请排除该文件夹或提高限制。`);
      files.set(path, sha(value.sha));
      this.uploaded.add(sha(value.sha));
    }
    validatePaths(files.keys());
    return { head, tree, files };
  }
  async blob(id: string): Promise<Uint8Array> {
    const response = await this.request('GET', `/git/blobs/${sha(id)}`);
    if (response.encoding !== 'base64') throw new Error('GitHub 返回了不支持的文件编码。');
    const data = fromBase64(str(response.content));
    if (data.length > this.scope.maxBytes || blobHash(data) !== id) throw new Error('下载文件校验失败或超过大小限制，未写入笔记库。');
    return data;
  }
  async prepare(snapshot: RemoteSnapshot, changes: Array<{ path: string; data: Uint8Array | null }>): Promise<string> {
    const entries = [];
    for (const change of changes) {
      let id: string | null = null;
      if (change.data !== null) {
        id = blobHash(change.data);
        if (!this.uploaded.has(id)) {
          const result = await this.request('POST', '/git/blobs', { content: toBase64(change.data), encoding: 'base64' });
          if (sha(result.sha) !== id) throw new Error('上传文件哈希不匹配，已停止提交。');
          this.uploaded.add(id);
        }
      }
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: id });
    }
    const tree = await this.request('POST', '/git/trees', { base_tree: snapshot.tree, tree: entries });
    const commit = await this.request('POST', '/git/commits', {
      message: `Vault sync: ${this.device} (${changes.length} files)`, tree: sha(tree.sha), parents: [snapshot.head]
    });
    return sha(commit.sha);
  }
  async advance(candidate: string): Promise<void> {
    await this.request('PATCH', `/git/refs/heads/${this.branchPath}`, { sha: sha(candidate), force: false });
  }
  async contains(candidate: string, head: string): Promise<boolean> {
    if (candidate === head) return true;
    const result = await this.request('GET', `/compare/${sha(candidate)}...${sha(head)}`);
    if (!['ahead', 'identical', 'behind', 'diverged'].includes(String(result.status))) throw new Error('GitHub 提交关系响应无效，请稍后重新检查。笔记已保留。');
    return result.status === 'ahead' || result.status === 'identical';
  }
}
