import { App, ButtonComponent, Modal, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type GitHubBridgePlugin from './main';
import type { BridgeSettings } from './main';
import type { SyncEngine } from './engine';
import { decode, type Conflict, type HistoryEntry, type Plan } from './model';

function button(el: HTMLElement, label: string, action: () => Promise<void> | void, primary = false): ButtonComponent {
  const component = new ButtonComponent(el).setButtonText(label);
  if (primary) component.setCta();
  component.onClick(async () => {
    component.setDisabled(true);
    try { await action(); } finally { component.setDisabled(false); }
  });
  return component;
}

export class BridgeSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitHubBridgePlugin) { super(app, plugin); }
  display(): void {
    renderSettings(this.app, this.plugin, this.containerEl);
  }
}

export class SettingsModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin) { super(app); }
  onOpen(): void {
    this.setTitle('GitHub 同步设置');
    renderSettings(this.app, this.plugin, this.contentEl);
  }
}

function renderSettings(app: App, plugin: GitHubBridgePlugin, el: HTMLElement): void {
  el.empty();
  const draft: BridgeSettings = { ...plugin.settings };
  el.createEl('h2', { text: 'Vault GitHub Bridge' });
  el.createEl('p', { text: '通过 GitHub 同步笔记。请在每台设备创建本地笔记库，并分别安装本插件；不要对同一笔记库同时开启其他同步服务。' });
  new Setting(el).setName('GitHub 用户或组织').addText(t => t.setPlaceholder('your-name').setValue(draft.owner).onChange(v => { draft.owner = v; }));
  new Setting(el).setName('仓库名称').setDesc('推荐使用专用私有仓库，先勾选添加 README；这里只填仓库名。')
    .addText(t => t.setPlaceholder('my-notes').setValue(draft.repo).onChange(v => { draft.repo = v; }));
  new Setting(el).setName('分支').addText(t => t.setValue(draft.branch).onChange(v => { draft.branch = v; }));
  new Setting(el).setName('GitHub 凭据').setDesc('创建 fine-grained token，仅授权此仓库，Contents：Read and write。只更新模式可用只读权限。凭据不会写入插件 data.json。')
    .addComponent(container => new SecretComponent(app, container).setValue(draft.secretName).onChange(v => { draft.secretName = v ?? ''; }));
  new Setting(el).setName('设备名称').setDesc('出现在 GitHub 提交记录中，便于识别修改来自哪台设备。')
    .addText(t => t.setValue(draft.device).onChange(v => { draft.device = v; }));
  new Setting(el).setName('打开 Obsidian 后同步').setDesc('默认开启。笔记库加载完成后同步一次，独立于下方的自动同步开关。离线或在后台时，联网并返回前台后执行；首次连接仍需预览确认。')
    .addToggle(t => t.setValue(draft.syncOnStartup).onChange(v => { draft.syncOnStartup = v; }));
  new Setting(el).setName('自动同步').setDesc('停止编辑后自动同步，Cmd+S / Ctrl+S 保存后立即同步。已在同步时会排队补传。移动端关闭应用后无法保证后台同步。')
    .addToggle(t => t.setValue(draft.autoSync).onChange(v => { draft.autoSync = v; }));
  new Setting(el).setName('停止编辑后同步（秒）').setDesc('默认 10 秒。继续输入会重新计时，Obsidian 的自动保存不会延长等待。范围 3～300 秒。')
    .addText(t => t.setValue(String(draft.idleSeconds)).onChange(v => { draft.idleSeconds = Number(v); }));
  new Setting(el).setName('只接收 GitHub 更新').setDesc('不上传本地修改；本地和远端都修改时仍保留冲突。')
    .addToggle(t => t.setValue(draft.readOnly).onChange(v => { draft.readOnly = v; }));
  new Setting(el).setName('远端更新检查间隔（秒）').setDesc('检查其他设备在 GitHub 上的新版本，范围 60～3600 秒。本地编辑按上方的等待时间触发同步。')
    .addText(t => t.setValue(String(draft.intervalSeconds)).onChange(v => { draft.intervalSeconds = Number(v); }));
  new Setting(el).setName('单文件上限（MB）').setDesc('1～20 MB，默认 10 MB。遇到超限文件会停止本轮同步，而非将其当成删除。')
    .addText(t => t.setValue(String(draft.maxFileMB)).onChange(v => { draft.maxFileMB = Number(v); }));
  new Setting(el).setName('排除文件夹').setDesc('相对于笔记库根目录，一行一条，不使用通配符。隐藏目录和 Obsidian 配置目录始终排除。改变范围后需要重新预览。')
    .addTextArea(t => t.setValue(draft.excludedFolders).setPlaceholder('私人资料\n大附件').onChange(v => { draft.excludedFolders = v; }));
  const error = el.createEl('p', { cls: 'github-bridge-error' });
  button(el, '保存配置', async () => {
    try { await plugin.configure(draft); error.setText('配置已保存。'); }
    catch (e) { error.setText(e instanceof Error ? e.message : '保存失败。'); }
  }, true);
  const actions = el.createDiv({ cls: 'github-bridge-actions' });
  button(actions, '预览同步计划', () => plugin.previewConnection());
  button(actions, '立即同步', () => plugin.sync(true));
  button(actions, '处理冲突', () => plugin.showConflicts());
  button(actions, '本机恢复版本', () => plugin.showHistory());
  el.createEl('p', { cls: 'setting-item-description', text: '保存后再预览。私有仓库不等于端到端加密；笔记以普通文件存储在 GitHub。当前版本不支持 Git LFS、子模块和插件配置同步。' });
  el.createEl('a', { text: '创建 GitHub fine-grained token', href: 'https://github.com/settings/personal-access-tokens/new', attr: { target: '_blank', rel: 'noopener noreferrer' } });
}

export class PreviewModal extends Modal {
  constructor(app: App, private plan: Plan, private confirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    const el = this.contentEl; el.empty();
    this.setTitle('预览 GitHub 同步');
    el.createEl('p', { text: '以下是当前快照的计划；执行前会再次检查最新内容。第一次连接不会根据本地缺失文件推断删除。' });
    for (const [kind, label] of [['push', '上传到 GitHub'], ['pull', '更新到本地'], ['adopt', '建立同步基线']] as const) {
      el.createEl('p', { text: `${label}：${this.plan.operations.filter(op => op.kind === kind).length} 个文件` });
    }
    el.createEl('p', { text: `保留双方内容的冲突：${this.plan.conflicts.length} 项` });
    if (this.plan.deletionReview) {
      el.createEl('p', { cls: 'github-bridge-error', text: `本轮将删除 ${this.plan.deletionReview.items.length} 个文件。请核对以下路径；暂时不可用的本地目录不应作为删除同步。` });
      const deletions = el.createDiv({ cls: 'github-bridge-preview' });
      for (const item of this.plan.deletionReview.items) deletions.createDiv({ text: `${item.kind === 'push' ? '从 GitHub 删除' : '从本机删除'}：${item.path}` });
    }
    const list = el.createDiv({ cls: 'github-bridge-preview' });
    for (const op of this.plan.operations.slice(0, 150)) list.createDiv({ text: `${op.kind === 'push' ? '↑' : op.kind === 'pull' ? '↓' : '='} ${op.path}${op.target === null ? '（删除）' : ''}` });
    for (const conflict of this.plan.conflicts.slice(0, 50)) list.createDiv({ text: `⚠ ${conflict.path}` });
    const actions = el.createDiv({ cls: 'github-bridge-actions' });
    button(actions, this.plan.deletionReview ? '确认以上删除并同步' : '确认计划并同步', async () => { this.close(); await this.confirm(); }, true);
    button(actions, '取消', () => this.close());
  }
}

export class StatusModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin) { super(app); }
  onOpen(): void {
    this.setTitle('GitHub 同步状态');
    this.contentEl.createEl('p', { text: this.plugin.statusText });
    this.contentEl.createEl('p', { text: `仓库：${this.plugin.settings.owner}/${this.plugin.settings.repo} · ${this.plugin.settings.branch}` });
    this.contentEl.createEl('p', { text: this.plugin.settings.autoSync ? `自动同步：开启，停止编辑 ${this.plugin.settings.idleSeconds} 秒后同步。` : '自动同步：已暂停，仍可手动同步。' });
    this.contentEl.createEl('p', { text: `打开 Obsidian 后同步：${this.plugin.settings.syncOnStartup ? '开启' : '关闭'}` });
    const actions = this.contentEl.createDiv({ cls: 'github-bridge-actions' });
    button(actions, '立即同步', async () => { this.close(); await this.plugin.sync(true); }, true);
    button(actions, '预览同步计划', async () => { this.close(); await this.plugin.previewConnection(); });
    button(actions, '处理冲突', async () => { this.close(); await this.plugin.showConflicts(); });
    button(actions, '本机恢复版本', async () => { this.close(); await this.plugin.showHistory(); });
  }
}

export class ConflictsModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private engine: SyncEngine, private conflicts: Conflict[]) { super(app); }
  onOpen(): void {
    this.setTitle(`同步冲突（${this.conflicts.length}）`);
    const el = this.contentEl; el.empty(); el.addClass('github-bridge-modal');
    if (!this.conflicts.length) el.createEl('p', { text: '没有待处理冲突。' });
    else el.createEl('p', { text: '不确定怎么选时，可以“保留两份”。插件会把本地版本另存到 GitHub 冲突副本文件夹，再采用 GitHub 版本，之后两份都能继续编辑。处理前会再次核对内容。' });
    if (this.conflicts.length > 1) button(el, '全部保留两份并继续同步', async () => { this.close(); await this.plugin.keepAllConflicts(this.conflicts); }, true);
    for (const conflict of this.conflicts) {
      const card = el.createDiv({ cls: 'github-bridge-conflict' });
      card.createEl('h3', { text: conflict.path });
      card.createEl('p', { text: conflict.local === null ? '本地已删除，GitHub 还有不同内容。' : conflict.remote === null ? 'GitHub 已删除，本地还有不同内容。' : conflict.base === undefined ? '首次连接发现同名文件内容不同。' : '本地和 GitHub 都修改了这个文件。' });
      const detail = card.createEl('details'); detail.createEl('summary', { text: '比较本地、GitHub 与上次同步版本' });
      let loaded = false;
      detail.addEventListener('toggle', () => {
        if (!detail.open || loaded) return;
        loaded = true;
        void this.renderVersions(detail, conflict).catch(e => detail.createEl('p', { text: e instanceof Error ? e.message : '读取失败' }));
      });
      const actions = card.createDiv({ cls: 'github-bridge-actions' });
      if (!this.plugin.settings.readOnly) button(actions, '保留本地', async () => { this.close(); await this.plugin.choose(conflict, 'local'); });
      button(actions, '保留 GitHub', async () => { this.close(); await this.plugin.choose(conflict, 'remote'); });
      if (conflict.local) button(actions, '保留两份，继续同步', async () => { this.close(); await this.plugin.choose(conflict, 'remote', true); }, true);
    }
  }
  private async renderVersions(el: HTMLElement, conflict: Conflict): Promise<void> {
    for (const [label, hash] of [['本地', conflict.local], ['GitHub', conflict.remote], ['上次同步', conflict.base]] as const) {
      el.createEl('h4', { text: label });
      if (!hash) { el.createEl('p', { text: hash === null ? '文件不存在 / 已删除' : '首次连接，没有共同基线' }); continue; }
      const bytes = await this.engine.cached(hash);
      if (!bytes) continue;
      if (!/\.(md|canvas|base|svg)$/i.test(conflict.path)) {
        el.createEl('p', { text: `附件 · ${bytes.length} 字节 · ${hash.slice(0, 12)}` }); continue;
      }
      let text: string;
      try { text = decode(bytes); } catch { text = '文件不是有效的 UTF-8 文本。'; }
      el.createEl('pre', { text: text.slice(0, 60_000) + (text.length > 60_000 ? '\n（预览已截断，完整副本仍保留）' : '') });
    }
  }
}

export class HistoryModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private entries: HistoryEntry[]) { super(app); }
  onOpen(): void {
    this.setTitle('本机恢复版本');
    this.contentEl.createEl('p', { text: '显示当前仓库连接最近 200 条本机版本记录。恢复会另存为新文件，不覆盖当前笔记；GitHub 完整提交历史可在仓库查看。' });
    if (!this.entries.length) this.contentEl.createEl('p', { text: '完成首次同步后会出现版本记录。' });
    for (const entry of [...this.entries].reverse()) {
      const row = this.contentEl.createDiv({ cls: 'github-bridge-history' });
      row.createEl('strong', { text: entry.path });
      row.createEl('small', { text: `${new Date(entry.at).toLocaleString()} · ${entry.reason}` });
      button(row, '另存恢复副本', () => this.plugin.restoreCopy(entry));
    }
  }
}
