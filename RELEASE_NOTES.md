# Vault GitHub Bridge 0.1.4

新增 **打开 Obsidian 后同步**，默认开启。

- 笔记库加载完成后自动同步一次，不依赖“自动同步”开关。
- 离线或在后台时，联网并返回前台后执行；操作忙碌时排队。
- 已有配置升级后默认开启，可在“同步菜单 → 同步设置”中关闭。
- 首次连接仍需预览确认，原来的停止编辑 10 秒同步和 Cmd+S / Ctrl+S 保存后同步继续适用。

## 更新与安装

已通过 BRAT 安装的设备可检查更新到 `0.1.4`。新设备在 BRAT 中添加 `yann-su/vault-github-bridge`，选择最新版本；凭据需要在每台设备分别配置。

要求 Obsidian 1.11.5+。macOS 已做实机验证；iPhone / iPad / Android / Windows 尚需逐端验证。关闭 Obsidian 后不保证持续后台同步。

BRAT 安装使用下方独立的 `main.js`、`manifest.json`、`styles.css` 附件；手动安装可下载 ZIP。
