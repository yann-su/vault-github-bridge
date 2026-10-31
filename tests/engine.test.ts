import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobHash, encode, newState, planSync, safePath, validatePaths } from '../src/model';
import { DiskStateStore } from '../src/storage';
import { SyncEngine } from '../src/engine';
import { device, MemoryFS, MemoryLocal, MemoryRemote, MemoryStore, scope } from './helpers';

test('Git blob hashes match Git including empty, binary and UTF-8 content', () => {
  assert.equal(blobHash(encode('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(blobHash(encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.notEqual(blobHash(new Uint8Array([0, 255])), blobHash(encode('0,255')));
});
test('first connection needs explicit approval and preview does not publish', async () => {
  const remote = new MemoryRemote(), store = new MemoryStore(), local = new MemoryLocal({ 'a.md': 'hello' });
  const engine = new SyncEngine(local, remote, store, 'test', scope);
  assert.equal((await engine.preview()).operations[0]?.kind, 'push');
  assert.equal(remote.publications, 0);
  await assert.rejects(engine.run(), /预览/);
  await engine.approve(); await engine.run(); assert.equal(remote.text('a.md'), 'hello');
});
test('new empty device downloads existing vault without propagating deletions', async () => {
  const remote = new MemoryRemote({ 'a.md': 'A', 'folder/b.md': 'B' });
  const d = await device(remote); await d.engine.run();
  assert.equal(d.local.text('a.md'), 'A'); assert.equal(d.local.text('folder/b.md'), 'B');
  assert.equal(remote.publications, 0);
});
test('initial unrelated contents with same path remain a conflict', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' });
  const result = await d.engine.run(); assert.equal(result.conflicts, 1);
  assert.equal(remote.text('a.md'), 'remote'); assert.equal(d.local.text('a.md'), 'local');
  assert.equal((await d.engine.inspect()).bases['a.md'], undefined);
});
test('offline edits move through GitHub to another device with one batch commit', async () => {
  const remote = new MemoryRemote(), a = await device(remote, { 'a.md': 'A', 'b.md': 'B' });
  await a.engine.run(); assert.equal(remote.publications, 1);
  const b = await device(remote); await b.engine.run(); b.local.set('a.md', 'phone');
  await b.engine.run(); await a.engine.run(); assert.equal(a.local.text('a.md'), 'phone');
  assert.equal(a.local.text('b.md'), 'B');
});
test('same file edited on two devices is preserved; other files still sync', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), a = await device(remote), b = await device(remote);
  await a.engine.run(); await b.engine.run(); a.local.set('a.md', 'A'); b.local.set('a.md', 'B'); b.local.set('new.md', 'new');
  await a.engine.run(); const result = await b.engine.run();
  assert.equal(result.conflicts, 1); assert.equal(remote.text('a.md'), 'A'); assert.equal(b.local.text('a.md'), 'B');
  assert.equal(remote.text('new.md'), 'new');
  const conflict = (await b.engine.inspect()).conflicts[0]!;
  assert.equal(new TextDecoder().decode(await b.engine.cached(conflict.base ?? null)), 'base');
});
test('simultaneous uploads on different files retry safely after non-fast-forward', async () => {
  const remote = new MemoryRemote({ 'a.md': 'a', 'b.md': 'b' }), a = await device(remote), b = await device(remote);
  await a.engine.run(); await b.engine.run(); a.local.set('a.md', 'A'); b.local.set('b.md', 'B');
  remote.beforeAdvance = async () => { await b.engine.run(); };
  await a.engine.run(); assert.equal(remote.text('a.md'), 'A'); assert.equal(remote.text('b.md'), 'B');
  await b.engine.run(); assert.equal(b.local.text('a.md'), 'A');
});
test('simultaneous uploads on same file become conflict instead of overwrite', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), a = await device(remote), b = await device(remote);
  await a.engine.run(); await b.engine.run(); a.local.set('a.md', 'A'); b.local.set('a.md', 'B');
  remote.beforeAdvance = async () => { await b.engine.run(); };
  const result = await a.engine.run(); assert.equal(result.conflicts, 1);
  assert.equal(remote.text('a.md'), 'B'); assert.equal(a.local.text('a.md'), 'A');
});
test('remote deletion propagates when local was unchanged', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run();
  await remote.edit('a.md', null); await d.engine.run(); assert.equal(d.local.text('a.md'), null);
  assert.ok((await d.engine.inspect()).history.some(h => h.sha === blobHash(encode('base'))));
});
test('local deletion and remote edit conflict, without recreating or deleting either side', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run();
  d.local.files.delete('a.md'); await remote.edit('a.md', 'remote edit');
  assert.equal((await d.engine.run()).conflicts, 1); assert.equal(d.local.text('a.md'), null);
  assert.equal(remote.text('a.md'), 'remote edit');
});
test('old offline device does not resurrect a remotely deleted file', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), a = await device(remote), b = await device(remote);
  await a.engine.run(); await b.engine.run(); a.local.files.delete('a.md'); await a.engine.run(); await b.engine.run();
  assert.equal(remote.text('a.md'), null); assert.equal(b.local.text('a.md'), null);
});
test('local edit against remote deletion remains recoverable conflict', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run();
  d.local.set('a.md', 'offline edit'); await remote.edit('a.md', null);
  assert.equal((await d.engine.run()).conflicts, 1); assert.equal(d.local.text('a.md'), 'offline edit');
});
test('lost upload response is reconciled without duplicate publication', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'a.md': 'A' }); remote.loseResponse = true;
  await d.engine.run(); await d.engine.run(); assert.equal(remote.publications, 1);
  assert.equal((await d.engine.inspect()).pending, undefined);
});
test('published commit survives response loss followed by network outage and restart', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'a.md': 'A' });
  const original = remote.advance.bind(remote);
  remote.advance = async candidate => { await original(candidate); remote.offline = true; throw new Error('connection lost'); };
  await assert.rejects(d.engine.run(), /offline/);
  assert.ok((await d.engine.inspect()).pending?.candidate);
  remote.advance = original; remote.offline = false;
  await d.create().run(); assert.equal(remote.publications, 1); assert.equal(remote.text('a.md'), 'A');
});
test('filesystem write followed by crash replays journal idempotently', async () => {
  const remote = new MemoryRemote({ 'a.md': 'A', 'b.md': 'B' }), d = await device(remote);
  d.local.failAfterApply = true; await assert.rejects(d.engine.run(), /simulated crash/);
  assert.ok((await d.engine.inspect()).pending);
  await d.create().run(); assert.equal(d.local.text('a.md'), 'A'); assert.equal(d.local.text('b.md'), 'B');
  assert.equal((await d.create().inspect()).pending, undefined);
});
test('checkpoint failure before publication leaves all source files intact', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'a.md': 'A' });
  d.store.failSaveAt = d.store.saves + 1; await assert.rejects(d.engine.run(), /checkpoint/);
  assert.equal(remote.publications, 0); assert.equal(d.local.text('a.md'), 'A');
  d.store.failSaveAt = -1; await d.engine.run(); assert.equal(remote.text('a.md'), 'A');
});
test('edit while uploading remains pending and is uploaded next time', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'a.md': 'snapshot' });
  remote.beforeAdvance = async () => { d.local.set('a.md', 'continued typing'); };
  await d.engine.run(); assert.equal(remote.text('a.md'), 'snapshot'); assert.equal(d.local.text('a.md'), 'continued typing');
  await d.engine.run(); assert.equal(remote.text('a.md'), 'continued typing');
});
test('edit during download is not overwritten and retains the true common base', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run(); await remote.edit('a.md', 'remote');
  d.local.beforeApply = () => { d.local.set('a.md', 'typing'); };
  const result = await d.engine.run(); assert.equal(result.deferred, 1); assert.equal(d.local.text('a.md'), 'typing');
  d.local.beforeApply = undefined; assert.equal((await d.engine.run()).conflicts, 1);
  assert.equal((await d.engine.inspect()).bases['a.md'], blobHash(encode('base')));
});
test('keep local conflict resolution produces a normal new commit', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' }); await d.engine.run();
  await d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'local'); await d.engine.run();
  assert.equal(remote.text('a.md'), 'local'); assert.equal((await d.engine.inspect()).conflicts.length, 0);
});
test('keep remote resolution preserves previous local content in history', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' }); await d.engine.run();
  await d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'remote'); await d.engine.run();
  assert.equal(d.local.text('a.md'), 'remote'); assert.ok((await d.engine.inspect()).history.some(h => h.sha === blobHash(encode('local'))));
});
test('stale resolution cannot overwrite a newer remote edit', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' }); await d.engine.run();
  await d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'local'); await remote.edit('a.md', 'new remote');
  assert.equal((await d.engine.run()).conflicts, 1); assert.equal(remote.text('a.md'), 'new remote');
});
test('stale resolution cannot overwrite newer local typing', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' }); await d.engine.run();
  await d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'remote'); d.local.set('a.md', 'new local');
  assert.equal((await d.engine.run()).conflicts, 1); assert.equal(d.local.text('a.md'), 'new local');
});
test('read-only mode downloads updates, never publishes local-only files or changes', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote, { 'own.md': 'local only' }, true);
  await d.engine.run(); d.local.set('a.md', 'local edit'); await d.engine.run();
  assert.equal(remote.publications, 0); assert.equal(d.local.text('own.md'), 'local only');
  await remote.edit('a.md', 'remote edit'); assert.equal((await d.engine.run()).conflicts, 1);
  await assert.rejects(d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'local'), /只更新/);
});
test('ignored files and hidden configuration never upload', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { '.obsidian/plugins/x/data.json': 'token', '.hidden/a.md': 'hidden', 'movie.mp4': 'big', 'a.md': 'A' });
  await d.engine.run(); assert.deepEqual([...remote.commits.get(remote.head)!.files.keys()], ['a.md']);
});
test('oversized local file aborts the batch before any publication', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'large.md': 'x'.repeat(scope.maxBytes + 1), 'a.md': 'A' });
  await assert.rejects(d.engine.run(), /大小限制/); assert.equal(remote.publications, 0);
});
test('case collisions across devices abort safely', async () => {
  const remote = new MemoryRemote({ 'A.md': 'A' }), d = await device(remote, { 'a.md': 'a' });
  await assert.rejects(d.engine.run(), /大小写冲突/); assert.equal(remote.publications, 0);
});
test('file-directory collisions and unsafe Windows names are rejected', () => {
  for (const p of ['../a.md', '/a.md', 'x\\a.md', 'a:bad.md', 'CON.md', 'folder./a.md']) assert.equal(safePath(p), false);
  assert.equal(safePath('笔记/学习.md'), true);
  assert.throws(() => validatePaths(new Map([['a.md', 'x'], ['a.md/b.md', 'y']]).keys()), /文件与文件夹/);
  assert.throws(() => validatePaths(['Foo/a.md', 'foo/b.md']), /大小写冲突/);
});
test('unchanged vault produces no commit and no per-file operations', () => {
  const id = blobHash(encode('A'));
  assert.deepEqual(planSync({ 'a.md': id }, new Map([['a.md', id]]), new Map([['a.md', id]])).operations, []);
});
test('binary attachments round-trip byte for byte', async () => {
  const remote = new MemoryRemote(), a = await device(remote); a.local.files.set('image.png', new Uint8Array([0, 1, 255, 128]));
  await a.engine.run(); const b = await device(remote); await b.engine.run();
  assert.deepEqual(await b.local.read('image.png'), new Uint8Array([0, 1, 255, 128]));
});
test('cancelled engine leaves sources intact', async () => {
  const remote = new MemoryRemote(), d = await device(remote, { 'a.md': 'A' }); d.engine.cancel();
  await assert.rejects(d.engine.run(), /停止/); assert.equal(remote.publications, 0);
});
test('large first import makes durable progress in bounded batches', async () => {
  const remote = new MemoryRemote(), files = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`note-${i}.md`, `note ${i}`]));
  const d = await device(remote, files);
  const first = await d.engine.run(); assert.equal(first.uploaded, 25); assert.equal(first.deferred, 36);
  assert.equal(Object.keys((await d.engine.inspect()).bases).length, 25);
  await d.create().run(); const last = await d.create().run();
  assert.equal(last.deferred, 0); assert.equal(remote.commits.get(remote.head)!.files.size, 61);
});
test('rewritten branch history stops sync without pushing or replacing files', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run();
  await remote.edit('a.md', 'new'); await d.engine.run();
  remote.head = [...remote.commits.keys()][0]!;
  d.local.set('a.md', 'local'); const count = remote.publications;
  await assert.rejects(d.engine.run(), /分支历史仍与上次不同/); assert.equal(remote.publications, count); assert.equal(d.local.text('a.md'), 'local');
});
test('alternating checkpoints recover from a torn latest write', async () => {
  const fs = new MemoryFS(), store = new DiskStateStore(fs, 'local', 'test'), state = newState('test');
  await store.save(state); state.approved = true; await store.save(state);
  await fs.write('local/state-0.json', '{torn');
  const recovered = await new DiskStateStore(fs, 'local', 'test').load(); assert.equal(recovered?.approved, false);
});
test('both corrupt checkpoints fail closed instead of resetting baselines', async () => {
  const fs = new MemoryFS(); await fs.write('local/state-0.json', 'bad'); await fs.write('local/state-1.json', 'bad');
  await assert.rejects(new DiskStateStore(fs, 'local', 'test').load(), /损坏/);
});
test('cache detects corrupted recovery object and can repair it from known bytes', async () => {
  const fs = new MemoryFS(), store = new DiskStateStore(fs, 'local', 'test'), data = encode('original'), id = await store.put(data);
  await fs.write(`local/objects/${id.slice(0, 2)}/${id}`, 'corrupt');
  await assert.rejects(store.get(id), /校验/); await store.put(data); assert.deepEqual(await store.get(id), data);
});
test('a listed but unavailable local file cannot be interpreted as deletion', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote); await d.engine.run();
  const count = remote.publications;
  d.local.read = async () => null;
  await assert.rejects(d.engine.run(), /暂时不可用/);
  assert.equal(remote.publications, count); assert.equal(remote.text('a.md'), 'base');
});
test('both conflict versions remain in the recovery index after choosing local', async () => {
  const remote = new MemoryRemote({ 'a.md': 'remote' }), d = await device(remote, { 'a.md': 'local' }); await d.engine.run();
  await d.engine.resolve((await d.engine.inspect()).conflicts[0]!, 'local'); await d.engine.run();
  const history = (await d.engine.inspect()).history;
  assert.ok(history.some(h => h.sha === blobHash(encode('remote'))));
  assert.ok(history.some(h => h.sha === blobHash(encode('local'))));
});
test('one stale branch read is rechecked before declaring a history rewrite', async () => {
  const remote = new MemoryRemote({ 'a.md': 'base' }), d = await device(remote);
  const old = await remote.snapshot(); await d.engine.run();
  await remote.edit('a.md', 'middle'); await d.engine.run();
  await remote.edit('a.md', 'latest');
  const snapshot = remote.snapshot.bind(remote); let stale = true;
  remote.snapshot = async () => { if (stale) { stale = false; return old; } return snapshot(); };
  await d.engine.run();
  assert.equal(d.local.text('a.md'), 'latest'); assert.equal(remote.publications, 2);
});
test('bulk local disappearance requires review before any remote deletion', async () => {
  const remote = new MemoryRemote(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`dir/${i}.md`, `note ${i}`]))), d = await device(remote);
  await d.engine.run(); d.local.files.clear();
  await assert.rejects(d.engine.run(), /批量删除/);
  assert.equal(remote.publications, 0); assert.equal(remote.commits.get(remote.head)!.files.size, 20);
  assert.equal((await d.engine.preview()).deletionReview?.items.length, 20);
});
test('one reviewed deletion plan stays approved across bounded upload batches', async () => {
  const remote = new MemoryRemote(Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`dir/${i}.md`, `note ${i}`]))), d = await device(remote);
  await d.engine.run(); d.local.files.clear();
  await d.engine.approve((await d.engine.preview()).deletionReview);
  await d.engine.run(); await d.engine.run(); await d.engine.run();
  assert.equal(remote.commits.get(remote.head)!.files.size, 0);
  assert.equal((await d.engine.inspect()).deletionApproval?.length, 0);
});
test('extra deletions after review cannot be silently included', async () => {
  const remote = new MemoryRemote(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${i}.md`, `note ${i}`]))), d = await device(remote);
  await d.engine.run(); for (let i = 0; i < 20; i++) d.local.files.delete(`${i}.md`);
  await d.engine.approve((await d.engine.preview()).deletionReview); d.local.files.delete('20.md');
  await assert.rejects(d.engine.run(), /批量删除/); assert.equal(remote.publications, 0);
});
test('new remote edits remain conflicts even after deletion plan approval', async () => {
  const remote = new MemoryRemote(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.md`, `note ${i}`]))), d = await device(remote);
  await d.engine.run(); d.local.files.clear(); await d.engine.approve((await d.engine.preview()).deletionReview);
  await remote.edit('0.md', 'new remote edit'); const result = await d.engine.run();
  assert.equal(result.conflicts, 1); assert.equal(remote.text('0.md'), 'new remote edit');
});
test('bulk remote deletion requires review before deleting local files', async () => {
  const remote = new MemoryRemote(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i}.md`, `note ${i}`]))), d = await device(remote);
  await d.engine.run(); for (let i = 0; i < 10; i++) await remote.edit(`${i}.md`, null);
  await assert.rejects(d.engine.run(), /批量删除/); assert.equal(d.local.files.size, 10);
  await d.engine.approve((await d.engine.preview()).deletionReview); await d.engine.run(); assert.equal(d.local.files.size, 0);
});
test('deleting most of a small vault also requires a concrete review', async () => {
  const remote = new MemoryRemote({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd' }), d = await device(remote);
  await d.engine.run(); d.local.files.delete('a.md'); d.local.files.delete('b.md'); d.local.files.delete('c.md');
  await assert.rejects(d.engine.run(), /批量删除/); assert.equal(remote.publications, 0);
});
