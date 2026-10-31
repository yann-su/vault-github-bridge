# Vault GitHub Bridge 0.1.2

用于测试的首个 GitHub 发布版。

- 本地优先的 GitHub 双向同步，不依赖本机 Git。
- 停止编辑 10 秒同步，Cmd+S / Ctrl+S 保存后立即排队同步。
- 三方冲突检测、保留两份、批量删除预览确认。
- 非强制提交、旧分支响应复核、中断恢复和本机版本恢复。
- 中文设置，使用 Obsidian SecretStorage 保存设备凭据。

## iPhone / iPad 安装

1. 在 Obsidian 社区插件中安装并启用 BRAT。
2. 在 BRAT 中添加本插件的 GitHub 仓库地址，选择 `0.1.2`。
3. 启用 Vault GitHub Bridge，连接你自己的笔记仓库并在本机配置 Token。
4. 首次同步先预览计划。移动端首次使用请在笔记库副本测试。

要求 Obsidian 1.11.5+。macOS 已做实机验证；iPhone / iPad / Android / Windows 尚需逐端验证。关闭 Obsidian 后不保证持续后台同步。

BRAT 安装使用下方独立的 `main.js`、`manifest.json`、`styles.css` 附件；手动安装可下载 ZIP。
