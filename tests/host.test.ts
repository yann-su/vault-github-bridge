import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { blobHash, encode } from '../src/model';
import { MemoryFS, MemoryStore } from './helpers';

// Compile the real adapter against a narrow Obsidian API contract. This is not
// a substitute for real-device testing, but exercises its stale-write guards.
const result = await build({
  stdin: { contents: "export { ObsidianLocal } from './src/obsidian-local'; export { TFile } from 'obsidian';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  alias: { obsidian: `${process.cwd()}/tests/obsidian-shim.ts` }
});
const code = result.outputFiles[0]!.text;
const host = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function setup() {
  const fs = new MemoryFS(), cache = new MemoryStore();
  const files = new Map<string, any>();
  let processRace: (() => Promise<void>) | undefined;
  let focused = false, active: string | null = null, editorValue = 'active editor';
  const vault: any = {
    adapter: fs,
    getFiles: () => [...files.values()].filter(f => f instanceof host.TFile),
    getAbstractFileByPath: (p: string) => files.get(p) ?? null,
    createFolder: async (p: string) => { await fs.mkdir(p); files.set(p, { path: p, children: [] }); },
    createBinary: async (p: string, bytes: ArrayBuffer) => { if (await fs.exists(p)) throw new Error('exists'); await fs.writeBinary(p, bytes); files.set(p, new host.TFile(p)); },
    process: async (f: any, fn: (v: string) => string) => { await processRace?.(); await fs.write(f.path, fn(await fs.read(f.path))); },
    modifyBinary: async (f: any, bytes: ArrayBuffer) => fs.writeBinary(f.path, bytes),
    trash: async (f: any) => { fs.files.delete(f.path); files.delete(f.path); }
  };
  const app = { vault, workspace: { getActiveViewOfType: () => active ? { file: { path: active }, editor: { hasFocus: () => focused, getValue: () => editorValue } } : null } };
  const local = new host.ObsidianLocal(app, cache);
  const set = async (path: string, text: string) => { await fs.write(path, text); files.set(path, new host.TFile(path)); };
  return { fs, cache, local, set, race: (cb: () => Promise<void>) => { processRace = cb; }, active: (path: string, value: boolean, text = 'active editor') => { active = path; focused = value; editorValue = text; } };
}
test('real Obsidian adapter process guard refuses a write racing with newer text', async () => {
  const d = setup(); await d.set('a.md', 'base'); d.race(() => d.fs.write('a.md', 'new typing'));
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), encode('remote')), false);
  assert.equal(await d.fs.read('a.md'), 'new typing');
});
test('real Obsidian adapter defers a focused active editor', async () => {
  const d = setup(); await d.set('a.md', 'base'); d.active('a.md', true);
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), encode('remote')), false);
  assert.equal(await d.fs.read('a.md'), 'base');
});
test('real Obsidian adapter updates unchanged text through Vault.process', async () => {
  const d = setup(); await d.set('a.md', 'base');
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), encode('remote')), true);
  assert.equal(await d.fs.read('a.md'), 'remote'); assert.ok(d.cache.objects.has(blobHash(encode('base'))));
});
test('real Obsidian adapter never replaces an unexpected existing file', async () => {
  const d = setup(); await d.set('a.md', 'existing');
  assert.equal(await d.local.apply('a.md', null, encode('download')), false);
  assert.equal(await d.fs.read('a.md'), 'existing');
});
test('real Obsidian adapter preserves bytes before deletion', async () => {
  const d = setup(); await d.set('a.md', 'base');
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), null), true);
  assert.equal(await d.fs.exists('a.md'), false); assert.ok(d.cache.objects.has(blobHash(encode('base'))));
});
test('real Obsidian adapter creates nested new files', async () => {
  const d = setup(); assert.equal(await d.local.apply('folder/a.md', null, encode('download')), true);
  assert.equal(await d.fs.read('folder/a.md'), 'download'); assert.ok(d.fs.folders.has('folder'));
});
test('confirmed force can update a saved focused editor through Vault.process', async () => {
  const d = setup(); await d.set('a.md', 'base'); d.active('a.md', true, 'base');
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), encode('remote'), true), true);
  assert.equal(await d.fs.read('a.md'), 'remote');
});
test('confirmed force still refuses new unsaved editor text', async () => {
  const d = setup(); await d.set('a.md', 'base'); d.active('a.md', true, 'new unsaved typing');
  assert.equal(await d.local.apply('a.md', blobHash(encode('base')), encode('remote'), true), false);
  assert.equal(await d.fs.read('a.md'), 'base');
});
