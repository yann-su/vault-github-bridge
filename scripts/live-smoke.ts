/**
 * Connector-mediated integration harness. No credential is read or exported.
 * The controller answers LIVE_RPC requests in the supplied temporary directory.
 * Real GitHub APIs + real sync engine; memory vaults, not the Obsidian UI.
 */
import { mkdir, readFile, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { GitHubRemote, type HttpResponse, type Transport } from '../src/github';
import { SyncEngine } from '../src/engine';
import { MemoryLocal, MemoryStore, scope } from '../tests/helpers';
import { newState, type RemotePort } from '../src/model';

const [directory, branch, prefix, repository] = process.argv.slice(2);
if (!directory?.startsWith('/private/tmp/') || !branch?.startsWith('codex/github-bridge-smoke-') || !prefix?.startsWith('Bridge plugin smoke/')) throw new Error('Isolated test arguments required');
if (!repository || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error('Explicit test repository owner/name required');
const [owner, repo] = repository.split('/');
await mkdir(directory, { recursive: true });
let sequence = 0;
const http: Transport = async (method, path, body) => {
  const id = ++sequence;
  console.log(`LIVE_RPC ${JSON.stringify({ id, method, path, body })}`);
  const responsePath = `${directory}/${id}.json`;
  for (let attempt = 0; attempt < 2400; attempt++) {
    try {
      const result = JSON.parse(await readFile(responsePath, 'utf8')) as HttpResponse;
      await unlink(responsePath);
      return result;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`RPC timeout ${id}`);
};
function remote(): RemotePort {
  const real = new GitHubRemote(http, owner!, repo!, branch!, scope, 'isolated integration test');
  return {
    snapshot: async () => { const snapshot = await real.snapshot(); snapshot.files = new Map([...snapshot.files].filter(([path]) => path.startsWith(prefix! + '/'))); return snapshot; },
    blob: id => real.blob(id), prepare: (snapshot, changes) => real.prepare(snapshot, changes),
    advance: candidate => real.advance(candidate), contains: (candidate, head) => real.contains(candidate, head)
  };
}
async function device() {
  const local = new MemoryLocal(), store = new MemoryStore(), state = newState(branch!);
  state.approved = true; await store.save(state);
  return { local, engine: new SyncEngine(local, remote(), store, branch!, scope) };
}
const a = await device(), b = await device();
const shared = `${prefix}/shared.md`, independent = `${prefix}/phone.md`, preserved = `${prefix}/preserved.md`;
a.local.set(shared, '共同基线\n');
await a.engine.run(); await b.engine.run();
assert.equal(b.local.text(shared), '共同基线\n');
console.log('LIVE_PHASE first upload/download passed');
a.local.set(shared, '电脑的修改\n'); b.local.set(shared, '手机离线的修改\n'); b.local.set(independent, '独立笔记\n');
await a.engine.run();
assert.equal((await b.engine.run()).conflicts, 1);
assert.equal(b.local.text(shared), '手机离线的修改\n');
console.log('LIVE_PHASE both versions retained; unrelated note published');
b.local.set(preserved, b.local.text(shared)!);
await b.engine.resolve((await b.engine.inspect()).conflicts[0]!, 'remote'); await b.engine.run();
await a.engine.run();
assert.equal(b.local.text(shared), '电脑的修改\n');
assert.equal(a.local.text(preserved), '手机离线的修改\n');
assert.equal(a.local.text(independent), '独立笔记\n');
console.log('LIVE_PHASE conflict resolution and preserved copy passed');
a.local.files.delete(independent); await a.engine.run(); await b.engine.run();
assert.equal(b.local.text(independent), null);
assert.equal((await b.engine.inspect()).conflicts.length, 0);
console.log(`LIVE_DONE ${JSON.stringify({ branch, requests: sequence, checks: ['upload', 'download', 'conflict preservation', 'independent changes', 'resolution', 'preserved copy', 'deletion propagation'] })}`);
