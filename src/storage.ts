import { blobHash, decode, encode, hashText, type SyncState, type StatePort } from './model';

export interface StorageFS {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}
export function arrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}
export async function mkdirs(fs: Pick<StorageFS, 'exists' | 'mkdir'>, path: string): Promise<void> {
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    if (!await fs.exists(current)) await fs.mkdir(current);
  }
}
function validateState(value: unknown, binding: string): SyncState {
  if (!value || typeof value !== 'object') throw new Error('同步状态无效。');
  const s = value as SyncState;
  if (s.schema !== 1 || s.binding !== binding || typeof s.approved !== 'boolean' || !s.bases ||
    !s.resolutions || !Array.isArray(s.conflicts) || !Array.isArray(s.history)) throw new Error('同步状态版本或仓库标识不匹配。');
  const valid = (h: unknown) => h === null || (typeof h === 'string' && /^[0-9a-f]{40}$/.test(h));
  if (Object.values(s.bases).some(h => !valid(h))) throw new Error('同步基线无效。');
  if (s.pending && (!Array.isArray(s.pending.operations) || s.pending.operations.some(op =>
    typeof op.path !== 'string' || !['push', 'pull', 'adopt'].includes(op.kind) || !valid(op.before) || !valid(op.target)))) throw new Error('恢复日志无效。');
  return s;
}

/** Two alternating, checksummed checkpoints. Never start fresh over corrupt state. */
export class DiskStateStore implements StatePort {
  private sequence = 0;
  constructor(private fs: StorageFS, public root: string, private binding: string) {}
  async load(): Promise<SyncState | null> {
    const candidates: Array<{ sequence: number; state: SyncState }> = [];
    let found = false;
    for (let slot = 0; slot < 2; slot++) {
      const path = `${this.root}/state-${slot}.json`;
      if (!await this.fs.exists(path)) continue;
      found = true;
      try {
        const envelope = JSON.parse(await this.fs.read(path)) as { sequence: number; payload: string; checksum: string };
        if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
          hashText(`${envelope.sequence}:${envelope.payload}`) !== envelope.checksum) continue;
        candidates.push({ sequence: envelope.sequence, state: validateState(JSON.parse(envelope.payload), this.binding) });
      } catch { /* The other slot may contain the last complete checkpoint. */ }
    }
    candidates.sort((a, b) => b.sequence - a.sequence);
    if (found && !candidates.length) throw new Error('本地同步日志损坏，已停止自动同步以保护笔记。请保留 local 文件夹用于恢复。');
    const newest = candidates[0];
    this.sequence = newest?.sequence ?? 0;
    return newest?.state ?? null;
  }
  async save(state: SyncState): Promise<void> {
    validateState(state, this.binding);
    await mkdirs(this.fs, this.root);
    const payload = JSON.stringify(state), sequence = this.sequence + 1;
    const content = JSON.stringify({ sequence, payload, checksum: hashText(`${sequence}:${payload}`) });
    const path = `${this.root}/state-${sequence % 2}.json`;
    await this.fs.write(path, content);
    if (await this.fs.read(path) !== content) throw new Error('本地同步日志写入校验失败。');
    this.sequence = sequence;
  }
  private objectPath(sha: string): string {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('无效的恢复对象标识。');
    return `${this.root}/objects/${sha.slice(0, 2)}/${sha}`;
  }
  async put(data: Uint8Array): Promise<string> {
    const id = blobHash(data), path = this.objectPath(id);
    if (await this.fs.exists(path)) {
      const existing = new Uint8Array(await this.fs.readBinary(path));
      if (blobHash(existing) === id) return id;
    }
    await mkdirs(this.fs, path.slice(0, path.lastIndexOf('/')));
    await this.fs.writeBinary(path, arrayBuffer(data));
    // Do not journal an object until it has been read back and verified.
    const verify = new Uint8Array(await this.fs.readBinary(path));
    if (blobHash(verify) !== id) throw new Error('恢复副本写入校验失败。');
    return id;
  }
  async get(id: string): Promise<Uint8Array | null> {
    const path = this.objectPath(id);
    if (!await this.fs.exists(path)) return null;
    const data = new Uint8Array(await this.fs.readBinary(path));
    if (blobHash(data) !== id) throw new Error('本地恢复副本校验失败，已停止写入。');
    return data;
  }
}

// Used by tests and data export; these always use explicit UTF-8.
export const stateBytes = (state: SyncState): Uint8Array => encode(JSON.stringify(state));
export const parseStateBytes = (bytes: Uint8Array): unknown => JSON.parse(decode(bytes));
