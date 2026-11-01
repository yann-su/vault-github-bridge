import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/engine';
import { blobHash, encode } from '../src/model';
import { MemoryFS, MemoryLocal, MemoryRemote, MemoryStore, scope } from './helpers';
import { DiskStateStore } from '../src/storage';

function fixture() {
  const remote = new MemoryRemote({ 'a.md': 'remote', 'new.md': 'download' });
  const local = new MemoryLocal({ 'a.md': 'local', 'only.md': 'keep in backup', '.obsidian/workspace.json': 'local layout' });
  const store = new MemoryStore(), engine = new SyncEngine(local, remote, store, 'force-test', scope);
  return { remote, local, store, engine };
}
test('API force preview is read-only and lists add/overwrite/delete', async () => {
  const f = fixture(), plan = await f.engine.previewForceRemote();
  assert.deepEqual(plan.changes.map(c => [c.path, c.before === null ? 'add' : c.target === null ? 'delete' : 'overwrite']), [['a.md', 'overwrite'], ['new.md', 'add'], ['only.md', 'delete']]);
  assert.equal(f.local.text('a.md'), 'local'); assert.equal(f.store.value, null); assert.equal(f.remote.publications, 0);
});
test('API force adopts remote, retains a complete backup and never publishes discarded content later', async () => {
  const f = fixture(), head = f.remote.head;
  const result = await f.engine.forceRemote(await f.engine.previewForceRemote());
  assert.equal(f.local.text('a.md'), 'remote'); assert.equal(f.local.text('new.md'), 'download'); assert.equal(f.local.text('only.md'), null);
  assert.equal(f.local.text('.obsidian/workspace.json'), 'local layout'); assert.equal(f.remote.head, head); assert.equal(f.remote.publications, 0);
  const backup = JSON.parse(new TextDecoder().decode((await f.store.get(result.backup))!));
  for (const file of backup.files) assert.ok(await f.store.get(file.sha));
  assert.equal(new TextDecoder().decode((await f.store.get(backup.files.find((v: { path: string }) => v.path === 'only.md').sha))!), 'keep in backup');
  const state = await f.engine.inspect(); assert.equal(state.forceBackups?.[0]?.id, result.backup); assert.equal(state.forceRemote, undefined);
  await f.engine.run(); assert.equal(f.remote.publications, 0); assert.equal(f.local.text('only.md'), null);
});
test('API force works in receive-only mode and resolves existing conflicts', async () => {
  const f = fixture(); await f.engine.approve(); await f.engine.run();
  assert.ok((await f.engine.inspect()).conflicts.length > 0);
  const receiver = new SyncEngine(f.local, f.remote, f.store, 'force-test', scope, true);
  const before = f.remote.head; await receiver.forceRemote(await receiver.previewForceRemote());
  assert.equal((await receiver.inspect()).conflicts.length, 0); assert.equal(f.remote.head, before);
});
test('API stale local or remote reviews are rejected before changing files', async () => {
  const f = fixture(), first = await f.engine.previewForceRemote();
  f.local.set('a.md', 'new typing'); await assert.rejects(f.engine.forceRemote(first), /重新预览/);
  assert.equal(f.local.text('a.md'), 'new typing'); assert.equal(f.store.value, null);
  const second = await f.engine.previewForceRemote(); await f.remote.edit('new.md', 'new remote');
  await assert.rejects(f.engine.forceRemote(second), /重新预览/); assert.equal(f.local.text('new.md'), null);
});
test('API interrupted force retains backups, blocks ordinary uploads, and can be reviewed again', async () => {
  const f = fixture(), plan = await f.engine.previewForceRemote();
  f.local.failAfterApply = true; await assert.rejects(f.engine.forceRemote(plan), /simulated crash/);
  assert.ok((await f.engine.inspect()).forceRemote);
  await assert.rejects(f.engine.run(), /强制采用远端尚未完成/); assert.equal(f.remote.publications, 0);
  const backup = (await f.engine.inspect()).forceBackups![0]!;
  assert.ok(await f.store.get(backup.id));
  await f.engine.forceRemote(await f.engine.previewForceRemote());
  await f.engine.run(); assert.equal(f.remote.publications, 0); assert.equal(f.local.text('only.md'), null);
});
test('API edits during apply are retained and prevent partial results from being uploaded', async () => {
  const f = fixture();
  f.local.beforeApply = path => { if (path === 'a.md') f.local.set(path, 'typing during force'); };
  await assert.rejects(f.engine.forceRemote(await f.engine.previewForceRemote()), /笔记被编辑/);
  assert.equal(f.local.text('a.md'), 'typing during force'); await assert.rejects(f.engine.run(), /强制采用远端尚未完成/);
  assert.equal(f.remote.publications, 0);
});
test('API backup checkpoint failure prevents any file change', async () => {
  const f = fixture(), plan = await f.engine.previewForceRemote(); f.store.failSaveAt = 1;
  await assert.rejects(f.engine.forceRemote(plan), /checkpoint failure/);
  assert.equal(f.local.text('a.md'), 'local'); assert.equal(f.local.text('only.md'), 'keep in backup');
  assert.equal(f.remote.publications, 0);
});
test('API force preserves binary bytes and excludes folders', async () => {
  const f = fixture(); f.local.files.set('picture.png', new Uint8Array([0, 255, 2]));
  const specific = { ...scope, excludedFolders: ['private'] }; f.local.set('private/local.md', 'private');
  const engine = new SyncEngine(f.local, f.remote, f.store, 'filtered', specific);
  const result = await engine.forceRemote(await engine.previewForceRemote());
  assert.equal(f.local.text('private/local.md'), 'private'); assert.equal(f.local.files.has('picture.png'), false);
  assert.deepEqual(await f.store.get(blobHash(new Uint8Array([0, 255, 2]))), new Uint8Array([0, 255, 2]));
  assert.ok(await f.store.get(result.backup)); assert.equal(blobHash(encode('remote')), (await engine.inspect()).bases['a.md']);
});
test('API force journal and complete backup references survive a persistent-store restart', async () => {
  const f = fixture(), fs = new MemoryFS();
  const first = new SyncEngine(f.local, f.remote, new DiskStateStore(fs, 'cache', 'disk-force'), 'disk-force', scope);
  const plan = await first.previewForceRemote(); f.local.failAfterApply = true;
  await assert.rejects(first.forceRemote(plan), /simulated crash/);
  const next = new SyncEngine(f.local, f.remote, new DiskStateStore(fs, 'cache', 'disk-force'), 'disk-force', scope);
  await assert.rejects(next.run(), /强制采用远端尚未完成/);
  const backup = (await next.inspect()).forceBackups![0]!;
  assert.ok(await next.cached(backup.id));
  await next.forceRemote(await next.previewForceRemote()); await next.run();
  assert.equal(f.remote.publications, 0); assert.equal((await next.inspect()).forceBackups!.length, 2);
});
test('API force explicitly reviews bulk deletion when the remote note tree is empty', async () => {
  const remote = new MemoryRemote(), local = new MemoryLocal(Object.fromEntries(Array.from({ length: 13 }, (_, n) => [`note-${n}.md`, 'local'])));
  const store = new MemoryStore(), engine = new SyncEngine(local, remote, store, 'empty', scope);
  const plan = await engine.previewForceRemote(); assert.equal(plan.changes.filter(c => c.target === null).length, 13);
  const result = await engine.forceRemote(plan);
  assert.equal(local.files.size, 0); assert.equal(remote.publications, 0);
  assert.equal(JSON.parse(new TextDecoder().decode((await store.get(result.backup))!)).files.length, 13);
});
test('an older valid checkpoint also blocks uploads if the latest force checkpoint is corrupted', async () => {
  const f = fixture(), fs = new MemoryFS();
  const engine = new SyncEngine(f.local, f.remote, new DiskStateStore(fs, 'cache', 'torn-force'), 'torn-force', scope);
  await engine.approve(); await engine.run(); const publications = f.remote.publications;
  f.local.failAfterApply = true; await assert.rejects(engine.forceRemote(await engine.previewForceRemote()), /simulated crash/);
  const slots = await Promise.all([0, 1].map(async n => ({ path: `cache/state-${n}.json`, data: JSON.parse(await fs.read(`cache/state-${n}.json`)) })));
  slots.sort((a, b) => b.data.sequence - a.data.sequence); await fs.write(slots[0]!.path, 'corrupt');
  const restarted = new SyncEngine(f.local, f.remote, new DiskStateStore(fs, 'cache', 'torn-force'), 'torn-force', scope);
  await assert.rejects(restarted.run(), /强制采用远端尚未完成/); assert.equal(f.remote.publications, publications);
});
