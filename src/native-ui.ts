import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type GitHubBridgePlugin from './main';
import type { GitBranch, GitConflict, GitSnapshot, GitVersion } from './native-git';

function action(el: HTMLElement, title: string, run: () => Promise<unknown> | void, primary = false): ButtonComponent {
  const button = new ButtonComponent(el).setButtonText(title);
  if (primary) button.setCta();
  return button.onClick(async () => { button.setDisabled(true); try { await run(); } finally { button.setDisabled(false); } });
}
export class GitConfirmModal extends Modal {
  constructor(app: App, private titleText: string, private detail: string, private label: string, private confirm: () => Promise<unknown>) { super(app); }
  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.createEl('pre', { cls: 'github-bridge-git-output', text: this.detail });
    action(this.contentEl, this.label, async () => { this.close(); await this.confirm(); }, true);
  }
}
export class NativeRepositoryModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private state: GitSnapshot) { super(app); }
  onOpen(): void {
    this.setTitle('本机 Git 仓库');
    const el = this.contentEl, s = this.state, git = this.plugin.nativeGit!;
    el.createEl('p', { text: this.plugin.statusText });
    el.createEl('p', { text: git.root });
    el.createEl('p', { text: `分支：${s.branch || '分离 HEAD'} · ${s.head.slice(0, 12) || '尚无提交'}` });
    el.createEl('p', { text: `上游：${s.upstream || '未设置'} · 本地领先 ${s.ahead} / 落后 ${s.behind} 个提交` });
    el.createEl('p', { text: `远端：${s.remoteUrl || '未设置远端'}（本机 Git 凭据）` });
    el.createEl('p', { text: `笔记修改 ${s.changes.filter(c => c.managed).length} 项；范围外修改 ${s.changes.filter(c => !c.managed).length} 项；未解决冲突 ${s.changes.filter(c => c.conflict).length} 项。` });
    if (s.operation) el.createEl('p', { cls: 'github-bridge-error', text: `正在进行：${s.operation}，完成前暂停自动同步。` });
    const actions = el.createDiv({ cls: 'github-bridge-actions' });
    action(actions, '立即同步', async () => { this.close(); await this.plugin.sync(true); }, true);
    action(actions, '强制采用远端内容…', async () => { this.close(); await this.plugin.previewForceRemote(); });
    action(actions, '提交笔记修改', async () => { this.close(); await this.plugin.showNativeCommit(); });
    action(actions, '分支管理', async () => { this.close(); await this.plugin.showNativeBranches(); });
    action(actions, '历史与版本恢复', async () => { this.close(); await this.plugin.showNativeVersions(); });
    action(actions, '处理 Git 冲突', async () => { this.close(); await this.plugin.showNativeConflicts(); });
    if (s.ahead && s.behind) {
      el.createEl('p', { text: this.plugin.settings.readOnly ? '当前只接收更新。关闭此选项后，同步会自动尝试合并上游。' : '同步会自动合并双方修改；遇到内容冲突时保留双方版本，并暂停等待处理。' });
      action(actions, '合并并同步上游', async () => { this.close(); await this.plugin.sync(true); }).setDisabled(this.plugin.settings.readOnly);
    }
    action(actions, '修复布局文件并同步', () => {
      const dir = this.app.vault.configDir;
      new GitConfirmModal(this.app, '将工作区布局保留在本机',
        `布局文件：${dir}/workspace.json、${dir}/workspace-mobile.json\n\n先备份现有布局，再停止 Git 跟踪并写入 .gitignore。本机文件保留，GitHub 中不再同步这些布局。会创建提交，并继续合并和同步笔记；原有历史保留。\n\n暂存区和 .gitignore 如有未提交修改，会先停止以便核对。`,
        '备份布局并修复同步', async () => {
          const backup = await this.plugin.nativeAction(g => g.keepWorkspaceLocal(), true);
          if (backup) { this.close(); new Notice('已保留本机布局并备份：' + backup, 8000); await this.plugin.sync(true); }
        }).open();
    }).setDisabled(this.plugin.settings.readOnly || Boolean(s.operation) || s.changes.some(c => c.conflict));
    action(actions, 'Git 命令行 / Shell', async () => { this.close(); this.plugin.showNativeConsole(); });
    el.createEl('pre', { cls: 'github-bridge-git-output', text: s.changes.slice(0, 400).map(c => `${c.index}${c.worktree} ${c.path}${c.oldPath ? ` ← ${c.oldPath}` : ''}`).join('\n') || '工作区干净。' });
  }
}
export class NativeCommitModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private state: GitSnapshot) { super(app); }
  onOpen(): void {
    this.setTitle('提交 Git 修改');
    const el = this.contentEl, selected = new Set<string>();
    let message = `Obsidian: ${this.plugin.settings.device}`;
    new Setting(el).setName('Commit 说明').addText(t => t.setValue(message).onChange(value => { message = value; }));
    el.createEl('p', { text: '下方只默认选择当前同步范围内的笔记。仓库中其他已暂存文件会保留，不混入这次笔记提交。' });
    const list = el.createDiv({ cls: 'github-bridge-preview' });
    for (const c of this.state.changes.filter(c => c.managed)) {
      const paths = c.oldPath ? [c.path, c.oldPath] : [c.path]; paths.forEach(p => selected.add(p));
      new Setting(list).setName(`${c.index}${c.worktree} ${c.path}`).setDesc(c.oldPath ? `原路径：${c.oldPath}` : '')
        .addToggle(t => t.setValue(true).onChange(value => { paths.forEach(p => value ? selected.add(p) : selected.delete(p)); }));
    }
    action(el, '提交所选笔记', async () => {
      const result = await this.plugin.nativeAction(g => g.commit(message, [...selected]), true);
      if (result !== undefined) { this.close(); new Notice(`已提交 ${result} 个笔记文件。`); }
    }, true).setDisabled(this.plugin.settings.readOnly);
    action(el, '查看并提交现有暂存区', async () => {
      const review = await this.plugin.nativeAction(g => g.stagedReview());
      if (!review?.summary) { new Notice('暂存区没有修改。'); return; }
      new GitConfirmModal(this.app, '确认提交整个暂存区', `${message}\n\n${review.summary}\n\n此操作提交上方列出的所有已暂存文件，包括同步范围外文件。`, '提交以上暂存文件', async () => {
        await this.plugin.nativeAction(g => g.commitStaged(message, review), true); this.close();
      }).open();
    }).setDisabled(this.plugin.settings.readOnly);
  }
}
export class NativeBranchesModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private branches: GitBranch[], private state: GitSnapshot, private version = 'HEAD') { super(app); }
  onOpen(): void {
    this.setTitle('Git 分支管理');
    const el = this.contentEl;
    el.createEl('p', { text: `当前：${this.state.branch || '分离 HEAD'}。切换前请先提交或 stash 笔记修改。其他文件遇到覆盖风险时，Git 会拒绝切换。` });
    let name = '';
    new Setting(el).setName(`从 ${this.version.slice(0, 12)} 新建分支`).addText(t => t.setPlaceholder('notes/my-branch').onChange(v => { name = v; }))
      .addButton(b => b.setButtonText('创建并切换').setDisabled(this.plugin.settings.readOnly).onClick(async () => {
        const result = await this.plugin.nativeAction(async g => { await g.createBranch(name, this.version); return true; }, true);
        if (result) { this.close(); await this.plugin.showNativeBranches(); }
      }));
    const list = el.createDiv({ cls: 'github-bridge-preview' });
    for (const branch of this.branches) {
      const row = new Setting(list).setName(`${branch.current ? '● ' : ''}${branch.name}`).setDesc(branch.remote ? '远端分支' : branch.upstream || '本地分支，未设置上游');
      if (!branch.current) row.addButton(b => b.setButtonText(branch.remote ? '跟踪并切换' : '切换').setDisabled(this.plugin.settings.readOnly).onClick(async () => {
        const result = await this.plugin.nativeAction(async g => { await g.switchBranch(branch.name, branch.remote); return true; }, true);
        if (result) { this.close(); await this.plugin.showNativeBranches(); }
      }));
      if (!branch.remote && !branch.current) row.addButton(b => b.setButtonText('删除已合并分支').setDisabled(this.plugin.settings.readOnly).onClick(() => {
        new GitConfirmModal(this.app, '删除本地分支', branch.name + '\n仅使用 git branch -d；未合并的分支会拒绝删除。', '删除此分支', async () => {
          await this.plugin.nativeAction(g => g.deleteBranch(branch.name), true); this.close(); await this.plugin.showNativeBranches();
        }).open();
      }));
    }
    if (!this.state.upstream) action(el, '发布当前分支到 origin', () => {
      new GitConfirmModal(this.app, '发布分支', `将当前分支 ${this.state.branch} 推送到 origin，并设置上游。\n${this.state.remoteUrl}`, '发布当前分支', async () => {
        await this.plugin.nativeAction(g => g.publishBranch(), true); this.close();
      }).open();
    }).setDisabled(this.plugin.settings.readOnly);
  }
}
export class NativeVersionsModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private versions: GitVersion[], private head: string) { super(app); }
  onOpen(): void {
    this.setTitle('Git 历史与版本选择');
    const el = this.contentEl;
    if (!this.versions.length) { el.createEl('p', { text: '仓库尚无提交。' }); return; }
    let version = this.versions.some(v => v.sha === this.head) ? this.head : this.versions[0]!.sha;
    new Setting(el).setName('选择提交').addDropdown(d => {
      for (const v of this.versions) d.addOption(v.sha, `${v.sha.slice(0, 8)} ${v.date.slice(0, 10)} ${v.subject.slice(0, 70)}${v.refs ? ` · ${v.refs}` : ''}`);
      d.setValue(version).onChange(v => { version = v; });
    });
    new Setting(el).setName('或输入 tag / SHA / 分支').addText(t => t.setPlaceholder('v1.0.0 / HEAD~1').onChange(v => { version = v.trim() || this.head; }));
    const detail = el.createEl('pre', { cls: 'github-bridge-git-output', text: '选择版本后可查看提交说明和文件清单。' });
    action(el, '查看版本详情', async () => { const text = await this.plugin.nativeAction(g => g.versionDetail(version)); if (text !== undefined) detail.setText(text); });
    action(el, '预览恢复到此版本', async () => {
      const plan = await this.plugin.nativeAction(g => g.restorePlan(version));
      if (!plan) return;
      if (!plan.paths.length) { new Notice('当前笔记已经与该版本一致。'); return; }
      const deleted = new Set(plan.deletions);
      new GitConfirmModal(this.app, '恢复笔记版本', `目标：${plan.sha}\n\n将恢复同步范围内的 ${plan.paths.length} 个文件，并生成一条新提交。历史提交和其他文件保留。\n\n${plan.paths.map(p => `${deleted.has(p) ? '删除' : '恢复'}：${p}`).join('\n')}`, '恢复以上笔记并创建提交', async () => {
        await this.plugin.nativeAction(g => g.restoreVersion(plan), true); this.close();
      }).open();
    }).setDisabled(this.plugin.settings.readOnly);
    action(el, '从此版本新建分支', async () => { this.close(); await this.plugin.showNativeBranches(version); }).setDisabled(this.plugin.settings.readOnly);
  }
}
export class NativeConflictsModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private state: GitSnapshot) { super(app); }
  onOpen(): void {
    this.setTitle('Git 冲突与进行中的操作');
    const el = this.contentEl, conflicts = this.state.changes.filter(c => c.conflict);
    el.createEl('p', { text: conflicts.length ? `有 ${conflicts.length} 个未解决冲突，自动同步已暂停。` : '没有未解决的文件冲突。' });
    for (const c of conflicts) new Setting(el).setName(c.path).addButton(b => b.setButtonText('比较与处理').onClick(async () => {
      const conflict = await this.plugin.nativeAction(g => g.conflict(c.path));
      if (conflict) { this.close(); new NativeConflictDetailModal(this.app, this.plugin, conflict).open(); }
    }));
    if (this.state.operation) el.createEl('p', { text: `进行中的操作：${this.state.operation}` });
    if (this.state.operation === 'merge' && !conflicts.length) action(el, '查看并完成合并', async () => {
      const review = await this.plugin.nativeAction(g => g.stagedReview());
      if (review) new GitConfirmModal(this.app, '完成 Git 合并', (review.summary || '将创建合并提交。') + '\n\n完成后继续同步到上游。', '完成合并并同步', async () => {
        const completed = await this.plugin.nativeAction(async g => { await g.finishMerge(review); return true; }, true);
        if (completed) { this.close(); await this.plugin.sync(true); }
      }).open();
    }).setDisabled(this.plugin.settings.readOnly);
    action(el, 'Git 命令行 / 系统终端', () => { this.close(); this.plugin.showNativeConsole(); });
  }
}
class NativeConflictDetailModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private conflict: GitConflict) { super(app); }
  onOpen(): void {
    this.setTitle(this.conflict.path);
    const el = this.contentEl;
    el.createEl('p', { text: '采用某一方前，工作区内容和双方版本会备份到 Git 元数据目录的 vault-bridge-backups 中。也可先手动编辑并保存，再标记解决。' });
    if (this.conflict.operation === 'rebase') el.createEl('p', { text: '当前处于 rebase：ours 是目标基线，theirs 是正在重放的提交，请先比较内容再选择。' });
    for (const [key, label] of [['ours', 'Git ours（当前侧）'], ['theirs', 'Git theirs（传入侧）'], ['worktree', '工作区内容']] as const) {
      const details = el.createEl('details'); details.createEl('summary', { text: label });
      details.createEl('pre', { cls: 'github-bridge-git-output', text: this.conflict[key] ?? '（此侧文件不存在 / 删除）' });
    }
    for (const [choice, label] of [['ours', '保留 ours 当前侧'], ['theirs', '保留 theirs 传入侧'], ['manual', '已手动解决，暂存此文件']] as const) {
      action(el, label, async () => {
        const result = await this.plugin.nativeAction(g => g.resolveConflict(this.conflict, choice), true);
        if (result) { new Notice('已暂存解决结果，双方版本已备份。'); this.close(); await this.plugin.showNativeConflicts(); }
      }).setDisabled(this.plugin.settings.readOnly);
    }
  }
}
export class NativeConsoleModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Git 命令行 / Shell');
    const el = this.contentEl; let command = 'git status --short --branch';
    el.createEl('p', { text: '在当前笔记库执行 Git 命令，支持引号参数。管道、重定向和完整 Shell 脚本请在系统终端运行。命令可能修改仓库，执行前请核对。' });
    new Setting(el).setName('命令').addTextArea(t => t.setValue(command).onChange(v => { command = v; }));
    const output = el.createEl('pre', { cls: 'github-bridge-git-output' });
    action(el, '执行 Git 命令', async () => { const text = await this.plugin.nativeAction(g => g.console(command), true); if (text !== undefined) output.setText(text || '命令已完成。'); }).setDisabled(this.plugin.settings.readOnly);
    action(el, '在此仓库打开系统终端', () => this.plugin.nativeAction(g => g.openTerminal()));
  }
}
