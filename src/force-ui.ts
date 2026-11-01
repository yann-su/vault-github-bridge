import { App, ButtonComponent, Modal, Notice } from 'obsidian';
import type GitHubBridgePlugin from './main';
import type { RemoteOverwritePlan } from './force-remote';

export class ForceRemoteModal extends Modal {
  private applying = false;
  private closed = false;
  constructor(app: App, private plugin: GitHubBridgePlugin, private plan: RemoteOverwritePlan) { super(app); }
  onOpen(): void {
    this.setTitle('强制采用远端内容');
    const el = this.contentEl, p = this.plan;
    el.createEl('p', { text: `来源：${p.source}` });
    el.createEl('p', { text: `远端版本：${p.remoteHead}` });
    el.createEl('p', { text: '将以远端笔记覆盖当前同步范围内的本地内容，本地独有笔记会移除。先保存完整备份，保留本机布局、插件配置、凭据和排除文件。此操作不上传或强推远端。执行期间请勿编辑笔记。' });
    if (p.mode === 'git') el.createEl('p', { text: `当前分支将对齐上游。本地独有提交 ${p.localCommits} 个，已暂存笔记 ${p.stagedPaths.length} 个；原提交保留在本机备份分支，未提交内容与暂存版本另行备份。` });
    const added = p.changes.filter(c => c.before === null).length, removed = p.changes.filter(c => c.target === null).length;
    el.createEl('p', { text: `新增 ${added} · 覆盖 ${p.changes.length - added - removed} · 删除 ${removed}` });
    el.createEl('pre', { cls: 'github-bridge-git-output', text: p.changes.map(c => `${c.target === null ? '删除' : c.before === null ? '新增' : '覆盖'}：${c.path}`).join('\n') || '笔记内容没有差异，仍会按远端版本重新对齐同步状态。' });
    const confirm = new ButtonComponent(el).setButtonText('备份并用远端覆盖本地').setCta();
    const cancel = new ButtonComponent(el).setButtonText('取消').onClick(() => this.close());
    confirm.onClick(async () => {
      this.applying = true;
      confirm.setDisabled(true).setButtonText('正在备份并采用远端…'); cancel.setDisabled(true);
      let done = false;
      try { done = await this.plugin.applyForceRemote(p); }
      finally {
        this.applying = false; cancel.setDisabled(false);
        if (this.closed) this.plugin.endForceRemoteReview();
      }
      if (done) this.close();
      else { confirm.setButtonText('请取消并重新预览'); }
    });
  }
  close(force = false): void {
    if (this.applying && !force) { new Notice('正在备份或覆盖，请等待完成。'); return; }
    super.close();
  }
  onClose(): void { this.closed = true; if (!this.applying) this.plugin.endForceRemoteReview(); }
}

export class ForceBackupModal extends Modal {
  constructor(app: App, private plugin: GitHubBridgePlugin, private files: Array<{ path: string; sha: string }>, private at: string) { super(app); }
  onOpen(): void {
    this.setTitle('强制覆盖前的完整备份');
    this.contentEl.createEl('p', { text: '选择文件可另存为恢复副本，原备份保留。恢复副本会参与后续笔记同步。' });
    for (const file of this.files) {
      const row = this.contentEl.createDiv(); row.createEl('p', { text: file.path });
      new ButtonComponent(row).setButtonText('另存为恢复副本').onClick(() => this.plugin.restoreCopy({ ...file, at: this.at, reason: '强制覆盖前' }));
    }
  }
}
