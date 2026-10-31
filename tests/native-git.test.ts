import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as child from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { NativeGit, parseGitCommand, parseGitStatus, redactGit } from '../src/native-git';
import { DEFAULT_EXTENSIONS, type Scope } from '../src/model';

const runtime = { fs, path, child, process, Buffer };
const scope: Scope = { extensions: DEFAULT_EXTENSIONS, excludedFolders: [], configDir: '.obsidian', maxBytes: 10 * 1024 * 1024 };
const exec = promisify(child.execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'vault-bridge-git-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'vault'); await fs.mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Bridge Test'); await git(root, 'config', 'user.email', 'bridge@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'note.md'), 'base\n');
  await fs.writeFile(path.join(root, '.private.json'), 'private base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'initial');
  const native = (await NativeGit.detect(root, scope, runtime))!;
  const write = (name: string, content: string | Uint8Array) => fs.writeFile(path.join(root, name), content);
  return { dir, root, native, write };
}
async function networkFixture(t: TestContext) {
  const f = await fixture(t), remote = path.join(f.dir, 'origin.git'), peer = path.join(f.dir, 'peer');
  await git(f.dir, 'init', '--bare', remote);
  await git(f.root, 'remote', 'add', 'origin', remote); await git(f.root, 'push', '-u', 'origin', 'main');
  await git(f.dir, 'clone', '-b', 'main', remote, peer);
  await git(peer, 'config', 'user.name', 'Peer'); await git(peer, 'config', 'user.email', 'peer@example.invalid');
  await git(peer, 'config', 'commit.gpgsign', 'false');
  return { ...f, remote, peer };
}

test('detects an exact vault Git root and linked worktree, never an ancestor repository', async t => {
  const f = await fixture(t), nested = path.join(f.root, 'nested'); await fs.mkdir(nested);
  assert.equal(await NativeGit.detect(nested, scope, runtime), null);
  const worktree = path.join(f.dir, 'linked'); await git(f.root, 'worktree', 'add', '-b', 'linked', worktree);
  const linked = await NativeGit.detect(worktree, scope, runtime);
  assert.ok(linked); assert.equal((await linked.snapshot()).branch, 'linked');
});
test('an existing .git with unavailable Git fails instead of selecting the API backend', async t => {
  const f = await fixture(t);
  await assert.rejects(NativeGit.detect(f.root, scope, runtime, path.join(f.dir, 'missing-git')), /Git 执行失败/);
});
test('NUL status parsing preserves spaces, Unicode, rename sides and hidden conflicts', () => {
  const entries = parseGitStatus('R  新 笔记.md\0旧 笔记.md\0UU .obsidian/workspace.json\0?? other.md\0', scope);
  assert.equal(entries[0]!.oldPath, '旧 笔记.md'); assert.equal(entries[0]!.managed, true);
  assert.equal(entries[1]!.conflict, true); assert.equal(entries[1]!.managed, false);
});
test('note-only commit preserves an unrelated staged private file', async t => {
  const f = await fixture(t);
  await f.write('.private.json', 'staged private\n'); await git(f.root, 'add', '.private.json');
  await f.write('note.md', 'changed\n'); await f.write('新 笔记.md', '中文\n');
  assert.equal(await f.native.commit('notes'), 2);
  assert.equal(await git(f.root, 'show', 'HEAD:.private.json'), 'private base');
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '.private.json');
  assert.equal(await git(f.root, 'show', 'HEAD:新 笔记.md'), '中文');
});
test('commit handles already staged deletion and rename without broad staging', async t => {
  const f = await fixture(t);
  await git(f.root, 'mv', 'note.md', 'renamed.md');
  assert.equal(await f.native.commit('rename'), 2);
  await git(f.root, 'rm', 'renamed.md');
  assert.equal(await f.native.commit('delete'), 1);
  assert.equal(await git(f.root, 'status', '--porcelain'), '');
});
test('stage-add then delete of a never-committed note creates no empty commit', async t => {
  const f = await fixture(t), head = await git(f.root, 'rev-parse', 'HEAD');
  await f.write('temporary.md', 'temporary'); await git(f.root, 'add', 'temporary.md'); await fs.unlink(path.join(f.root, 'temporary.md'));
  assert.equal(await f.native.commit('nothing left'), 0); assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
});
test('a conflict outside note scope blocks sync before committing, fetching or pushing', async t => {
  const f = await fixture(t);
  await git(f.root, 'checkout', '-b', 'other'); await f.write('.private.json', 'theirs'); await git(f.root, 'commit', '-am', 'other');
  await git(f.root, 'checkout', 'main'); await f.write('.private.json', 'ours'); await git(f.root, 'commit', '-am', 'main');
  await assert.rejects(git(f.root, 'merge', 'other'));
  await f.write('note.md', 'uncommitted note');
  const head = await git(f.root, 'rev-parse', 'HEAD'), index = await fs.readFile(path.join(f.root, '.git', 'index'));
  await assert.rejects(f.native.sync('test'), /未解决冲突/);
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head); assert.deepEqual(await fs.readFile(path.join(f.root, '.git', 'index')), index);
});
test('sync uses repository upstream, commits notes and pushes without API credentials', async t => {
  const f = await networkFixture(t); await f.write('note.md', 'upload');
  const result = await f.native.sync('fixture');
  assert.equal(result.committed, 1); assert.equal(result.pushed, 1);
  await git(f.peer, 'pull', '--ff-only'); assert.equal(await fs.readFile(path.join(f.peer, 'note.md'), 'utf8'), 'upload');
});
test('sync fast-forwards a remote update and detects divergence without rewriting commits', async t => {
  const f = await networkFixture(t);
  await fs.writeFile(path.join(f.peer, 'peer.md'), 'download'); await git(f.peer, 'add', 'peer.md'); await git(f.peer, 'commit', '-m', 'peer'); await git(f.peer, 'push');
  assert.equal((await f.native.sync('fixture')).pulled, 1);
  await fs.writeFile(path.join(f.peer, 'peer.md'), 'second'); await git(f.peer, 'commit', '-am', 'peer second'); await git(f.peer, 'push');
  await f.write('note.md', 'local divergent');
  const result = await f.native.sync('fixture'); assert.equal(result.divergent, true); assert.equal(result.pushed, 0);
  const before = await git(f.root, 'rev-parse', 'HEAD');
  await f.native.mergeUpstream();
  assert.equal((await git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3);
  assert.equal(await git(f.root, 'merge-base', '--is-ancestor', before, 'HEAD'), '');
});
test('read-only sync never commits or pushes local changes', async t => {
  const f = await networkFixture(t); await f.write('note.md', 'local'); const before = await git(f.root, 'rev-parse', 'HEAD');
  const result = await f.native.sync('fixture', true);
  assert.equal(result.committed, 0); assert.equal(result.pushed, 0); assert.equal(await git(f.root, 'rev-parse', 'HEAD'), before);
});
test('bulk note deletion waits for a concrete manual commit selection', async t => {
  const f = await networkFixture(t);
  for (let i = 0; i < 10; i++) await f.write(`delete-${i}.md`, 'test');
  await f.native.commit('ten notes'); const head = await git(f.root, 'rev-parse', 'HEAD');
  for (let i = 0; i < 10; i++) await fs.unlink(path.join(f.root, `delete-${i}.md`));
  await assert.rejects(f.native.sync('fixture'), /批量删除/); assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await f.native.commit('reviewed deletions', ['delete-0.md']), 1);
  assert.ok((await f.native.snapshot()).changes.some(c => c.path === 'delete-1.md'));
});
test('branch create/switch/delete and history work; dirty worktree prevents switching', async t => {
  const f = await fixture(t); await f.native.createBranch('notes/test');
  assert.equal((await f.native.snapshot()).branch, 'notes/test');
  await f.native.switchBranch('main'); await f.native.deleteBranch('notes/test');
  assert.equal((await f.native.branches()).some(b => b.name === 'notes/test'), false);
  assert.equal((await f.native.versions())[0]!.subject, 'initial');
  await f.write('note.md', 'editing'); await assert.rejects(f.native.createBranch('blocked'), /未提交修改/);
});
test('version restoration makes a new note-only commit and preserves unrelated staged data', async t => {
  const f = await fixture(t), old = await git(f.root, 'rev-parse', 'HEAD');
  await f.write('note.md', 'new'); await f.write('added.md', 'later'); await f.native.commit('new notes');
  const previous = await git(f.root, 'rev-parse', 'HEAD');
  await f.write('.private.json', 'private staged'); await git(f.root, 'add', '.private.json');
  const plan = await f.native.restorePlan(old); assert.deepEqual(plan.deletions, ['added.md']);
  await f.native.restoreVersion(plan);
  assert.equal(await fs.readFile(path.join(f.root, 'note.md'), 'utf8'), 'base\n');
  await assert.rejects(fs.stat(path.join(f.root, 'added.md')), { code: 'ENOENT' });
  assert.equal(await git(f.root, 'rev-parse', 'HEAD^'), previous);
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '.private.json');
});
test('stale version and staged-file reviews refuse later changes', async t => {
  const f = await fixture(t), old = await git(f.root, 'rev-parse', 'HEAD');
  await f.write('note.md', 'new'); await f.native.commit('new'); const plan = await f.native.restorePlan(old);
  await f.write('note.md', 'typing'); await assert.rejects(f.native.restoreVersion(plan), /先提交笔记修改/);
  await git(f.root, 'add', 'note.md'); const review = await f.native.stagedReview();
  await f.write('.private.json', 'extra stage'); await git(f.root, 'add', '.private.json');
  await assert.rejects(f.native.commitStaged('stale', review), /暂存区已变化/);
});
test('conflict choice preserves both sides and rejects stale content and unresolved markers', async t => {
  const f = await fixture(t);
  await git(f.root, 'checkout', '-b', 'other'); await f.write('note.md', 'theirs\n'); await git(f.root, 'commit', '-am', 'theirs');
  await git(f.root, 'checkout', 'main'); await f.write('note.md', 'ours\n'); await git(f.root, 'commit', '-am', 'ours');
  await assert.rejects(git(f.root, 'merge', 'other'));
  const conflict = await f.native.conflict('note.md');
  await assert.rejects(f.native.resolveConflict(conflict, 'manual'), /冲突标记/);
  await f.write('note.md', 'edited after preview'); await assert.rejects(f.native.resolveConflict(conflict, 'theirs'), /已变化/);
  const fresh = await f.native.conflict('note.md'), backup = await f.native.resolveConflict(fresh, 'theirs');
  assert.equal(await fs.readFile(path.join(backup, 'ours'), 'utf8'), 'ours\n');
  assert.equal(await fs.readFile(path.join(backup, 'theirs'), 'utf8'), 'theirs\n');
  assert.equal(await fs.readFile(path.join(backup, 'worktree'), 'utf8'), 'edited after preview');
  const review = await f.native.stagedReview(); await f.native.finishMerge(review);
  assert.equal((await f.native.snapshot()).operation, '');
});
test('Git command parser uses arguments, rejects command chains and hides URL credentials', () => {
  assert.deepEqual(parseGitCommand('git commit -m "中文 message"'), ['commit', '-m', '中文 message']);
  assert.throws(() => parseGitCommand('git status && rm anything'), /不支持/);
  assert.throws(() => parseGitCommand('git -C elsewhere status'), /切换仓库/);
  assert.equal(redactGit('https://user:secret@example.invalid/repo.git'), 'https://***@example.invalid/repo.git');
});
test('remote branch tracking and publishing use ordinary non-forced Git operations', async t => {
  const f = await networkFixture(t);
  await git(f.peer, 'checkout', '-b', 'remote-topic'); await git(f.peer, 'push', '-u', 'origin', 'remote-topic');
  await f.native.sync('fixture');
  await f.native.switchBranch('origin/remote-topic', true);
  assert.equal((await f.native.snapshot()).upstream, 'origin/remote-topic');
  await f.native.createBranch('local-topic');
  assert.equal((await f.native.sync('fixture')).noUpstream, true);
  await f.native.publishBranch(); assert.equal((await f.native.snapshot()).upstream, 'origin/local-topic');
});
test('delete-side conflict resolution backs up the surviving version and stages deletion', async t => {
  const f = await fixture(t);
  await git(f.root, 'checkout', '-b', 'other'); await git(f.root, 'rm', 'note.md'); await git(f.root, 'commit', '-m', 'remove');
  await git(f.root, 'checkout', 'main'); await f.write('note.md', 'ours changed'); await git(f.root, 'commit', '-am', 'modify');
  await assert.rejects(git(f.root, 'merge', 'other'));
  const conflict = await f.native.conflict('note.md'); assert.equal(conflict.theirs, null);
  const backup = await f.native.resolveConflict(conflict, 'theirs');
  assert.equal(await fs.readFile(path.join(backup, 'ours'), 'utf8'), 'ours changed');
  assert.equal((await f.native.snapshot()).changes.some(c => c.conflict), false);
  await f.native.finishMerge(await f.native.stagedReview());
});
test('literal pathspecs commit unusual note names without globbing or shell execution', async t => {
  const f = await fixture(t), unusual = '$(touch injected) [draft].md';
  await f.write(unusual, 'literal'); assert.equal(await f.native.commit('literal'), 1);
  assert.equal(await git(f.root, 'show', `HEAD:${unusual}`), 'literal');
  await assert.rejects(fs.stat(path.join(f.root, 'injected')), { code: 'ENOENT' });
});
test('symlink parents and historical symlinks are refused for note operations', async t => {
  const f = await fixture(t), outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'a.md'), 'outside');
  await fs.mkdir(path.join(f.root, 'folder')); await f.write('folder/a.md', 'tracked'); await f.native.commit('folder');
  await fs.rm(path.join(f.root, 'folder'), { recursive: true }); await fs.symlink(outside, path.join(f.root, 'folder'));
  await assert.rejects(f.native.commit('blocked'), /普通目录/);
  assert.equal(await fs.readFile(path.join(outside, 'a.md'), 'utf8'), 'outside');
  await fs.unlink(path.join(f.root, 'folder')); await git(f.root, 'restore', 'folder');
  await fs.symlink('note.md', path.join(f.root, 'link.md')); await git(f.root, 'add', 'link.md'); await git(f.root, 'commit', '-m', 'symlink');
  await assert.rejects(f.native.restorePlan('HEAD'), /符号链接/);
});
