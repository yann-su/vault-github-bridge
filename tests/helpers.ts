import { blobHash, encode, hashText, newState, type Hash, type LocalPort, type RemotePort, type RemoteSnapshot, type Scope, type StatePort, type SyncState } from '../src/model';
import { SyncEngine } from '../src/engine';
import { GitHubError } from '../src/github';
import type { StorageFS } from '../src/storage';

export const scope: Scope = { extensions: ['md', 'png', 'canvas'], excludedFolders: [], maxBytes: 1024 * 1024, configDir: '.obsidian' };
export class MemoryStore implements StatePort {
  value: string | null = null;
  objects = new Map<string, Uint8Array>();
  saves = 0;
  failSaveAt = -1;
  async load(): Promise<SyncState | null> { return this.value ? JSON.parse(this.value) : null; }
  async save(state: SyncState): Promise<void> {
    if (++this.saves === this.failSaveAt) throw new Error('simulated checkpoint failure');
    this.value = JSON.stringify(state);
  }
  async put(data: Uint8Array): Promise<string> { const id = blobHash(data); this.objects.set(id, data.slice()); return id; }
  async get(id: string): Promise<Uint8Array | null> { return this.objects.get(id)?.slice() ?? null; }
}
export class MemoryLocal implements LocalPort {
  files = new Map<string, Uint8Array>();
  beforeApply?: (path: string) => void;
  failAfterApply = false;
  constructor(files: Record<string, string> = {}) { for (const [path, text] of Object.entries(files)) this.set(path, text); }
  set(path: string, text: string): void { this.files.set(path, encode(text)); }
  text(path: string): string | null { const value = this.files.get(path); return value ? new TextDecoder().decode(value) : null; }
  async list() { return [...this.files].map(([path, data]) => ({ path, size: data.length })); }
  async read(path: string) { return this.files.get(path)?.slice() ?? null; }
  async apply(path: string, expected: Hash, data: Uint8Array | null) {
    this.beforeApply?.(path);
    const current = this.files.get(path), hash = current ? blobHash(current) : null;
    if (hash !== expected) return false;
    if (data === null) this.files.delete(path); else this.files.set(path, data.slice());
    if (this.failAfterApply) { this.failAfterApply = false; throw new Error('simulated crash after filesystem write'); }
    return true;
  }
}
interface Commit { parent: string | null; files: Map<string, string> }
export class MemoryRemote implements RemotePort {
  commits = new Map<string, Commit>();
  objects = new Map<string, Uint8Array>();
  head: string;
  publications = 0;
  beforeAdvance?: () => Promise<void>;
  loseResponse = false;
  offline = false;
  constructor(files: Record<string, string> = {}) {
    const map = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) { const bytes = encode(text), sha = blobHash(bytes); this.objects.set(sha, bytes); map.set(path, sha); }
    this.head = hashText('initial'); this.commits.set(this.head, { parent: null, files: map });
  }
  async snapshot(): Promise<RemoteSnapshot> {
    if (this.offline) throw new Error('offline');
    return { head: this.head, tree: this.head, files: new Map(this.commits.get(this.head)!.files) };
  }
  async blob(id: string) { const data = this.objects.get(id); if (!data) throw new Error('missing blob'); return data.slice(); }
  async prepare(snapshot: RemoteSnapshot, changes: Array<{ path: string; data: Uint8Array | null }>) {
    if (this.offline) throw new Error('offline');
    const files = new Map(this.commits.get(snapshot.head)!.files);
    for (const { path, data } of changes) {
      if (data === null) files.delete(path);
      else { const sha = blobHash(data); this.objects.set(sha, data.slice()); files.set(path, sha); }
    }
    const id = hashText(`${snapshot.head}:${this.commits.size}:${JSON.stringify([...files])}`);
    this.commits.set(id, { parent: snapshot.head, files }); return id;
  }
  async advance(candidate: string) {
    const hook = this.beforeAdvance; this.beforeAdvance = undefined; await hook?.();
    if (this.offline) throw new Error('offline');
    if (this.commits.get(candidate)?.parent !== this.head) throw new GitHubError('non-fast-forward', 409);
    this.head = candidate; this.publications++;
    if (this.loseResponse) { this.loseResponse = false; throw new Error('lost response'); }
  }
  async contains(candidate: string, head: string): Promise<boolean> {
    if (this.offline) throw new Error('offline');
    let current: string | null = head;
    while (current) { if (current === candidate) return true; current = this.commits.get(current)?.parent ?? null; }
    return false;
  }
  async edit(path: string, text: string | null) {
    const candidate = await this.prepare(await this.snapshot(), [{ path, data: text === null ? null : encode(text) }]);
    await this.advance(candidate);
  }
  text(path: string): string | null {
    const sha = this.commits.get(this.head)!.files.get(path);
    return sha ? new TextDecoder().decode(this.objects.get(sha)) : null;
  }
}
export async function device(remote: MemoryRemote, files: Record<string, string> = {}, readOnly = false) {
  const local = new MemoryLocal(files), store = new MemoryStore();
  const state = newState('test'); state.approved = true; await store.save(state);
  const create = () => new SyncEngine(local, remote, store, 'test', scope, readOnly);
  return { local, store, create, engine: create() };
}
export class MemoryFS implements StorageFS {
  files = new Map<string, Uint8Array>();
  folders = new Set<string>();
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async mkdir(path: string) { this.folders.add(path); }
  async read(path: string) { return new TextDecoder().decode(await this.readBinary(path)); }
  async write(path: string, value: string) { this.files.set(path, encode(value)); }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path); if (!value) throw new Error('ENOENT'); return value.slice().buffer as ArrayBuffer;
  }
  async writeBinary(path: string, value: ArrayBuffer) { this.files.set(path, new Uint8Array(value).slice()); }
}
