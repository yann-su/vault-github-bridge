import { App, MarkdownView, TFile, type Vault } from 'obsidian';
import { blobHash, decode, encode, type Hash, type LocalPort, type StatePort } from './model';
import { arrayBuffer } from './storage';

export async function ensureVaultFolder(vault: Vault, path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    const item = vault.getAbstractFileByPath(current);
    if (item instanceof TFile) throw new Error(`文件占用了目录路径：${current}`);
    if (!item) await vault.createFolder(current);
  }
}

export class ObsidianLocal implements LocalPort {
  constructor(private app: App, private cache: StatePort) {}
  async list(): Promise<Array<{ path: string; size: number }>> {
    return this.app.vault.getFiles().map(file => ({ path: file.path, size: file.stat.size }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(path)) return null;
    return new Uint8Array(await adapter.readBinary(path));
  }
  async apply(path: string, expected: Hash, data: Uint8Array | null): Promise<boolean> {
    const vault = this.app.vault;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    // Never replace the active editor, including text not yet flushed to the filesystem.
    if (view?.file?.path === path && (view.editor.hasFocus() || data === null)) return false;
    const before = await this.read(path), actual = before === null ? null : blobHash(before);
    if (actual !== expected) return false;
    if (before) await this.cache.put(before);
    let file = vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw new Error(`目标路径不是文件：${path}`);
    if (expected === null) {
      if (file || await vault.adapter.exists(path)) return false;
      if (data === null) return true;
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (path.includes('/')) await ensureVaultFolder(vault, parent);
      // createBinary rejects an existing path instead of replacing it.
      await vault.createBinary(path, arrayBuffer(data));
      return true;
    }
    if (!(file instanceof TFile)) return false;
    if (data !== null && /\.(md|canvas|base|svg)$/i.test(path)) {
      const replacement = decode(data);
      let accepted = false;
      await vault.process(file, current => {
        if (blobHash(encode(current)) !== expected) return current;
        if (view?.file?.path === path && blobHash(encode(view.editor.getValue())) !== expected) return current;
        accepted = true;
        return replacement;
      });
      return accepted;
    }
    // Obsidian has no binary compare-and-swap API. Keep the verified previous
    // object, then check again immediately before the guarded destructive call.
    const latest = await this.read(path);
    if (latest === null || blobHash(latest) !== expected) return false;
    file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    if (data === null) await vault.trash(file, false);
    else await vault.modifyBinary(file, arrayBuffer(data));
    return true;
  }
}
