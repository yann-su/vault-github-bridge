import {
  blobHash, inScope, newState, planSync, validatePaths,
  type Conflict, type DeletionReview, type Hash, type LocalPort, type Plan, type RemotePort,
  type RemoteSnapshot, type Scope, type StatePort, type SyncState
} from './model';

export interface SyncResult { uploaded: number; downloaded: number; conflicts: number; deferred: number }
export class DeletionReviewError extends Error {
  constructor(public review: DeletionReview) {
    super(`检测到 ${review.items.length} 项批量删除，已暂停本轮同步。请打开“预览同步计划”核对后确认。`);
  }
}
export class SyncEngine {
  private state: SyncState | null = null;
  private running = false;
  private cancelled = false;
  cancel(): void { this.cancelled = true; }
  private guard(): void { if (this.cancelled) throw new Error('插件已停止；下次启动会恢复未完成的同步。'); }
  constructor(private local: LocalPort, private remote: RemotePort, private store: StatePort,
    private binding: string, private scope: Scope, private readOnly = false,
    private progress: (message: string) => void = () => {}) {}
  private async load(): Promise<SyncState> {
    if (!this.state) this.state = await this.store.load() ?? newState(this.binding);
    return this.state;
  }
  async inspect(): Promise<SyncState> { return structuredClone(await this.load()); }
  async approve(deletions?: DeletionReview): Promise<void> {
    if (this.running) throw new Error('请等待当前同步完成。');
    const state = await this.load(); state.approved = true;
    if (deletions) state.deletionApproval = structuredClone(deletions.items);
    await this.store.save(state);
  }
  private async object(id: string): Promise<Uint8Array> {
    const cached = await this.store.get(id);
    if (cached) return cached;
    const data = await this.remote.blob(id);
    if (await this.store.put(data) !== id) throw new Error('文件对象校验失败。');
    return data;
  }
  private async localSnapshot(): Promise<Map<string, string>> {
    const state = await this.load(), files = new Map<string, string>();
    for (const file of await this.local.list()) {
      if (!inScope(file.path, this.scope)) continue;
      if (file.size > this.scope.maxBytes) throw new Error(`本地文件超过大小限制：${file.path}。请排除其文件夹或提高限制。`);
      const data = await this.local.read(file.path);
      if (data === null) throw new Error(`扫描时文件暂时不可用：${file.path}。已停止本轮同步，未将其视为删除；请确认文件已下载到本机。`);
      if (data.length > this.scope.maxBytes) throw new Error(`本地文件超过大小限制：${file.path}`);
      const id = blobHash(data);
      if (state.bases[file.path] !== id) await this.store.put(data);
      files.set(file.path, id);
    }
    validatePaths(files.keys());
    return files;
  }
  private async preparePlan(snapshot: RemoteSnapshot): Promise<Plan> {
    const state = await this.load(), local = await this.localSnapshot();
    // A file in one device can collide with a directory/case variant on another.
    validatePaths(new Set([...local.keys(), ...snapshot.files.keys()]));
    const plan = planSync(state.bases, local, snapshot.files, state.resolutions, this.readOnly);
    const deletions = plan.operations.filter(op => op.kind !== 'adopt' && op.target === null).map(op => ({
      path: op.path, kind: op.kind as 'push' | 'pull', local: local.get(op.path) ?? null, remote: snapshot.files.get(op.path) ?? null
    }));
    const tracked = Object.values(state.bases).filter(id => id !== null).length;
    if (deletions.length >= 10 || (deletions.length >= 3 && deletions.length >= tracked / 2)) plan.deletionReview = { items: deletions };
    return plan;
  }
  async preview(): Promise<Plan> {
    if (this.running) throw new Error('请等待当前同步完成。');
    this.running = true;
    try { return await this.preparePlan(await this.remote.snapshot()); }
    finally { this.running = false; }
  }
  private remember(path: string, sha: string, reason: string): void {
    const state = this.state!;
    if (state.history.some(entry => entry.path === path && entry.sha === sha)) return;
    state.history.push({ path, sha, reason, at: new Date().toISOString() });
    state.history = state.history.slice(-200);
  }
  private async applyPending(result: SyncResult): Promise<void> {
    const state = this.state!, pending = state.pending!;
    while (pending.operations.length) {
      this.guard();
      const operation = pending.operations[0]!;
      if (!inScope(operation.path, this.scope)) throw new Error('恢复日志的同步范围不匹配，已停止。');
      const current = await this.local.read(operation.path), currentHash = current === null ? null : blobHash(current);
      let accepted = false;
      if (operation.kind !== 'pull' || currentHash === operation.target) {
        // Uploaded snapshots are valid baselines even if the user has typed more since then.
        accepted = true;
      } else if (currentHash === operation.before) {
        if (current !== null) {
          this.remember(operation.path, await this.store.put(current), '远端覆盖前');
          await this.store.save(state);
        }
        const data = operation.target === null ? null : await this.object(operation.target);
        this.guard();
        accepted = await this.local.apply(operation.path, operation.before, data);
        if (accepted) result.downloaded++;
      }
      if (accepted) {
        state.bases[operation.path] = operation.target;
        state.conflicts = state.conflicts.filter(c => c.path !== operation.path);
        delete state.resolutions[operation.path];
        if (state.deletionApproval) state.deletionApproval = state.deletionApproval.filter(item => item.path !== operation.path);
        if (operation.kind === 'push') result.uploaded++;
        if (operation.target) {
          await this.object(operation.target);
          this.remember(operation.path, operation.target, operation.kind === 'push' ? '上传版本' : '同步版本');
        }
      } else result.deferred++;
      pending.operations.shift();
      await this.store.save(state);
    }
    state.lastHead = pending.candidate ?? pending.remoteHead;
    delete state.pending;
    await this.store.save(state);
  }
  private async recover(result: SyncResult): Promise<void> {
    const state = this.state!;
    if (!state.pending) return;
    this.progress('正在恢复上次同步…');
    if (state.pending.candidate) {
      const latest = await this.remote.snapshot();
      if (!await this.remote.contains(state.pending.candidate, latest.head)) {
        // Prepared but never published, or another writer won. No local writes have happened.
        delete state.pending;
        await this.store.save(state);
        return;
      }
    }
    await this.applyPending(result);
  }
  async run(): Promise<SyncResult> {
    if (this.running) throw new Error('已有同步正在进行。');
    this.running = true;
    // A failed save must never leave an uncheckpointed in-memory baseline in use.
    this.state = null;
    const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: 0, deferred: 0 };
    try {
      const state = await this.load();
      if (!state.approved) throw new Error('请先在设置中预览首次同步并建立连接。');
      await this.recover(result);
      for (let attempt = 0; attempt < 3; attempt++) {
        this.guard();
        this.progress('正在比较本地与 GitHub…');
        let snapshot = await this.remote.snapshot();
        if (state.lastHead && !await this.remote.contains(state.lastHead, snapshot.head)) {
          this.progress('正在重新核对 GitHub 最新版本…');
          snapshot = await this.remote.snapshot();
          if (!await this.remote.contains(state.lastHead, snapshot.head)) {
            throw new Error('复核后 GitHub 分支历史仍与上次不同，已保留本地笔记并暂停同步。请检查其他 Git 客户端是否重写了历史。');
          }
        }
        const plan = await this.preparePlan(snapshot);
        if (plan.deletionReview && plan.deletionReview.items.some(item => !state.deletionApproval?.some(approved =>
          approved.path === item.path && approved.kind === item.kind && approved.local === item.local && approved.remote === item.remote))) {
          throw new DeletionReviewError(plan.deletionReview);
        }
        // Persist all three versions before offering conflict resolution.
        for (const conflict of plan.conflicts) {
          for (const id of [conflict.base, conflict.local, conflict.remote]) if (id) await this.object(id);
          if (conflict.base) this.remember(conflict.path, conflict.base, '冲突：共同基线');
          if (conflict.remote) this.remember(conflict.path, conflict.remote, '冲突：GitHub 版本');
          if (conflict.local) this.remember(conflict.path, conflict.local, '冲突：本地版本');
        }
        state.conflicts = plan.conflicts;
        // Bound each publication so large first imports make durable progress
        // under GitHub's secondary content-creation limits.
        const allPushes = plan.operations.filter(op => op.kind === 'push');
        const pushes = allPushes.slice(0, 25), selected = new Set(pushes.map(op => op.path));
        const operations = plan.operations.filter(op => op.kind !== 'push' || selected.has(op.path));
        for (const op of operations) if (op.target) await this.object(op.target);
        const changes = [];
        for (const op of pushes) changes.push({ path: op.path, data: op.target === null ? null : await this.object(op.target) });
        const candidate = changes.length ? await this.remote.prepare(snapshot, changes) : null;
        this.guard();
        state.pending = { remoteHead: snapshot.head, candidate, operations };
        await this.store.save(state);
        if (candidate) {
          this.progress(`正在上传 ${changes.length} 个文件…`);
          try { await this.remote.advance(candidate); }
          catch (error) {
            // A lost response is ambiguous. Inspect ancestry before retrying any write.
            const latest = await this.remote.snapshot();
            if (!await this.remote.contains(candidate, latest.head)) {
              delete state.pending; await this.store.save(state);
              if (error instanceof Error && 'status' in error && [409, 422].includes(Number(error.status)) && attempt < 2) continue;
              throw error;
            }
          }
        }
        await this.applyPending(result);
        result.deferred += allPushes.length - pushes.length;
        state.lastSync = new Date().toISOString();
        await this.store.save(state);
        result.conflicts = state.conflicts.length;
        return result;
      }
      throw new Error('远端持续变化，请稍后再次同步。');
    } finally { this.running = false; this.state = null; }
  }
  async resolve(conflict: Conflict, choice: 'local' | 'remote'): Promise<void> {
    if (this.running) throw new Error('请等待同步完成后处理冲突。');
    this.state = null;
    const state = await this.load();
    if (choice === 'local' && this.readOnly) throw new Error('只更新模式不能上传本地版本。');
    const current = state.conflicts.find(c => c.path === conflict.path);
    if (!current || current.local !== conflict.local || current.remote !== conflict.remote) throw new Error('冲突已经变化，请重新打开冲突面板。');
    state.resolutions[conflict.path] = { local: conflict.local, remote: conflict.remote, choice };
    await this.store.save(state);
  }
  async cached(id: Hash): Promise<Uint8Array | null> { return id === null ? null : this.object(id); }
}
