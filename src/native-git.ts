import { blobHash, hashText, inScope, type Scope } from './model';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { overwritePlan, type RemoteOverwritePlan, type RemoteOverwriteResult } from './force-remote';

export interface NativeRuntime {
  fs: typeof import('node:fs/promises');
  path: typeof import('node:path');
  child: typeof import('node:child_process');
  process: typeof import('node:process');
  Buffer: typeof import('node:buffer').Buffer;
}
// Called only after the desktop + filesystem-adapter check. Mobile never loads Node.
export function nativeRuntime(): NativeRuntime {
  return { fs: require('node:fs/promises'), path: require('node:path'), child: require('node:child_process'),
    process: require('node:process'), Buffer: require('node:buffer').Buffer };
}
export function redactGit(text: string): string {
  return text.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/github_pat_[\w]+|gh[pousr]_[\w]{20,}/g, '[凭据已隐藏]');
}
export interface GitChange { path: string; oldPath?: string; index: string; worktree: string; conflict: boolean; managed: boolean }
export interface GitSnapshot {
  branch: string; head: string; remote: string; remoteUrl: string; upstream: string;
  upstreamRef: string; ahead: number; behind: number; operation: string; changes: GitChange[];
}
export interface GitBranch { name: string; current: boolean; remote: boolean; upstream: string }
export interface GitVersion { sha: string; date: string; subject: string; refs: string }
export interface GitRestorePlan { sha: string; head: string; paths: string[]; deletions: string[]; fingerprint: string }
export interface GitConflict { path: string; operation: string; fingerprint: string; ours: string | null; theirs: string | null; worktree: string | null }
export interface GitSyncResult {
  committed: number; pulled: number; pushed: number; merged: boolean; conflicts: number;
  divergent: boolean; noUpstream: boolean;
}
export interface GitStagedReview { summary: string; fingerprint: string }

export function parseGitStatus(output: string, scope: Scope): GitChange[] {
  const fields = output.split('\0'), changes: GitChange[] = [];
  for (let n = 0; n < fields.length; n++) {
    const field = fields[n]!; if (!field) continue;
    if (field.length < 4 || field[2] !== ' ') throw new Error('无法识别 Git 工作区状态。');
    const index = field[0]!, worktree = field[1]!, path = field.slice(3);
    const renamed = /[RC]/.test(index + worktree), oldPath = renamed ? fields[++n] : undefined;
    if (renamed && !oldPath) throw new Error('Git 重命名状态不完整。');
    changes.push({ path, ...(oldPath ? { oldPath } : {}), index, worktree,
      conflict: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree),
      managed: inScope(path, scope) && (!oldPath || inScope(oldPath, scope)) });
  }
  return changes;
}
function relativeFile(path: string): boolean {
  return Boolean(path) && !/[\0\r\n]/.test(path) && !path.includes('\\') &&
    path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
}
export function parseGitCommand(command: string): string[] {
  const result: string[] = []; let token = '', quote = '', escaped = false, started = false;
  for (const c of command.trim()) {
    if (escaped) { token += c; escaped = false; started = true; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (c === quote) quote = ''; else token += c; started = true; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/[\n\r\0;|&<>`]/.test(c)) throw new Error('Git 命令行不支持管道、重定向或命令串；请在系统终端执行。');
    if (/\s/.test(c)) { if (started) result.push(token); token = ''; started = false; }
    else { token += c; started = true; }
  }
  if (escaped || quote) throw new Error('引号或转义尚未结束。');
  if (started) result.push(token);
  if (result.shift() !== 'git' || !result.length) throw new Error('请输入以 git 开头的命令。');
  // The console must stay bound to this vault; another repository belongs in a terminal.
  if (result.some(arg => arg === '-C' || /^--(?:git-dir|work-tree|bare|exec-path)(?:=|$)/.test(arg))) throw new Error('请在系统终端切换仓库。');
  return result;
}

export class NativeGit {
  private cancelled = false;
  private children = new Set<import('node:child_process').ChildProcess>();
  private constructor(readonly root: string, readonly gitDir: string, public scope: Scope,
    private runtime: NativeRuntime, private executable: string) {}

  static async detect(root: string, scope: Scope, runtime = nativeRuntime(), executable = 'git'): Promise<NativeGit | null> {
    const marker = runtime.path.join(root, '.git');
    try { await runtime.fs.lstat(marker); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    const git = new NativeGit(await runtime.fs.realpath(root), '', scope, runtime, executable);
    const top = (await git.text(['-C', root, 'rev-parse', '--show-toplevel'], true)).trim();
    const canonical = await runtime.fs.realpath(top);
    if (canonical !== git.root) throw new Error('本地 Git 根目录必须就是当前笔记库；不会操作上级目录的仓库。');
    const gitDir = (await git.text(['-C', root, 'rev-parse', '--absolute-git-dir'], true)).trim();
    const version = (await git.text(['--version'], true)).match(/(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 25) throw new Error('本机 Git 需为 2.25 或更新版本。');
    return new NativeGit(git.root, gitDir, scope, runtime, executable);
  }
  cancel(): void { this.cancelled = true; for (const child of this.children) child.kill(); }
  private async raw(args: string[], discovery = false, input?: Uint8Array, indexFile?: string): Promise<Uint8Array> {
    if (this.cancelled) throw new Error('Git 操作已取消。');
    const env = { ...this.runtime.process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key as keyof typeof env];
    if (indexFile) Object.assign(env, { GIT_INDEX_FILE: indexFile });
    const argv = discovery ? args : ['--literal-pathspecs', `--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, '-c', 'core.fsmonitor=false', ...args];
    return new Promise((resolve, reject) => {
      const child = this.runtime.child.execFile(this.executable, argv, { cwd: this.root, env, encoding: 'buffer',
        timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (error) reject(new Error(redactGit(stderr.toString().trim()) || `Git 执行失败：${error.code ?? '已取消或超时'}。请检查本机 Git 与凭据。`));
        else resolve(new Uint8Array(stdout));
      });
      this.children.add(child);
      child.stdin?.on('error', () => {}); // Early Git failure may close stdin first.
      child.stdin?.end(input);
    });
  }
  private async text(args: string[], discovery = false, input?: Uint8Array, indexFile?: string): Promise<string> {
    return new TextDecoder().decode(await this.raw(args, discovery, input, indexFile));
  }
  private async optional(args: string[]): Promise<string> { try { return (await this.text(args)).trim(); } catch { return ''; } }
  private pathInput(paths: string[]): Uint8Array {
    if (!paths.length || paths.some(p => !relativeFile(p))) throw new Error('Git 文件路径无效。');
    return new TextEncoder().encode(paths.join('\0') + '\0');
  }
  async snapshot(): Promise<GitSnapshot> {
    const [branch, head, status] = await Promise.all([
      this.optional(['symbolic-ref', '--quiet', '--short', 'HEAD']), this.optional(['rev-parse', '--verify', 'HEAD']),
      this.text(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ]);
    const changes = parseGitStatus(status, this.scope);
    let operation = '';
    for (const [marker, label] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
      const location = (await this.text(['rev-parse', '--git-path', marker])).trim();
      try { await this.runtime.fs.stat(this.runtime.path.resolve(this.root, location)); operation = label; break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    try { await this.runtime.fs.stat(this.runtime.path.join(this.gitDir, 'vault-bridge-force-remote.json')); operation = 'force-remote'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fields = branch ? (await this.text(['for-each-ref', '--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`])).trim().split('\0') : [];
    const upstream = fields[0] ?? '', remote = fields[1] || 'origin', upstreamRef = fields[2] ?? '';
    if (remote.startsWith('-') || /[\0\r\n\s]/.test(remote)) throw new Error('Git 远端名称无效。');
    const remoteUrl = redactGit(await this.optional(['remote', 'get-url', remote]));
    const counts = upstream ? (await this.optional(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).split(/\s+/) : [];
    return { branch, head, remote, remoteUrl, upstream, upstreamRef, ahead: Number(counts[0]) || 0,
      behind: Number(counts[1]) || 0, operation, changes };
  }
  private ensureIdle(state: GitSnapshot): void {
    if (state.operation === 'force-remote') throw new Error('上次强制采用远端尚未完成，请从同步菜单重新预览。备份已保留，自动上传已停止。');
    const conflicts = state.changes.filter(c => c.conflict);
    if (conflicts.length) throw new Error(`Git 有 ${conflicts.length} 个未解决冲突：${conflicts.slice(0, 3).map(c => c.path).join('、')}。请先处理冲突。`);
    if (state.operation) throw new Error(`Git 正在进行 ${state.operation}，请先完成或在终端中处理该操作。`);
    if (!state.branch) throw new Error('Git 当前处于分离 HEAD，请先切换到本地分支。');
  }
  private managedPaths(state: GitSnapshot): string[] {
    return [...new Set(state.changes.filter(c => c.managed).flatMap(c => c.oldPath ? [c.path, c.oldPath] : [c.path]))];
  }
  private async checkFiles(paths: string[]): Promise<void> {
    this.pathInput(paths);
    for (const file of paths) {
      await this.checkParents(file);
      const full = this.runtime.path.join(this.root, file);
      try {
        const stat = await this.runtime.fs.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`不支持作为笔记提交的路径：${file}`);
        const canonical = await this.runtime.fs.realpath(full);
        if (!canonical.startsWith(this.root + this.runtime.path.sep)) throw new Error(`文件位于笔记库之外：${file}`);
        if (stat.size > this.scope.maxBytes) throw new Error(`文件超过同步上限：${file}`);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  private async checkParents(file: string): Promise<void> {
    if (!relativeFile(file)) throw new Error('Git 文件路径无效。');
    const parts = file.split('/');
    for (let n = 1; n < parts.length; n++) {
      try {
        const stat = await this.runtime.fs.lstat(this.runtime.path.join(this.root, ...parts.slice(0, n)));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`文件夹路径不是普通目录：${parts.slice(0, n).join('/')}`);
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
    }
  }
  async commit(message: string, selected?: string[]): Promise<number> {
    if (!message.trim()) throw new Error('请输入提交说明。');
    const state = await this.snapshot(); this.ensureIdle(state);
    const allowed = this.managedPaths(state), paths = selected ? [...new Set(selected)] : allowed;
    if (!paths.length) return 0;
    if (paths.some(p => !allowed.includes(p))) throw new Error('文件清单已变化，请重新打开提交面板。');
    await this.checkFiles(paths);
    const indexPaths = new Set((await this.text(['ls-files', '-z'])).split('\0'));
    const toStage: string[] = [];
    for (const p of paths) {
      if (indexPaths.has(p)) { toStage.push(p); continue; }
      try { await this.runtime.fs.lstat(this.runtime.path.join(this.root, p)); toStage.push(p); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (toStage.length) await this.text(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], false, this.pathInput(toStage));
    const staged = new Set((await this.text(['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0'));
    const commitPaths = paths.filter(p => staged.has(p));
    if (!commitPaths.length) return 0;
    // --only preserves unrelated staged files instead of including them in this commit.
    await this.text(['commit', '--only', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], false, this.pathInput(commitPaths));
    return commitPaths.length;
  }
  async sync(device: string, readOnly = false): Promise<GitSyncResult> {
    let state = await this.snapshot();
    if (state.operation === 'force-remote') this.ensureIdle(state);
    const result: GitSyncResult = { committed: 0, pulled: 0, pushed: 0, merged: false,
      conflicts: state.changes.filter(c => c.conflict).length, divergent: false, noUpstream: false };
    if (result.conflicts) return result;
    this.ensureIdle(state);
    if (!state.upstream || !state.upstreamRef || state.remote === '.') return { ...result, noUpstream: true };
    const target = state;
    const checkTarget = (current: GitSnapshot) => {
      this.ensureIdle(current);
      if (current.branch !== target.branch || current.upstream !== target.upstream ||
        current.remote !== target.remote || current.upstreamRef !== target.upstreamRef) {
        throw new Error('同步期间分支或上游已变化，本轮已停止，请重新同步。');
      }
    };
    const deletions = state.changes.filter(c => c.managed && (c.index === 'D' || c.worktree === 'D')).length;
    const tracked = (await this.text(['ls-files', '-z'])).split('\0').filter(p => p && inScope(p, this.scope)).length;
    if (!readOnly && (deletions >= 10 || deletions >= 3 && deletions >= tracked / 2)) throw new Error('检测到批量删除，请打开“提交笔记修改”核对具体清单后提交。');
    if (!readOnly) result.committed = await this.commit(`Obsidian: ${device} ${new Date().toISOString()}`);
    let rejectedPush: { upstream: string; error: unknown } | undefined;
    // Another device can publish between fetch and push. Retry only when the
    // actual upstream advanced; credentials, hooks and network failures surface.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.text(['fetch', '--prune', target.remote]);
      state = await this.snapshot(); checkTarget(state);
      const upstream = await this.resolveVersion(state.upstream);
      if (rejectedPush && rejectedPush.upstream === upstream) throw rejectedPush.error;
      if (state.behind) {
        if (readOnly && state.ahead) return { ...result, divergent: true };
        try { await this.mergeFetchedUpstream(state, readOnly || !state.ahead, !readOnly); }
        catch (error) {
          const stopped = await this.snapshot();
          const conflicts = stopped.changes.filter(c => c.conflict).length;
          if (conflicts) return { ...result, conflicts };
          if (stopped.operation === 'merge') throw new Error('上游合并尚未完成，请打开“处理同步冲突”核对并完成合并。\n' + (error instanceof Error ? error.message : 'Git 合并失败。'));
          throw error;
        }
        result.pulled += state.behind;
        result.merged ||= Boolean(state.ahead);
      }
      state = await this.snapshot(); checkTarget(state);
      if (readOnly || !state.ahead) return result;
      try {
        await this.text(['push', state.remote, `HEAD:${state.upstreamRef}`]);
        result.pushed = state.ahead;
        return result;
      } catch (error) {
        if (attempt === 2) throw error;
        rejectedPush = { upstream, error };
      }
    }
    return result;
  }
  private workspacePaths(): string[] {
    const paths = ['workspace.json', 'workspace-mobile.json'].map(name => `${this.scope.configDir}/${name}`);
    this.pathInput(paths);
    return paths;
  }
  private async layoutFilesAt(version: string): Promise<string[]> {
    return (await this.text(['ls-tree', '-r', '--name-only', '-z', version, '--', ...this.workspacePaths()])).split('\0').filter(Boolean);
  }
  // Make a child of the fetched commit that removes only workspace layouts.
  // An isolated index keeps the real index and running app's JSON untouched.
  // Merging this child retains every upstream note and the original history.
  private async withoutWorkspace(parent: string): Promise<string> {
    const folder = await this.runtime.fs.mkdtemp(this.runtime.path.join(this.gitDir, 'vault-bridge-index-'));
    const index = this.runtime.path.join(folder, 'index');
    try {
      await this.text(['read-tree', parent], false, undefined, index);
      await this.text(['update-index', '--force-remove', '--', ...this.workspacePaths()], false, undefined, index);
      const tree = (await this.text(['write-tree'], false, undefined, index)).trim();
      return (await this.text(['commit-tree', tree, '-p', parent, '-m', 'Keep Obsidian workspace layouts local'])).trim();
    } finally { await this.runtime.fs.rm(folder, { recursive: true, force: true }); }
  }
  async keepWorkspaceLocal(): Promise<string> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (!state.head) throw new Error('请先为仓库创建初始提交。');
    if (state.changes.some(c => c.index !== ' ' && c.index !== '?')) throw new Error('暂存区已有修改，请先核对并提交或取消暂存，再修复布局同步。');
    if (state.changes.some(c => c.path === '.gitignore')) throw new Error('.gitignore 有未提交修改，请先处理后再修复布局同步。');
    const paths = this.workspacePaths(), tracked = await this.layoutFilesAt(state.head);
    const read = async (file: string): Promise<Uint8Array | null> => {
      await this.checkParents(file);
      try {
        const full = this.runtime.path.join(this.root, file), stat = await this.runtime.fs.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`请先处理非常规布局或忽略文件：${file}`);
        return new Uint8Array(await this.runtime.fs.readFile(full));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const review = await this.stagedReview(), ignore = await read('.gitignore');
    const snapshots = await Promise.all(paths.map(async file => ({ file, bytes: await read(file) })));
    const parent = this.runtime.path.join(this.gitDir, 'vault-bridge-backups');
    await this.runtime.fs.mkdir(parent, { recursive: true });
    const backup = await this.runtime.fs.mkdtemp(this.runtime.path.join(parent, 'workspace-'));
    for (const item of [{ file: '.gitignore', bytes: ignore }, ...snapshots]) if (item.bytes !== null) {
      const destination = this.runtime.path.join(backup, 'files', item.file);
      await this.runtime.fs.mkdir(this.runtime.path.dirname(destination), { recursive: true });
      await this.runtime.fs.writeFile(destination, item.bytes, { mode: 0o600 });
    }
    await this.runtime.fs.writeFile(this.runtime.path.join(backup, 'manifest.json'), JSON.stringify({ head: state.head,
      files: [{ file: '.gitignore', bytes: ignore }, ...snapshots].map(s => ({ path: s.file, blob: s.bytes === null ? null : blobHash(s.bytes) })) }), { mode: 0o600 });
    const current = await this.snapshot(); this.ensureIdle(current);
    const nowIgnore = await read('.gitignore');
    if (current.branch !== state.branch || (await this.stagedReview()).fingerprint !== review.fingerprint ||
      (nowIgnore === null ? null : blobHash(nowIgnore)) !== (ignore === null ? null : blobHash(ignore))) throw new Error('仓库或 .gitignore 在备份时变化，请重新修复。');
    const old = ignore === null ? '' : new TextDecoder('utf-8', { fatal: true }).decode(ignore);
    const escape = (file: string) => file.replaceAll('*', '\\*').replaceAll('?', '\\?').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll(' ', '\\ ');
    const rules = paths.map(file => '/' + escape(file)).filter(rule => !old.split(/\r?\n/).includes(rule));
    if (rules.length) {
      const newline = old.includes('\r\n') ? '\r\n' : '\n';
      await this.runtime.fs.writeFile(this.runtime.path.join(this.root, '.gitignore'), old + (old && !old.endsWith('\n') ? newline : '') + rules.join(newline) + newline);
      await this.text(['add', '--', '.gitignore']);
    }
    if (tracked.length) await this.text(['rm', '--cached', '--', ...tracked]);
    if (rules.length || tracked.length) {
      const staged = (await this.text(['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean);
      if (staged.some(p => p !== '.gitignore' && !paths.includes(p))) throw new Error('暂存区出现其他修改，请核对后再提交布局修复。');
      await this.text(['commit', '-m', 'Keep Obsidian workspace layouts local']);
    }
    await this.text(['config', '--local', 'vaultBridge.localWorkspaceDir', this.scope.configDir]);
    return backup;
  }
  private async mergeFetchedUpstream(state: GitSnapshot, ffOnly = false, allowLayoutCommit = true): Promise<void> {
    this.ensureIdle(state);
    if (!ffOnly && state.changes.some(c => c.index !== ' ' && c.index !== '?')) {
      throw new Error('暂存区还有其他修改，请先在“提交笔记修改”中核对并提交，或在终端取消暂存，再合并上游。');
    }
    let upstream = await this.resolveVersion(state.upstream);
    const localLayouts = await this.optional(['config', '--local', '--get', 'vaultBridge.localWorkspaceDir']);
    const here = await this.layoutFilesAt(state.head), there = await this.layoutFilesAt(upstream);
    if (here.some(file => !there.includes(file))) throw new Error('上游已停止跟踪工作区布局。请先在“Git 仓库管理”选择“修复布局文件并同步”，保留本机布局后再同步。');
    if (localLayouts === this.scope.configDir && !here.length && there.length) {
      if (!allowLayoutCommit) throw new Error('上游仍跟踪工作区布局。请关闭只接收更新，再同步以保留本机布局。');
      upstream = await this.withoutWorkspace(upstream);
    }
    const dirty = state.changes.filter(c => c.index !== '?');
    if (dirty.length) {
      const incoming = new Set((await this.text(['diff', '--name-only', '--no-renames', '-z', `HEAD...${upstream}`])).split('\0'));
      const overlap = dirty.filter(c => incoming.has(c.path) || c.oldPath && incoming.has(c.oldPath));
      if (overlap.length) {
        const layout = overlap.some(c => this.workspacePaths().includes(c.path));
        throw new Error(`未提交修改阻止合并：${overlap.slice(0, 5).map(c => c.path).join('、')}。${layout ? '请打开“Git 仓库管理”，选择“修复布局文件并同步”。' : '请先在终端提交或 stash 这些修改，再同步。'}笔记和双方提交均已保留。`);
      }
    }
    // Never stash a user's working files or apply an old cached resolution.
    // Explicit flags also override repository ff-only / no-commit preferences.
    await this.text(['-c', 'merge.autoStash=false', '-c', 'rerere.enabled=false',
      '-c', `branch.${state.branch}.mergeOptions=`, 'merge', '--no-edit', '--commit', '--no-squash',
      ffOnly ? '--ff-only' : '--ff', upstream]);
  }
  async branches(): Promise<GitBranch[]> {
    return (await this.text(['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes'])).split('\n').filter(Boolean).flatMap(line => {
      const [ref = '', current, upstream = ''] = line.split('\0');
      if (ref.endsWith('/HEAD')) return [];
      const remote = ref.startsWith('refs/remotes/');
      return [{ name: ref.replace(/^refs\/(?:heads|remotes)\//, ''), current: current === '*', remote, upstream }];
    });
  }
  private async cleanForSwitch(): Promise<GitSnapshot> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (state.changes.some(c => c.managed)) throw new Error('笔记有未提交修改，请先提交或在终端中 stash 后再切换分支。');
    return state;
  }
  async switchBranch(name: string, remote = false): Promise<void> {
    await this.cleanForSwitch();
    const branches = await this.branches();
    if (!branches.some(b => b.name === name && b.remote === remote)) throw new Error('该分支已不存在，请刷新列表。');
    if (remote) await this.text(['switch', '--track', '--', name]);
    else await this.text(['switch', '--', name]);
  }
  async createBranch(name: string, version = 'HEAD'): Promise<void> {
    await this.cleanForSwitch();
    await this.text(['check-ref-format', '--branch', name]);
    const sha = await this.resolveVersion(version);
    await this.text(['switch', '-c', name, sha]);
  }
  async publishBranch(): Promise<void> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (state.upstream) throw new Error('当前分支已经有上游，请使用立即同步。');
    await this.text(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${state.branch}`]);
  }
  async deleteBranch(name: string): Promise<void> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (!name || name === state.branch || name.startsWith('-')) throw new Error('不能删除当前分支。');
    await this.text(['branch', '-d', '--', name]);
  }
  async commitStaged(message: string, review: GitStagedReview): Promise<void> {
    const state = await this.snapshot();
    if (state.changes.some(c => c.conflict) || state.operation && state.operation !== 'merge') throw new Error('请先处理当前 Git 冲突或操作。');
    if (!message.trim()) throw new Error('请输入提交说明。');
    if ((await this.stagedReview()).fingerprint !== review.fingerprint) throw new Error('暂存区已变化，请重新核对提交清单。');
    await this.text(['commit', '-m', message]);
  }
  async mergeUpstream(): Promise<void> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (!state.upstream) throw new Error('当前分支没有上游。');
    if (state.changes.some(c => c.managed)) throw new Error('请先提交笔记修改，再合并上游。');
    await this.text(['fetch', state.remote]);
    const fresh = await this.snapshot();
    if (fresh.branch !== state.branch || fresh.upstream !== state.upstream) throw new Error('分支或上游已变化，请刷新后重试。');
    await this.mergeFetchedUpstream(fresh, !fresh.ahead);
  }
  async versions(): Promise<GitVersion[]> {
    if (!(await this.optional(['rev-parse', '--verify', 'HEAD']))) return [];
    return (await this.text(['log', '-150', '--all', '--date=iso-strict', '--format=%H%x00%aI%x00%s%x00%D%x00'])).split('\0\n').filter(Boolean).map(row => {
      const [sha = '', date = '', subject = '', refs = ''] = row.split('\0'); return { sha, date, subject, refs };
    });
  }
  async resolveVersion(version: string): Promise<string> {
    if (!version || version.startsWith('-') || /[\0\r\n]/.test(version)) throw new Error('版本标识无效。');
    const sha = (await this.text(['rev-parse', '--verify', `${version}^{commit}`])).trim();
    if (!/^[a-f\d]{40,64}$/.test(sha)) throw new Error('无法解析该版本。'); return sha;
  }
  async versionDetail(version: string): Promise<string> {
    const sha = await this.resolveVersion(version);
    return redactGit(await this.text(['show', '--format=fuller', '--stat', '--no-renames', sha]));
  }
  private async treePaths(version: string): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of (await this.text(['ls-tree', '-r', '-z', version])).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), file = entry.slice(tab + 1), mode = entry.slice(0, 6);
      if (tab < 0) throw new Error('Git 历史文件清单不完整。');
      if (!inScope(file, this.scope)) continue;
      if (!['100644', '100755'].includes(mode)) throw new Error(`此版本的笔记包含符号链接或子模块：${file}`);
      paths.push(file);
    }
    return paths;
  }
  private repoHash(bytes: Uint8Array, head: string): string {
    if (head.length === 40) return blobHash(bytes);
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`), data = new Uint8Array(header.length + bytes.length);
    data.set(header); data.set(bytes, header.length); return bytesToHex(sha256(data));
  }
  private forceState(state: GitSnapshot): void {
    if (state.operation && !['merge', 'force-remote'].includes(state.operation)) throw new Error(`请先在终端完成或退出 ${state.operation}，再采用远端。`);
    if (!state.branch || !state.head || !state.upstream || !state.upstreamRef || state.remote === '.') throw new Error('强制采用远端需要当前本地分支已设置远端上游。');
    if (state.changes.some(c => !c.managed && c.index !== ' ' && c.index !== '?')) throw new Error('同步范围外有已暂存修改或冲突，请先处理；强制覆盖不会丢弃这些文件。');
  }
  private async forceTree(sha: string): Promise<Map<string, { sha: string; mode: number }>> {
    const files = new Map<string, { sha: string; mode: number }>();
    for (const entry of (await this.text(['ls-tree', '-rlz', sha])).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), file = entry.slice(tab + 1), fields = entry.slice(0, tab).trim().split(/\s+/);
      if (!inScope(file, this.scope)) continue;
      if (tab < 0 || fields[1] !== 'blob' || !['100644', '100755'].includes(fields[0]!) || !/^[a-f\d]{40,64}$/.test(fields[2]!)) throw new Error(`不支持强制覆盖的远端路径：${file}`);
      if (!Number.isFinite(Number(fields[3])) || Number(fields[3]) > this.scope.maxBytes) throw new Error(`远端文件超过同步上限：${file}`);
      files.set(file, { sha: fields[2]!, mode: fields[0] === '100755' ? 0o100 : 0 });
    }
    return files;
  }
  private async forceLocal(state: GitSnapshot, target: Map<string, { sha: string; mode: number }>): Promise<Map<string, { sha: string; mode: number }>> {
    const paths = new Set([...await this.treePaths(state.head), ...target.keys(),
      ...(await this.text(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(p => p && inScope(p, this.scope))]);
    const files = new Map<string, { sha: string; mode: number }>();
    for (const file of paths) {
      await this.checkFiles([file]);
      try {
        const full = this.runtime.path.join(this.root, file), stat = await this.runtime.fs.stat(full);
        const bytes = new Uint8Array(await this.runtime.fs.readFile(full));
        files.set(file, { sha: this.repoHash(bytes, state.head), mode: stat.mode & 0o111 ? 0o100 : 0 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return files;
  }
  async previewForceRemote(): Promise<RemoteOverwritePlan> {
    const before = await this.snapshot(); this.forceState(before);
    await this.text(['fetch', '--prune', before.remote]);
    const state = await this.snapshot(); this.forceState(state);
    if (state.branch !== before.branch || state.upstream !== before.upstream || state.remote !== before.remote) throw new Error('分支或上游已变化，请重新预览。');
    const remoteHead = await this.resolveVersion(state.upstream), remote = await this.forceTree(remoteHead), local = await this.forceLocal(state, remote);
    const hashes = (files: Map<string, { sha: string }>) => new Map([...files].map(([p, v]) => [p, v.sha]));
    const extra = [...remote].filter(([p, v]) => local.has(p) && local.get(p)!.mode !== v.mode).map(([p]) => p).sort();
    return overwritePlan({ mode: 'git', source: `${state.remoteUrl} · ${state.upstream}（本地分支：${state.branch}）`, remoteHead, localHead: state.head,
      localCommits: state.ahead, stagedPaths: state.changes.filter(c => c.managed && c.index !== ' ' && c.index !== '?').map(c => c.path).sort() },
      hashes(local), hashes(remote), [this.root, this.scope, state.branch, state.upstream, state.upstreamRef, state.remoteUrl, state.operation,
        await this.text(['ls-files', '--stage', '-z']), [...local].sort(), [...remote].sort()], extra);
  }
  async forceRemote(expected: RemoteOverwritePlan): Promise<RemoteOverwriteResult> {
    const plan = await this.previewForceRemote();
    if (plan.fingerprint !== expected.fingerprint) throw new Error('本地笔记、暂存区、分支或远端已变化，请重新预览远端覆盖。');
    const state = await this.snapshot(); this.forceState(state);
    const target = await this.forceTree(plan.remoteHead), local = await this.forceLocal(state, target);
    const parent = this.runtime.path.join(this.gitDir, 'vault-bridge-backups');
    await this.runtime.fs.mkdir(parent, { recursive: true });
    const backup = await this.runtime.fs.mkdtemp(this.runtime.path.join(parent, 'remote-'));
    const saveBackup = async (file: string, bytes: Uint8Array) => {
      const full = this.runtime.path.join(backup, file);
      await this.runtime.fs.mkdir(this.runtime.path.dirname(full), { recursive: true });
      const handle = await this.runtime.fs.open(full, 'w', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (this.repoHash(new Uint8Array(await this.runtime.fs.readFile(full)), state.head) !== this.repoHash(bytes, state.head)) throw new Error('备份文件校验失败，已停止覆盖。');
    };
    for (const [file, value] of local) {
      const bytes = new Uint8Array(await this.runtime.fs.readFile(this.runtime.path.join(this.root, file)));
      if (this.repoHash(bytes, state.head) !== value.sha) throw new Error('笔记在备份时变化，请重新预览。');
      await saveBackup(this.runtime.path.join('files', file), bytes);
    }
    const indexPath = (await this.text(['rev-parse', '--git-path', 'index'])).trim();
    await saveBackup('index', new Uint8Array(await this.runtime.fs.readFile(this.runtime.path.resolve(this.root, indexPath))));
    const staged = await this.text(['ls-files', '--stage', '-z']);
    for (const entry of staged.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), file = entry.slice(tab + 1), sha = entry.slice(0, tab).split(' ')[1]!;
      if (!plan.stagedPaths.includes(file)) continue;
      await saveBackup(this.runtime.path.join('index-blobs', sha), await this.raw(['cat-file', 'blob', sha]));
    }
    await saveBackup('manifest.json', new TextEncoder().encode(JSON.stringify({ version: 1, plan, local: [...local], staged })));
    // Verify the complete review again after the backup, before changing HEAD.
    if ((await this.previewForceRemote()).fingerprint !== plan.fingerprint) throw new Error('备份期间本地或远端已变化，请重新预览。');
    const backupBranch = `vault-bridge-backup/${Date.now()}-${this.runtime.path.basename(backup)}`;
    await this.text(['branch', backupBranch, plan.localHead]);
    const marker = this.runtime.path.join(this.gitDir, 'vault-bridge-force-remote.json');
    const savedMarker = this.runtime.path.join(backup, 'pending.json');
    await saveBackup('pending.json', new TextEncoder().encode(JSON.stringify({ backup, backupBranch, remoteHead: plan.remoteHead })));
    await this.runtime.fs.rename(savedMarker, marker);
    // Mixed reset aligns the branch/index without touching settings or layouts.
    await this.text(['reset', '--mixed', '--quiet', plan.remoteHead]);
    for (const change of plan.changes) {
      if (this.cancelled) throw new Error('强制覆盖已取消，备份已保留，请重新预览。');
      await this.checkFiles([change.path]);
      const full = this.runtime.path.join(this.root, change.path);
      let before: Uint8Array | null = null;
      try { before = new Uint8Array(await this.runtime.fs.readFile(full)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((before === null ? null : this.repoHash(before, plan.remoteHead)) !== change.before) throw new Error('覆盖期间笔记被编辑，已停止。请重新预览；备份及原提交已保留。');
      if (this.cancelled) throw new Error('强制覆盖已取消，备份已保留，请重新预览。');
      if (change.target === null) await this.runtime.fs.unlink(full);
      else {
        const bytes = await this.raw(['cat-file', 'blob', change.target]);
        if (this.repoHash(bytes, plan.remoteHead) !== change.target) throw new Error('远端文件校验失败，已停止。');
        await this.runtime.fs.mkdir(this.runtime.path.dirname(full), { recursive: true });
        const temp = await this.runtime.fs.mkdtemp(this.runtime.path.join(this.runtime.path.dirname(full), '.vault-bridge-force-'));
        try {
          const file = this.runtime.path.join(temp, 'file');
          await this.runtime.fs.writeFile(file, bytes, { mode: target.get(change.path)!.mode ? 0o700 : 0o600 });
          let latest: Uint8Array | null = null;
          try { latest = new Uint8Array(await this.runtime.fs.readFile(full)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (this.cancelled || (latest === null ? null : this.repoHash(latest, plan.remoteHead)) !== change.before) throw new Error('覆盖期间笔记变化或操作取消，请重新预览；备份已保留。');
          await this.runtime.fs.rename(file, full);
        } finally { await this.runtime.fs.rm(temp, { recursive: true, force: true }); }
      }
    }
    await this.text(['fetch', '--prune', state.remote]);
    if (await this.resolveVersion(state.upstream) !== plan.remoteHead) throw new Error('远端在覆盖期间更新，请重新预览；备份已保留。');
    const final = await this.snapshot(), files = await this.forceLocal(final, target);
    if (final.branch !== state.branch || final.upstream !== state.upstream || final.head !== plan.remoteHead || final.changes.some(c => c.index !== ' ' && c.index !== '?') || files.size !== target.size || [...target].some(([p, v]) => files.get(p)?.sha !== v.sha || files.get(p)?.mode !== v.mode)) throw new Error('覆盖期间笔记、暂存区或分支已变化，请重新预览；备份已保留。');
    await this.runtime.fs.unlink(marker);
    return { changed: plan.changes.length, backup, backupBranch };
  }
  async restorePlan(version: string): Promise<GitRestorePlan> {
    const state = await this.snapshot(); this.ensureIdle(state);
    if (state.changes.some(c => c.managed)) throw new Error('请先提交笔记修改，再选择要恢复的版本。');
    const sha = await this.resolveVersion(version);
    const target = new Set(await this.treePaths(sha));
    const candidates = [...new Set([...await this.treePaths(state.head), ...target])];
    let paths: string[] = [];
    if (candidates.length) {
      const allowed = new Set(candidates);
      paths = (await this.text(['diff', '--name-only', '--no-renames', '-z', state.head, sha])).split('\0').filter(p => allowed.has(p));
    }
    return { sha, head: state.head, paths, deletions: paths.filter(p => !target.has(p)), fingerprint: hashText(JSON.stringify([state.head, sha, paths])) };
  }
  async restoreVersion(plan: GitRestorePlan): Promise<void> {
    const current = await this.restorePlan(plan.sha);
    if (current.fingerprint !== plan.fingerprint) throw new Error('版本或文件清单已变化，请重新预览恢复计划。');
    if (!current.paths.length) return;
    await this.checkFiles(current.paths);
    const input = this.pathInput(current.paths);
    await this.text(['restore', `--source=${current.sha}`, '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], false, input);
    await this.text(['commit', '--only', '-m', `Restore notes from ${current.sha.slice(0, 12)}`, '--pathspec-from-file=-', '--pathspec-file-nul'], false, input);
  }
  async conflict(path: string): Promise<GitConflict> {
    if (!relativeFile(path)) throw new Error('冲突路径无效。');
    await this.checkParents(path);
    const state = await this.snapshot();
    if (!state.changes.some(c => c.path === path && c.conflict)) throw new Error('这个文件已不是未解决冲突，请刷新。');
    const stages = new Map<number, string>();
    for (const entry of (await this.text(['ls-files', '--unmerged', '-z', '--', path])).split('\0').filter(Boolean)) {
      const match = entry.match(/^[0-7]+ ([a-f\d]+) ([123])\t/);
      if (!match) throw new Error('Git 冲突阶段数据无效。');
      stages.set(Number(match[2]), match[1]!);
    }
    const readStage = (stage: number): Promise<Uint8Array | null> => stages.has(stage) ? this.raw(['cat-file', 'blob', stages.get(stage)!]) : Promise.resolve(null);
    const [ours, theirs] = await Promise.all([readStage(2), readStage(3)]);
    let worktree: Uint8Array | null = null;
    try {
      const full = this.runtime.path.join(this.root, path), stat = await this.runtime.fs.lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('请在系统终端处理符号链接或特殊文件的冲突。');
      worktree = new Uint8Array(await this.runtime.fs.readFile(full));
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const fingerprint = hashText(JSON.stringify([state.head, ours && blobHash(ours), theirs && blobHash(theirs), worktree && blobHash(worktree)]));
    const preview = (bytes: Uint8Array | null) => bytes === null ? null : bytes.includes(0) ? '（二进制文件）' : new TextDecoder().decode(bytes).slice(0, 60_000);
    return { path, operation: state.operation, fingerprint, ours: preview(ours), theirs: preview(theirs), worktree: preview(worktree) };
  }
  async resolveConflict(expected: GitConflict, choice: 'ours' | 'theirs' | 'manual'): Promise<string> {
    const current = await this.conflict(expected.path);
    if (current.fingerprint !== expected.fingerprint) throw new Error('冲突内容已变化，请刷新后重新选择。');
    if (choice === 'manual' && current.worktree !== null) {
      const content = await this.runtime.fs.readFile(this.runtime.path.join(this.root, expected.path));
      if (!content.includes(0) && /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(content.toString('utf8'))) throw new Error('文件仍有冲突标记，请先编辑并保存。');
    }
    const folder = this.runtime.path.join(this.gitDir, 'vault-bridge-backups', `${Date.now()}-${hashText(expected.path).slice(0, 8)}`);
    await this.runtime.fs.mkdir(folder, { recursive: true });
    await this.runtime.fs.writeFile(this.runtime.path.join(folder, 'path.txt'), expected.path);
    for (const [name, stage] of [['ours', 2], ['theirs', 3]] as const) {
      try { await this.runtime.fs.writeFile(this.runtime.path.join(folder, name), await this.raw(['show', `:${stage}:${expected.path}`])); } catch (error) {
        if ((name === 'ours' ? current.ours : current.theirs) !== null) throw error;
      }
    }
    if (current.worktree !== null) await this.runtime.fs.copyFile(this.runtime.path.join(this.root, expected.path), this.runtime.path.join(folder, 'worktree'));
    if ((await this.conflict(expected.path)).fingerprint !== expected.fingerprint) throw new Error('冲突内容在备份时发生变化，请刷新重试。');
    let stage = true;
    if (choice !== 'manual') {
      if (current[choice] === null) { await this.text(['rm', '--', expected.path]); stage = false; }
      else await this.text(['checkout', `--${choice}`, '--', expected.path]);
    }
    if (stage) await this.text(['add', '-A', '--', expected.path]);
    return folder;
  }
  async finishMerge(review: GitStagedReview): Promise<void> {
    const state = await this.snapshot();
    if (state.changes.some(c => c.conflict)) throw new Error('仍有未解决冲突。');
    if (state.operation !== 'merge') throw new Error('当前没有待完成的 merge，请在终端中检查其他 Git 操作。');
    if ((await this.stagedReview()).fingerprint !== review.fingerprint) throw new Error('暂存区已变化，请重新核对合并清单。');
    await this.text(['commit', '--no-edit']);
  }
  async stagedReview(): Promise<GitStagedReview> {
    const raw = await this.text(['diff', '--cached', '--raw', '--no-abbrev', '-z']);
    const head = await this.optional(['rev-parse', '--verify', 'HEAD']);
    const mergeHead = await this.optional(['rev-parse', '--verify', 'MERGE_HEAD']);
    return { summary: redactGit(await this.text(['diff', '--cached', '--stat'])), fingerprint: hashText(head + '\0' + mergeHead + '\0' + raw) };
  }
  async console(command: string): Promise<string> { return redactGit(await this.text(parseGitCommand(command))); }
  async openTerminal(): Promise<void> {
    const { child, process: proc, Buffer } = this.runtime;
    const command: [string, string[]] = proc.platform === 'darwin' ? ['/usr/bin/open', ['-a', 'Terminal', this.root]]
      : proc.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(`Set-Location -LiteralPath '${this.root.replaceAll("'", "''")}'`, 'utf16le').toString('base64')]]
      : ['x-terminal-emulator', []];
    await new Promise<void>((resolve, reject) => {
      const terminal = child.spawn(command[0], command[1], { cwd: this.root, detached: true, stdio: 'ignore', windowsHide: false });
      terminal.once('error', () => reject(new Error('无法打开系统终端，请使用 Git 命令行入口，或手动在此目录打开终端。')));
      terminal.once('spawn', () => { terminal.unref(); resolve(); });
    });
  }
}
