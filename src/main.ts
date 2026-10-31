import { MarkdownView, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import { SyncEngine, type SyncResult } from './engine';
import { GitHubError, GitHubRemote, type Transport } from './github';
import { DEFAULT_EXTENSIONS, hashText, inScope, safePath, type Conflict, type HistoryEntry, type Scope } from './model';
import { ObsidianLocal, ensureVaultFolder } from './obsidian-local';
import { arrayBuffer, DiskStateStore } from './storage';
import { BridgeSettingsTab, ConflictsModal, HistoryModal, PreviewModal, StatusModal } from './ui';
import { isSaveShortcut, SaveSyncQueue } from './save-sync';

export interface BridgeSettings {
  owner: string;
  repo: string;
  branch: string;
  secretName: string;
  device: string;
  autoSync: boolean;
  readOnly: boolean;
  intervalSeconds: number;
  idleSeconds: number;
  maxFileMB: number;
  excludedFolders: string;
}
export const DEFAULT_SETTINGS: BridgeSettings = {
  owner: '', repo: '', branch: 'main', secretName: 'vault-github-bridge',
  device: '我的设备', autoSync: false, readOnly: false,
  intervalSeconds: 90, idleSeconds: 10, maxFileMB: 10, excludedFolders: ''
};
interface Context { engine: SyncEngine; local: ObsidianLocal; store: DiskStateStore; scope: Scope }

export default class GitHubBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  busy = false;
  statusText = '尚未连接';
  private statusEl!: HTMLElement;
  private ribbon!: HTMLElement;
  private context: Context | null = null;
  private debounce: number | undefined;
  private nextPoll = 0;
  private blockedUntil = 0;
  private failures = 0;
  private unloaded = false;
  private startupPending = true;
  private lastConflictSignature = '';
  private saveQueue!: SaveSyncQueue;
  private lastEditorChange: { path: string; at: number } | null = null;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<BridgeSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS };
    // Never retain arbitrary fields (particularly credentials) from data.json.
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof BridgeSettings>) {
      if (saved && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) Object.assign(this.settings, { [key]: saved[key] });
    }
    if (!saved?.device) this.settings.device = Platform.isIosApp ? 'iPhone 或 iPad' : Platform.isAndroidApp ? 'Android' : '电脑';
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('github-bridge-status');
    this.statusEl.addEventListener('click', () => { new StatusModal(this.app, this).open(); });
    this.ribbon = this.addRibbonIcon('git-pull-request', 'GitHub：立即同步', () => { void this.sync(true); });
    this.setStatus(this.configured() ? '等待同步' : '尚未连接');
    this.saveQueue = new SaveSyncQueue({
      enabled: () => this.settings.autoSync && this.configured() && !this.unloaded && !this.startupPending,
      busy: () => this.busy,
      retryAt: () => this.blockedUntil,
      now: () => Date.now(),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: timer => window.clearTimeout(timer),
      sync: () => this.sync(false),
      pending: () => {
        window.clearTimeout(this.debounce); this.debounce = undefined;
        this.setStatus(this.busy ? '已排队，当前同步结束后继续…' : '准备同步…');
      },
      error: error => {
        const message = error instanceof Error ? error.message : '保存未完成，尚未开始同步。';
        this.setStatus(message); new Notice(message, 6000);
      }
    });
    this.addSettingTab(new BridgeSettingsTab(this.app, this));
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => { void this.sync(true); } });
    this.addCommand({ id: 'preview-connection', name: '预览同步计划', callback: () => { void this.previewConnection(); } });
    this.addCommand({ id: 'show-conflicts', name: '处理同步冲突', callback: () => { void this.showConflicts(); } });
    this.addCommand({ id: 'show-history', name: '查看本机恢复版本', callback: () => { void this.showHistory(); } });
    this.addCommand({ id: 'show-status', name: '查看同步状态', callback: () => { new StatusModal(this.app, this).open(); } });
    const edited = (path: string, fromEditor = false) => {
      if (!this.settings.autoSync || !this.configured()) return;
      if (!inScope(path, this.scope())) return;
      const now = Date.now();
      if (fromEditor) this.lastEditorChange = { path, at: now };
      else if (this.lastEditorChange?.path === path && now - this.lastEditorChange.at < this.settings.idleSeconds * 1000) return;
      this.schedule(this.settings.idleSeconds * 1000);
    };
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      if (info.file) edited(info.file.path, true);
    }));
    this.registerEvent(this.app.vault.on('modify', file => edited(file.path)));
    this.registerEvent(this.app.vault.on('create', file => edited(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => edited(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, old) => { edited(file.path); edited(old); }));
    this.registerDomEvent(window, 'keydown', event => {
      if (!isSaveShortcut(event)) return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || !view.editor.hasFocus() || !inScope(view.file.path, this.scope())) return;
      // Let Obsidian handle its normal save too; await the public save API so
      // the engine cannot read the old disk contents before the editor flushes.
      void this.saveQueue.request(() => view.save());
    }, { capture: true });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule(1000);
    });
    this.registerDomEvent(window, 'focus', () => this.schedule(1000));
    this.registerDomEvent(window, 'online', () => this.schedule(1000));
    this.registerInterval(window.setInterval(() => {
      if (Date.now() >= this.nextPoll && document.visibilityState === 'visible') this.schedule(1000, false);
    }, 15_000));
    this.app.workspace.onLayoutReady(() => { this.startupPending = false; this.schedule(1500); });
  }
  onunload(): void {
    this.unloaded = true;
    window.clearTimeout(this.debounce);
    this.context?.engine.cancel();
    this.saveQueue?.cancel();
  }
  setStatus(message: string): void {
    this.statusText = message;
    if (this.unloaded) return;
    this.statusEl?.setText(`GitHub · ${message}`);
    this.ribbon?.setAttribute('aria-label', `GitHub：${message}（点击同步）`);
  }
  configured(): boolean { return Boolean(this.settings.owner && this.settings.repo && this.settings.branch); }
  private scope(settings = this.settings): Scope {
    return {
      extensions: DEFAULT_EXTENSIONS,
      excludedFolders: settings.excludedFolders.split(/\r?\n/).map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean),
      maxBytes: settings.maxFileMB * 1024 * 1024,
      configDir: this.app.vault.configDir
    };
  }
  async configure(settings: BridgeSettings): Promise<void> {
    if (this.busy) throw new Error('同步正在进行，请完成后再保存配置。');
    const next = { ...settings, owner: settings.owner.trim(), repo: settings.repo.trim(), branch: settings.branch.trim(), secretName: settings.secretName.trim(), device: settings.device.trim() };
    if (!Number.isFinite(next.intervalSeconds) || next.intervalSeconds < 60 || next.intervalSeconds > 3600) throw new Error('检查间隔应为 60～3600 秒。');
    if (!Number.isFinite(next.idleSeconds) || next.idleSeconds < 3 || next.idleSeconds > 300) throw new Error('停止编辑后的等待时间应为 3～300 秒。');
    if (!Number.isFinite(next.maxFileMB) || next.maxFileMB < 1 || next.maxFileMB > 20) throw new Error('第一版单文件限制应为 1～20 MB。');
    if (!next.device || next.device.length > 60) throw new Error('设备名称应为 1～60 个字符。');
    for (const folder of this.scope(next).excludedFolders) if (!safePath(folder)) throw new Error(`排除文件夹路径无效：${folder}`);
    // Validate repository fields without making an HTTP request.
    if (next.owner && next.repo) new GitHubRemote(async () => { throw new Error('unused'); }, next.owner, next.repo, next.branch, this.scope(next), next.device);
    await this.saveData(next);
    this.settings = next;
    this.context = null;
    this.failures = 0; this.blockedUntil = 0;
    this.setStatus('配置已保存；首次连接请先预览');
    this.schedule(1500);
    this.saveQueue.wake();
  }
  getContext(): Context {
    if (this.context) return this.context;
    if (!this.configured()) throw new Error('请先在插件设置中填写 GitHub 用户名、仓库与分支。');
    const settings = { ...this.settings }, scope = this.scope(settings);
    const binding = hashText(JSON.stringify({ owner: settings.owner.toLowerCase(), repo: settings.repo.toLowerCase(), branch: settings.branch, scope }));
    const store = new DiskStateStore(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/local/${binding}`, binding);
    const http: Transport = async (method, path, body) => {
      const token = this.app.secretStorage.getSecret(settings.secretName);
      if (!token) throw new Error('请在插件设置中选择 GitHub 凭据。凭据需要在每台设备分别设置。');
      const response = await requestUrl({
        url: `https://api.github.com${path}`, method, throw: false,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(method === 'GET' ? { 'Cache-Control': 'no-cache' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let json: unknown;
      try { json = JSON.parse(response.text); } catch { json = null; }
      return { status: response.status, headers: response.headers, json };
    };
    const local = new ObsidianLocal(this.app, store);
    const remote = new GitHubRemote(http, settings.owner, settings.repo, settings.branch, scope, settings.device);
    const engine = new SyncEngine(local, remote, store, binding, scope, settings.readOnly, message => this.setStatus(message));
    this.context = { engine, local, store, scope };
    return this.context;
  }
  private schedule(delay: number, replace = true): void {
    if (this.unloaded || this.startupPending || !this.settings.autoSync || !this.configured()) return;
    if (this.debounce !== undefined) {
      if (!replace) return;
      window.clearTimeout(this.debounce);
    }
    this.debounce = window.setTimeout(() => {
      this.debounce = undefined;
      if (document.visibilityState !== 'visible') return;
      void this.saveQueue.request(async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file && inScope(view.file.path, this.scope())) await view.save();
      });
    }, Math.max(delay, this.blockedUntil - Date.now()));
  }
  private async task<T>(job: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) { new Notice('已有操作正在进行，请稍候。'); return; }
    this.busy = true;
    try { return await job(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '操作失败。';
      this.setStatus(message);
      new Notice(message, 8000);
      return undefined;
    } finally { this.busy = false; this.saveQueue.wake(); }
  }
  private describe(result: SyncResult): string {
    if (result.conflicts) return `${result.conflicts} 项冲突待处理，↑${result.uploaded} ↓${result.downloaded}`;
    if (result.deferred) return `${result.deferred} 项待下轮同步，↑${result.uploaded} ↓${result.downloaded}`;
    return `${this.settings.readOnly ? '已检查更新' : '已同步'} · ↑${result.uploaded} ↓${result.downloaded}`;
  }
  async sync(manual: boolean, notifySuccess = true): Promise<void> {
    let continueQueue = false;
    if (this.startupPending || this.unloaded) return;
    if (this.busy) { if (manual) new Notice('已有同步正在进行。'); return; }
    if (Date.now() < this.blockedUntil) {
      if (manual) new Notice(`请等待约 ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} 秒后重试。`);
      return;
    }
    this.busy = true;
    try {
      if (!this.configured() && !manual) return;
      const { engine } = this.getContext();
      if (!(await engine.inspect()).approved) {
        this.setStatus('请先预览并建立连接');
        if (manual) new Notice('请到插件设置，点击“预览首次同步”。');
        return;
      }
      const result = await engine.run();
      continueQueue = result.deferred > 0;
      this.failures = 0; this.blockedUntil = 0;
      this.setStatus(this.describe(result));
      if (manual && notifySuccess) new Notice(this.statusText, 6000);
      const signature = result.conflicts ? JSON.stringify((await engine.inspect()).conflicts.map(c => [c.path, c.local, c.remote])) : '';
      if (!manual && signature && signature !== this.lastConflictSignature) new Notice(`GitHub：${result.conflicts} 项冲突已保留双方内容。请通过命令面板选择“处理同步冲突”。`, 8000);
      this.lastConflictSignature = signature;
    } catch (error) {
      this.failures++;
      this.blockedUntil = Date.now() + Math.max(error instanceof GitHubError ? error.retryAfterMs : 0, Math.min(900_000, 30_000 * 2 ** Math.min(this.failures - 1, 5)));
      const message = error instanceof Error ? error.message : '同步失败，请稍后重试。';
      this.setStatus(message);
      if (manual) new Notice(message, 8000);
    } finally {
      this.busy = false;
      this.nextPoll = Math.max(this.blockedUntil, Date.now() + this.settings.intervalSeconds * 1000);
      this.saveQueue.wake();
      if (continueQueue) this.schedule(this.settings.idleSeconds * 1000);
    }
  }
  async previewConnection(): Promise<void> {
    const context = await this.task(async () => {
      const context = this.getContext();
      if ((await context.engine.inspect()).pending) throw new Error('有未完成的同步，请先点击“立即同步”恢复。');
      this.setStatus('正在预览首次同步…');
      const plan = await context.engine.preview();
      this.setStatus('预览已完成，等待确认');
      return { context, plan };
    });
    if (context) new PreviewModal(this.app, context.plan, async () => {
      await this.task(async () => { await context.context.engine.approve(context.plan.deletionReview); });
      this.blockedUntil = 0;
      await this.sync(true);
    }).open();
  }
  async showConflicts(): Promise<void> {
    const result = await this.task(async () => {
      const context = this.getContext();
      return { context, state: await context.engine.inspect() };
    });
    if (result) new ConflictsModal(this.app, this, result.context.engine, result.state.conflicts).open();
  }
  async choose(conflict: Conflict, choice: 'local' | 'remote', keepCopy = false): Promise<void> {
    const completed = await this.task(async () => {
      const { engine } = this.getContext();
      if (keepCopy && conflict.local) await this.copyVersion(conflict.path, conflict.local, '冲突副本');
      await engine.resolve(conflict, choice);
      return true;
    });
    if (completed) { this.blockedUntil = 0; await this.sync(true); }
  }
  async keepAllConflicts(conflicts: Conflict[]): Promise<void> {
    const completed = await this.task(async () => {
      const { engine } = this.getContext();
      for (const conflict of conflicts) {
        if (conflict.local) await this.copyVersion(conflict.path, conflict.local, '冲突副本');
        await engine.resolve(conflict, 'remote');
      }
      return true;
    });
    if (completed) { this.blockedUntil = 0; await this.sync(true); }
  }
  private async copyVersion(path: string, id: string, category: string): Promise<void> {
    const { engine } = this.getContext();
    const bytes = await engine.cached(id);
    if (!bytes) throw new Error('找不到恢复副本。');
    const filename = path.split('/').at(-1)!;
    const dot = filename.lastIndexOf('.'), stem = filename.slice(0, dot), extension = filename.slice(dot);
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
    const target = `GitHub ${category}/${stem} (${suffix})${extension}`;
    await ensureVaultFolder(this.app.vault, `GitHub ${category}`);
    await this.app.vault.createBinary(target, arrayBuffer(bytes));
    new Notice(`已保存：${target}`);
  }
  async restoreCopy(entry: HistoryEntry): Promise<void> {
    await this.task(async () => { await this.copyVersion(entry.path, entry.sha, '恢复副本'); });
  }
  async showHistory(): Promise<void> {
    const result = await this.task(async () => (await this.getContext().engine.inspect()).history);
    if (result) new HistoryModal(this.app, this, result).open();
  }
}
