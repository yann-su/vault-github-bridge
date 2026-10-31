import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex } from '@noble/hashes/utils';

export type Hash = string | null;
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decode = (data: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(data);
export function blobHash(data: Uint8Array): string {
  const header = encode(`blob ${data.byteLength}\0`);
  const input = new Uint8Array(header.length + data.length);
  input.set(header); input.set(data, header.length);
  return bytesToHex(sha1(input));
}
export const hashText = (text: string): string => blobHash(encode(text));

export interface Scope {
  extensions: string[];
  excludedFolders: string[];
  maxBytes: number;
  configDir: string;
}
export const DEFAULT_EXTENSIONS = ['md', 'canvas', 'base', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'];
export function safePath(path: string): boolean {
  return path.length > 0 && path === path.normalize('NFC') && !path.includes('\\') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
      !/[\x00-\x1f<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function inScope(path: string, scope: Scope): boolean {
  const parts = path.split('/');
  if (parts.some(part => part.startsWith('.'))) return false;
  if ([scope.configDir, ...scope.excludedFolders].some(folder => folder && (path === folder || path.startsWith(folder + '/')))) return false;
  return scope.extensions.includes((parts.at(-1)?.split('.').at(-1) ?? '').toLowerCase());
}
export function validatePaths(paths: Iterable<string>): void {
  const all = new Set(paths);
  const used = new Map<string, string>();
  for (const path of all) {
    if (!safePath(path)) throw new Error(`路径无法在所有平台安全使用：${path}。请重命名或排除。`);
    // Check directory components too: Foo/a.md and foo/b.md collide on Windows/macOS.
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/');
      const key = prefix.toLocaleLowerCase('en-US');
      const existing = used.get(key);
      if (existing && existing !== prefix) throw new Error(`存在大小写冲突：${existing} / ${prefix}。请先重命名。`);
      used.set(key, prefix);
    }
  }
  for (const path of all) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) {
      if (all.has(parts.slice(0, n).join('/'))) throw new Error(`文件与文件夹路径冲突：${path}`);
    }
  }
}

export interface Conflict { path: string; base?: Hash; local: Hash; remote: Hash; detectedAt: string }
export interface Resolution { local: Hash; remote: Hash; choice: 'local' | 'remote' }
export interface Operation { path: string; kind: 'push' | 'pull' | 'adopt'; before: Hash; target: Hash }
export interface DeletionItem { path: string; kind: 'push' | 'pull'; local: Hash; remote: Hash }
export interface DeletionReview { items: DeletionItem[] }
export interface Plan { operations: Operation[]; conflicts: Conflict[]; deletionReview?: DeletionReview }
export interface HistoryEntry { path: string; sha: string; at: string; reason: string }
export interface Pending {
  remoteHead: string;
  candidate: string | null;
  operations: Operation[];
}
export interface SyncState {
  schema: 1;
  binding: string;
  approved: boolean;
  bases: Record<string, Hash>;
  conflicts: Conflict[];
  resolutions: Record<string, Resolution>;
  history: HistoryEntry[];
  pending?: Pending;
  lastSync?: string;
  lastHead?: string;
  deletionApproval?: DeletionItem[];
}
export function newState(binding: string): SyncState {
  return { schema: 1, binding, approved: false, bases: Object.create(null), conflicts: [], resolutions: Object.create(null), history: [] };
}

export function planSync(
  bases: Record<string, Hash>, local: Map<string, string>, remote: Map<string, string>,
  resolutions: Record<string, Resolution> = {}, readOnly = false
): Plan {
  const operations: Operation[] = [];
  const conflicts: Conflict[] = [];
  for (const path of [...new Set([...Object.keys(bases), ...local.keys(), ...remote.keys()])].sort()) {
    const l = local.get(path) ?? null, r = remote.get(path) ?? null;
    const known = Object.hasOwn(bases, path), b = known ? bases[path] : undefined;
    const resolution = resolutions[path];
    let kind: Operation['kind'] | undefined;
    if (l === r) { if (!known || b !== l) kind = 'adopt'; else continue; }
    else if (resolution && resolution.local === l && resolution.remote === r) {
      if (resolution.choice === 'remote') kind = 'pull';
      else if (!readOnly) kind = 'push';
    } else if (!known) {
      if (l === null) kind = 'pull';
      else if (r === null && !readOnly) kind = 'push';
    } else if (l === b) kind = 'pull';
    else if (r === b) { if (!readOnly) kind = 'push'; }
    if (kind) operations.push({ path, kind, before: l, target: kind === 'push' ? l : r });
    else if (!(readOnly && (r === b || (!known && r === null)))) {
      conflicts.push({ path, base: b, local: l, remote: r, detectedAt: new Date().toISOString() });
    }
  }
  return { operations, conflicts };
}

export interface RemoteSnapshot { head: string; tree: string; files: Map<string, string> }
export interface RemotePort {
  snapshot(): Promise<RemoteSnapshot>;
  blob(sha: string): Promise<Uint8Array>;
  prepare(snapshot: RemoteSnapshot, changes: Array<{ path: string; data: Uint8Array | null }>): Promise<string>;
  advance(candidate: string): Promise<void>;
  contains(candidate: string, head: string): Promise<boolean>;
}
export interface LocalPort {
  list(): Promise<Array<{ path: string; size: number }>>;
  read(path: string): Promise<Uint8Array | null>;
  /** Must reject stale writes and preserve data before destructive changes. */
  apply(path: string, expected: Hash, data: Uint8Array | null): Promise<boolean>;
}
export interface StatePort {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
  put(data: Uint8Array): Promise<string>;
  get(sha: string): Promise<Uint8Array | null>;
}
