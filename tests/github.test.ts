import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, GitHubRemote, fromBase64, toBase64, type Transport } from '../src/github';
import { blobHash, encode } from '../src/model';
import { scope } from './helpers';

const h = (c: string) => c.repeat(40);
function harness(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const transport: Transport = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.replace('/repos/user/notes', '').replace(/\?bridge_sync=\d+-\d+$/, '')}`;
    if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
    const value = routes[key];
    if (value && typeof value === 'object' && 'httpStatus' in value) {
      const r = value as { httpStatus: number; headers?: Record<string, string> };
      return { status: r.httpStatus, headers: r.headers ?? {}, json: { message: 'not exposed' } };
    }
    return { status: 200, headers: {}, json: value };
  };
  return { calls, remote: new GitHubRemote(transport, 'user', 'notes', 'main', scope, '测试设备') };
}
const standard = {
  'GET /git/ref/heads/main': { object: { sha: h('a') } },
  [`GET /git/commits/${h('a')}`]: { tree: { sha: h('b') } }
};
test('GitHub snapshot is pinned to a commit and ignores configuration files', async () => {
  const sha = blobHash(encode('A'));
  const { remote, calls } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: false, tree: [
    { path: 'a.md', mode: '100644', type: 'blob', size: 1, sha },
    { path: '.obsidian/a.md', mode: '100644', type: 'blob', size: 1, sha }
  ] } });
  const snapshot = await remote.snapshot(); assert.deepEqual([...snapshot.files.keys()], ['a.md']);
  assert.equal(snapshot.head, h('a')); assert.equal(calls.length, 3);
});
test('truncated recursive trees fall back to complete subtree traversal', async () => {
  const { remote } = harness({ ...standard,
    [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: true, tree: [] },
    [`GET /git/trees/${h('b')}`]: { truncated: false, tree: [{ path: 'folder', type: 'tree', sha: h('c') }] },
    [`GET /git/trees/${h('c')}`]: { truncated: false, tree: [{ path: 'a.md', type: 'blob', mode: '100644', size: 1, sha: h('d') }] }
  });
  assert.deepEqual([...(await remote.snapshot()).files.keys()], ['folder/a.md']);
});
test('incomplete tree fails closed so missing entries cannot become deletions', async () => {
  const { remote } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { tree: [] } });
  await assert.rejects(remote.snapshot(), /完整性/);
});
test('truncated fallback also fails closed if a subtree is incomplete', async () => {
  const { remote } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: true, tree: [] }, [`GET /git/trees/${h('b')}`]: { truncated: true, tree: [] } });
  await assert.rejects(remote.snapshot(), /截断/);
});
test('symlinks in managed scope are refused', async () => {
  const { remote } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: false, tree: [{ path: 'a.md', type: 'blob', mode: '120000', size: 1, sha: h('c') }] } });
  await assert.rejects(remote.snapshot(), /符号链接/);
});
test('oversized remote files fail before any local operation', async () => {
  const { remote } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: false, tree: [{ path: 'a.md', type: 'blob', mode: '100644', size: scope.maxBytes + 1, sha: h('c') }] } });
  await assert.rejects(remote.snapshot(), /大小限制/);
});
test('create tree preserves the current tree and deletion uses null SHA', async () => {
  const bytes = encode('new'), id = blobHash(bytes);
  const { remote, calls } = harness({ 'POST /git/blobs': { sha: id }, 'POST /git/trees': { sha: h('c') }, 'POST /git/commits': { sha: h('d') }, 'PATCH /git/refs/heads/main': { ref: 'refs/heads/main' } });
  const candidate = await remote.prepare({ head: h('a'), tree: h('b'), files: new Map() }, [{ path: 'a.md', data: bytes }, { path: 'deleted.md', data: null }]);
  await remote.advance(candidate);
  assert.equal(calls[1]?.body.base_tree, h('b')); assert.equal(calls[1]?.body.tree[1].sha, null);
  assert.deepEqual(calls[2]?.body.parents, [h('a')]); assert.equal(calls[3]?.body.force, false);
  assert.equal(calls[0]?.body.content, toBase64(bytes));
});
test('same blob uploaded once across a retried publication', async () => {
  const bytes = encode('same'), id = blobHash(bytes);
  const { remote, calls } = harness({ 'POST /git/blobs': { sha: id }, 'POST /git/trees': { sha: h('c') }, 'POST /git/commits': { sha: h('d') } });
  const snapshot = { head: h('a'), tree: h('b'), files: new Map<string, string>() };
  await remote.prepare(snapshot, [{ path: 'a.md', data: bytes }, { path: 'b.md', data: bytes }]);
  await remote.prepare(snapshot, [{ path: 'a.md', data: bytes }]);
  assert.equal(calls.filter(c => c.path.endsWith('/git/blobs')).length, 1);
});
test('download verifies Git blob hash and exact bytes', async () => {
  const bytes = new Uint8Array([0, 255, 127]), id = blobHash(bytes);
  const { remote } = harness({ [`GET /git/blobs/${id}`]: { encoding: 'base64', content: toBase64(bytes) } });
  assert.deepEqual(await remote.blob(id), bytes);
});
test('tampered or incomplete download never reaches a local write', async () => {
  const { remote } = harness({ [`GET /git/blobs/${h('c')}`]: { encoding: 'base64', content: toBase64(encode('wrong')) } });
  await assert.rejects(remote.blob(h('c')), /校验/);
});
test('rate limits expose backoff duration without leaking response body', async () => {
  const { remote } = harness({ 'GET /git/ref/heads/main': { httpStatus: 429, headers: { 'Retry-After': '120' } } });
  await assert.rejects(remote.snapshot(), e => e instanceof GitHubError && e.retryAfterMs >= 120_000 && !e.message.includes('not exposed'));
});
test('ancestry check recognizes published commits with later descendants', async () => {
  const { remote } = harness({ [`GET /compare/${h('a')}...${h('b')}`]: { status: 'ahead' } });
  assert.equal(await remote.contains(h('a'), h('b')), true); assert.equal(await remote.contains(h('a'), h('a')), true);
});
test('large base64 chunks preserve all bytes', () => {
  const bytes = Uint8Array.from({ length: 100_001 }, (_, i) => i % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});
test('mutable branch reads bypass cached URLs even within the same millisecond', async () => {
  const { remote, calls } = harness({ ...standard, [`GET /git/trees/${h('b')}?recursive=1`]: { truncated: false, tree: [] } });
  await remote.snapshot(); await remote.snapshot();
  const refs = calls.filter(call => call.path.includes('/git/ref/heads/'));
  assert.notEqual(refs[0]?.path, refs[1]?.path);
  assert.ok(refs.every(call => /\?bridge_sync=\d+-\d+$/.test(call.path)));
});
test('invalid ancestry response is not reported as a history rewrite', async () => {
  const { remote } = harness({ [`GET /compare/${h('a')}...${h('b')}`]: { message: 'unexpected response' } });
  await assert.rejects(remote.contains(h('a'), h('b')), /提交关系响应无效/);
});
