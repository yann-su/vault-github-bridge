import { FileSystemAdapter, MarkdownView, Menu, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import { SyncEngine, type SyncResult } from './engine';
import { GitHubError, GitHubRemote, type Transport } from './github';
import { DEFAULT_EXTENSIONS, hashText, inScope, safePath, type Conflict, type HistoryEntry, type Scope } from './model';
import { ObsidianLocal, ensureVaultFolder } from './obsidian-local';
import { arrayBuffer, DiskStateStore } from './storage';
import { BridgeSettingsTab, ConflictsModal, HistoryModal, PreviewModal, SettingsModal, StatusModal } from './ui';
import { isSaveShortcut, SaveSyncQueue } from './save-sync';
import { NativeGit } from './native-git';
import { NativeBranchesModal, NativeCommitModal, NativeConflictsModal, NativeConsoleModal, NativeRepositoryModal, NativeVersionsModal } from './native-ui';

export interface BridgeSettings {
  owner: string;
  repo: string;
  branch: string;
  secretName: string;
  device: string;
  syncOnStartup: boolean;
  autoSync: boolean;
  readOnly: boolean;
  intervalSeconds: number;
  idleSeconds: number;
  maxFileMB: number;
  excludedFolders: string;
  gitExecutable: string;
}
export const DEFAULT_SETTINGS: BridgeSettings = {
  owner: '', repo: '', branch: 'main', secretName: 'vault-github-bridge',
  device: '我的设备', syncOnStartup: true, autoSync: false, readOnly: false,
  intervalSeconds: 90, idleSeconds: 10, maxFileMB: 10, excludedFolders: '', gitExecutable: 'git'
};
interface Context { engine: SyncEngine; local: ObsidianLocal; store: DiskStateStore; scope: Scope }

export default class GitHubBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  busy = false;
  statusText = '尚未连接';
  nativeGit: NativeGit | null = null;
  nativeGitError = '';
  nativeBranch = '';
  private detectingGit = false;
  private apiNeedsReview = false;
  private statusEl!: HTMLElement;
  private ribbon!: HTMLElement;
  private context: Context | null = null;
  private debounce: number | undefined;
  private nextPoll = 0;
  private blockedUntil = 0;
  private rateLimitedUntil = 0;
  private failures = 0;
  private unloaded = false;
  private startupPending = true;
  private launchSyncPending = false;
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
    await this.detectNativeGit();
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('github-bridge-status');
    this.statusEl.addEventListener('click', event => this.showSyncMenu(event));
    this.ribbon = this.addRibbonIcon('git-pull-request', 'GitHub：打开同步菜单', event => this.showSyncMenu(event));
    this.setStatus(this.nativeGitError || (this.configured() ? '等待同步' : '尚未连接'));
    this.saveQueue = new SaveSyncQueue({
      enabled: () => !this.apiNeedsReview && (this.settings.autoSync || this.launchSyncPending && this.settings.syncOnStartup) && this.configured() && !this.unloaded && !this.startupPending,
      busy: () => this.busy || this.detectingGit || document.visibilityState !== 'visible' || !navigator.onLine,
      retryAt: manual => this.retryAt(manual),
      now: () => Date.now(),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: timer => window.clearTimeout(timer),
      sync: manual => this.sync(manual, false),
      pending: () => {
        window.clearTimeout(this.debounce); this.debounce = undefined;
        const serverWait = Math.ceil((this.retryAt(true) - Date.now()) / 1000);
        this.setStatus(this.busy ? '已排队，当前同步结束后继续…' : serverWait > 0 ? `GitHub 正在限流，约 ${serverWait} 秒后继续同步。` : '准备同步…');
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
    this.addCommand({ id: 'show-status', name: '查看同步状态', callback: () => { void this.showStatus(); } });
    this.addCommand({ id: 'show-menu', name: '打开同步菜单', callback: () => this.showSyncMenu() });
    this.addCommand({ id: 'open-settings', name: '打开同步设置', callback: () => this.showSettings() });
    for (const [id, name, action] of [
      ['git-repository', 'Git：仓库管理', () => this.showNativeRepository()],
      ['git-branches', 'Git：分支管理', () => this.showNativeBranches()],
      ['git-commit', 'Git：提交笔记修改', () => this.showNativeCommit()],
      ['git-versions', 'Git：历史与版本恢复', () => this.showNativeVersions()],
      ['git-console', 'Git：命令行与系统终端', () => this.showNativeConsole()]
    ] as const) this.addCommand({ id, name, checkCallback: checking => {
      if (!this.nativeGit) return false;
      if (!checking) void action();
      return true;
    } });
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
      void this.saveQueue.request(() => view.save(), true);
    }, { capture: true });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule(1000);
    });
    this.registerDomEvent(window, 'focus', () => this.schedule(1000));
    this.registerDomEvent(window, 'online', () => this.schedule(1000));
    this.registerInterval(window.setInterval(() => {
      if (Date.now() >= this.nextPoll && document.visibilityState === 'visible') this.schedule(1000, false);
    }, 15_000));
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded || !this.startupPending) return;
      this.startupPending = false;
      this.nextPoll = Date.now() + this.settings.intervalSeconds * 1000;
      this.launchSyncPending = this.settings.syncOnStartup && this.configured();
      if (this.launchSyncPending) this.schedule(1500);
    });
  }
  onunload(): void {
    this.unloaded = true;
    this.launchSyncPending = false;
    window.clearTimeout(this.debounce);
    this.context?.engine.cancel();
    this.nativeGit?.cancel();
    this.saveQueue?.cancel();
  }
  setStatus(message: string): void {
    this.statusText = message;
    if (this.unloaded) return;
    const label = `${message}${this.settings.autoSync ? '' : ' · 自动同步已暂停'}`;
    const mode = this.nativeGit ? `Git · ${this.nativeBranch || '未选择分支'}` : this.nativeGitError ? 'Git 不可用' : 'GitHub';
    this.statusEl?.setText(`${mode} · ${label}`);
    this.ribbon?.setAttribute('aria-label', `${mode}：${label}（点击打开同步菜单）`);
  }
  async showSyncMenu(event?: MouseEvent): Promise<void> {
    if (!this.busy && Platform.isDesktopApp) await this.detectNativeGit();
    const menu = new Menu().setUseNativeMenu(false);
    const mode = this.nativeGit ? `Git · ${this.nativeBranch || '分离 HEAD'}` : this.nativeGitError ? '本机 Git 不可用' : 'GitHub';
    menu.addItem(item => item.setTitle(`${mode}：${this.statusText.slice(0, 120)}`).setDisabled(true));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(this.busy ? '正在同步，请稍候…' : '立即同步').setIcon('refresh-cw')
      .setDisabled(this.busy || !this.configured()).onClick(() => this.sync(true)));
    menu.addItem(item => item.setTitle('查看同步状态').setIcon('info').onClick(() => this.showStatus()));
    if (this.nativeGit) {
      menu.addItem(item => item.setTitle('Git 仓库管理').setIcon('folder-git-2').setDisabled(this.busy).onClick(() => this.showNativeRepository()));
      menu.addItem(item => item.setTitle('分支管理').setIcon('git-branch').setDisabled(this.busy).onClick(() => this.showNativeBranches()));
      menu.addItem(item => item.setTitle('提交笔记修改').setIcon('git-commit-horizontal').setDisabled(this.busy).onClick(() => this.showNativeCommit()));
      menu.addItem(item => item.setTitle('历史与版本恢复').setIcon('history').setDisabled(this.busy).onClick(() => this.showNativeVersions()));
      menu.addItem(item => item.setTitle('Git 命令行 / Shell').setIcon('terminal').setDisabled(this.busy).onClick(() => this.showNativeConsole()));
    } else menu.addItem(item => item.setTitle('预览同步计划').setIcon('list-checks').setDisabled(this.busy || !this.configured())
      .onClick(() => this.previewConnection()));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('处理同步冲突').setIcon('git-merge').setDisabled(this.busy || !this.configured())
      .onClick(() => this.showConflicts()));
    if (!this.nativeGit) menu.addItem(item => item.setTitle('查看本机恢复版本').setIcon('history').setDisabled(this.busy || !this.configured())
      .onClick(() => this.showHistory()));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(this.settings.autoSync ? '暂停自动同步' : '恢复自动同步')
      .setIcon(this.settings.autoSync ? 'pause' : 'play').setDisabled(this.busy || !this.configured())
      .onClick(() => this.toggleAutoSync()));
    menu.addItem(item => item.setTitle('同步设置').setIcon('settings').onClick(() => this.showSettings()));
    if (event) menu.showAtMouseEvent(event);
    else {
      const rect = this.ribbon.getBoundingClientRect();
      menu.showAtPosition({ x: rect.right, y: rect.bottom }, this.ribbon.ownerDocument);
    }
  }
  showSettings(): void { new SettingsModal(this.app, this).open(); }
  async toggleAutoSync(): Promise<void> {
    await this.task(async () => {
      const next = { ...this.settings, autoSync: !this.settings.autoSync };
      await this.saveData(next);
      this.settings = next;
      if (!next.autoSync) this.launchSyncPending = false;
      window.clearTimeout(this.debounce); this.debounce = undefined;
      this.saveQueue.wake();
      this.setStatus(this.statusText);
      if (next.autoSync) this.schedule(1500);
      new Notice(next.autoSync ? '自动同步已恢复。' : '自动同步已暂停，仍可手动同步。');
    });
  }
  configured(): boolean { return !this.nativeGitError && Boolean(this.nativeGit || this.settings.owner && this.settings.repo && this.settings.branch); }
  private async detectNativeGit(): Promise<void> {
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter) || this.detectingGit || this.unloaded) return;
    this.detectingGit = true;
    try {
      const previous = this.nativeGit;
      const next = await NativeGit.detect(this.app.vault.adapter.getBasePath(), this.scope(), undefined, this.settings.gitExecutable);
      this.nativeGit = next; this.nativeGitError = '';
      if (next) {
        this.apiNeedsReview = false;
        const state = await next.snapshot(); this.nativeBranch = state.branch;
        this.context?.engine.cancel(); this.context = null;
      } else {
        this.nativeBranch = '';
        if (previous) {
          this.apiNeedsReview = true; this.launchSyncPending = false;
          window.clearTimeout(this.debounce); this.debounce = undefined;
          this.setStatus('本地 Git 已移除，请预览确认 GitHub API 连接');
        }
      }
      previous?.cancel();
    } catch (e) {
      this.nativeGit = null; this.nativeGitError = e instanceof Error ? e.message : '无法检测本地 Git 仓库。';
      this.setStatus(this.nativeGitError);
    } finally { this.detectingGit = false; this.saveQueue?.wake(); }
  }
  async showStatus(): Promise<void> {
    if (this.nativeGit) await this.showNativeRepository();
    else if (this.nativeGitError) new Notice(this.nativeGitError, 8000);
    else new StatusModal(this.app, this).open();
  }
  private async saveActiveEditor(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) await view.save();
  }
  async nativeAction<T>(job: (git: NativeGit) => Promise<T>, write = false): Promise<T | undefined> {
    return this.task(async () => {
      if (!this.nativeGit) throw new Error('当前笔记库没有可用的本机 Git 仓库。');
      if (write && this.settings.readOnly) throw new Error('当前只接收更新，请在设置中关闭后再修改 Git 仓库。');
      if (write) await this.saveActiveEditor();
      const result = await job(this.nativeGit);
      this.nativeBranch = (await this.nativeGit.snapshot()).branch;
      if (write) { this.failures = 0; this.blockedUntil = 0; this.setStatus('Git 操作已完成'); }
      return result;
    });
  }
  async showNativeRepository(): Promise<void> {
    const state = await this.nativeAction(g => g.snapshot());
    if (state) new NativeRepositoryModal(this.app, this, state).open();
  }
  async showNativeCommit(): Promise<void> {
    const state = await this.nativeAction(async g => { await this.saveActiveEditor(); return g.snapshot(); });
    if (state) new NativeCommitModal(this.app, this, state).open();
  }
  async showNativeBranches(version = 'HEAD'): Promise<void> {
    const data = await this.nativeAction(async g => ({ branches: await g.branches(), state: await g.snapshot() }));
    if (data) new NativeBranchesModal(this.app, this, data.branches, data.state, version).open();
  }
  async showNativeVersions(): Promise<void> {
    const data = await this.nativeAction(async g => ({ versions: await g.versions(), state: await g.snapshot() }));
    if (data) new NativeVersionsModal(this.app, this, data.versions, data.state.head).open();
  }
  async showNativeConflicts(): Promise<void> {
    const state = await this.nativeAction(g => g.snapshot());
    if (state) new NativeConflictsModal(this.app, this, state).open();
  }
  showNativeConsole(): void { if (this.nativeGit) new NativeConsoleModal(this.app, this).open(); }
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
    if (!this.nativeGit && next.owner && next.repo) new GitHubRemote(async () => { throw new Error('unused'); }, next.owner, next.repo, next.branch, this.scope(next), next.device);
    this.busy = true;
    try {
      await this.saveData(next);
      this.settings = next;
      this.context = null;
      await this.detectNativeGit();
      this.failures = 0; this.blockedUntil = 0;
      this.setStatus(this.nativeGitError || (this.nativeGit ? '本机 Git 配置已保存' : '配置已保存；首次连接请先预览'));
      this.schedule(1500);
    } finally { this.busy = false; this.saveQueue.wake(); }
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
    if (this.unloaded || this.startupPending || this.apiNeedsReview || !(this.settings.autoSync || this.launchSyncPending && this.settings.syncOnStartup) || !this.configured()) return;
    if (this.debounce !== undefined) {
      // Keep the launch deadline even if the user starts typing immediately.
      if (!replace || this.launchSyncPending) return;
      window.clearTimeout(this.debounce);
    }
    this.debounce = window.setTimeout(() => {
      this.debounce = undefined;
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void this.saveQueue.request(async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file && inScope(view.file.path, this.scope())) await view.save();
      });
    }, Math.max(delay, this.retryAt(false) - Date.now()));
  }
  private retryAt(manual: boolean): number {
    const server = this.nativeGit || this.nativeGitError ? 0 : this.rateLimitedUntil;
    return manual ? server : Math.max(server, this.blockedUntil);
  }
  private async task<T>(job: () => Promise<T>): Promise<T | undefined> {
    if (this.busy || this.detectingGit) { new Notice('已有操作正在进行，请稍候。'); return; }
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
    if (this.busy || this.detectingGit) { if (manual) new Notice('已有同步正在进行。'); return; }
    const retryAt = this.retryAt(manual);
    if (Date.now() < retryAt) {
      if (manual) new Notice(`GitHub 正在限流，约 ${Math.ceil((retryAt - Date.now()) / 1000)} 秒后可重试。`);
      return;
    }
    if (manual || this.launchSyncPending) {
      this.launchSyncPending = false;
      window.clearTimeout(this.debounce); this.debounce = undefined;
    }
    if (manual) this.saveQueue.clearPending();
    this.busy = true;
    try {
      if (!this.configured() && !manual) return;
      if (this.nativeGitError) throw new Error(this.nativeGitError);
      if (!this.nativeGit && this.apiNeedsReview) throw new Error('本地 Git 已移除，请先预览确认 GitHub API 连接。');
      if (this.nativeGit) {
        await this.saveActiveEditor();
        this.setStatus('正在通过本机 Git 同步…');
        const result = await this.nativeGit.sync(this.settings.device, this.settings.readOnly);
        const state = await this.nativeGit.snapshot();
        this.nativeBranch = state.branch;
        this.failures = 0; this.blockedUntil = 0;
        this.setStatus(result.conflicts ? `${result.conflicts} 项 Git 合并冲突，已保留双方版本；请打开“处理同步冲突”` :
          result.noUpstream ? '当前分支未设置上游，请到分支管理发布或跟踪分支' :
          result.divergent ? '只接收更新：分支已分叉，请关闭只接收更新后同步以合并上游' :
          `${result.merged ? '已合并上游并同步' : '已同步'} · commit ${result.committed} ↑${result.pushed} ↓${result.pulled}`);
        const signature = result.conflicts ? JSON.stringify(['native', state.head, state.operation, state.changes.filter(c => c.conflict).map(c => c.path)]) : '';
        if (manual && notifySuccess || signature && signature !== this.lastConflictSignature) new Notice(this.statusText, result.conflicts ? 8000 : 6000);
        this.lastConflictSignature = signature;
        return;
      }
      const { engine } = this.getContext();
      if (!(await engine.inspect()).approved) {
        this.setStatus('请先预览并建立连接');
        if (manual) new Notice('请打开同步菜单，点击“预览同步计划”建立首次连接。');
        return;
      }
      const result = await engine.run();
      continueQueue = result.deferred > 0;
      this.failures = 0; this.blockedUntil = 0;
      this.rateLimitedUntil = 0;
      this.setStatus(this.describe(result));
      if (manual && notifySuccess) new Notice(this.statusText, 6000);
      const signature = result.conflicts ? JSON.stringify((await engine.inspect()).conflicts.map(c => [c.path, c.local, c.remote])) : '';
      if (!(manual && notifySuccess) && signature && signature !== this.lastConflictSignature) new Notice(`GitHub：${result.conflicts} 项冲突已保留双方内容。请打开同步菜单选择“处理同步冲突”。`, 8000);
      this.lastConflictSignature = signature;
    } catch (error) {
      this.failures++;
      this.blockedUntil = Date.now() + Math.min(900_000, 30_000 * 2 ** Math.min(this.failures - 1, 5));
      if (error instanceof GitHubError && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + error.retryAfterMs);
      }
      const message = error instanceof Error ? error.message : '同步失败，请稍后重试。';
      this.setStatus(message);
      if (manual) new Notice(message, 8000);
    } finally {
      this.busy = false;
      this.nextPoll = Math.max(this.retryAt(false), Date.now() + this.settings.intervalSeconds * 1000);
      this.saveQueue.wake();
      if (continueQueue) this.schedule(this.settings.idleSeconds * 1000);
    }
  }
  async previewConnection(): Promise<void> {
    if (this.nativeGit) { await this.showNativeRepository(); return; }
    const context = await this.task(async () => {
      const context = this.getContext();
      if ((await context.engine.inspect()).pending) throw new Error('有未完成的同步，请先点击“立即同步”恢复。');
      this.setStatus('正在预览首次同步…');
      const plan = await context.engine.preview();
      this.setStatus('预览已完成，等待确认');
      return { context, plan };
    });
    if (context) new PreviewModal(this.app, context.plan, async () => {
      const approved = await this.task(async () => { await context.context.engine.approve(context.plan.deletionReview); return true; });
      if (!approved) return;
      this.apiNeedsReview = false;
      this.blockedUntil = 0;
      await this.sync(true);
    }).open();
  }
  async showConflicts(): Promise<void> {
    if (this.nativeGit) { await this.showNativeConflicts(); return; }
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
    if (this.nativeGit) { await this.showNativeVersions(); return; }
    const result = await this.task(async () => (await this.getContext().engine.inspect()).history);
    if (result) new HistoryModal(this.app, this, result).open();
  }
}
