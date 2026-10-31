import { readFile, writeFile, mkdtemp, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

// Exercise the shipped CJS bundle with real Node/Git and an Obsidian API stand-in.
const exec = promisify(execFile), nodeRequire = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'vault-bridge-desktop-test-'));
const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
try {
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Desktop Test');
  await git('config', 'user.email', 'desktop@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'note.md'), 'fixture'); await git('add', 'note.md'); await git('commit', '-m', 'fixture');
  const head = await git('rev-parse', 'HEAD'), index = await readFile(join(root, '.git/index'));
  const modalTitles = [], commands = [], menus = [], settingNames = [];
  const element = () => ({ empty() {}, addClass() {}, addEventListener() {}, setText() {}, setAttribute() {}, createEl: () => element(), createDiv: () => element(), getBoundingClientRect: () => ({ right: 10, bottom: 20 }) });
  class Control {
    setValue() { return this; } setPlaceholder() { return this; } onChange() { return this; }
    setButtonText() { return this; } setDisabled() { return this; } onClick() { return this; }
    setCta() { return this; } addOption() { return this; }
  }
  class Setting {
    setName(name) { settingNames.push(name); return this; } setDesc() { return this; }
    addText(cb) { cb(new Control()); return this; } addTextArea(cb) { return this.addText(cb); }
    addToggle(cb) { return this.addText(cb); } addButton(cb) { return this.addText(cb); }
    addDropdown(cb) { return this.addText(cb); } addComponent(cb) { cb(element()); return this; }
  }
  class Modal {
    contentEl = element(); setTitle(title) { modalTitles.push(title); }
    constructor(app) { this.app = app; } open() { this.onOpen(); } close() {}
  }
  class FileSystemAdapter { getBasePath() { return root; } }
  class Plugin {
    manifest = { id: 'vault-github-bridge' };
    app = { vault: { configDir: '.obsidian', adapter: new FileSystemAdapter(), on() { return {}; } }, workspace: {
      on() { return {}; }, onLayoutReady(callback) { callback(); }, getActiveViewOfType() { return null; }
    } };
    async loadData() { return { autoSync: false, syncOnStartup: false }; } async saveData() {}
    addStatusBarItem() { return element(); } addRibbonIcon() { return element(); } addSettingTab() {}
    addCommand(command) { commands.push(command); } registerEvent() {} registerDomEvent() {} registerInterval() {}
  }
  class Menu {
    items = []; constructor() { menus.push(this); } setUseNativeMenu() { return this; } addSeparator() { return this; }
    addItem(callback) { const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, setDisabled() { return this; }, onClick() { return this; } }; callback(item); this.items.push(item); return this; }
    showAtMouseEvent() {} showAtPosition() {}
  }
  const api = { Plugin, FileSystemAdapter, Modal, Menu, Setting, ButtonComponent: Control, SecretComponent: Control,
    PluginSettingTab: class {}, MarkdownView: class {}, Platform: { isDesktopApp: true }, Notice: class {} };
  const module = { exports: {} };
  runInNewContext(await readFile('dist/main.js', 'utf8'), { module, exports: module.exports,
    require: name => name === 'obsidian' ? api : nodeRequire(name),
    TextEncoder, TextDecoder, structuredClone, Uint8Array, btoa, atob,
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1 },
    document: { visibilityState: 'visible' }, navigator: { onLine: true }
  });
  const plugin = new module.exports.default(); await plugin.onload();
  assert.equal(plugin.nativeGit.root, await realpath(root));
  assert.equal(plugin.nativeBranch, 'main');
  assert.equal(plugin.configured(), true, 'native Git does not need API repository settings');
  await plugin.showSyncMenu({});
  assert.ok(menus.at(-1).items.some(item => item.title === '分支管理'));
  assert.ok(commands.filter(command => command.checkCallback).every(command => command.checkCallback(true)));
  await plugin.showNativeRepository(); await plugin.showNativeCommit(); await plugin.showNativeBranches();
  await plugin.showNativeVersions(); await plugin.showNativeConflicts(); plugin.showNativeConsole(); plugin.showSettings();
  for (const title of ['本机 Git 仓库', '提交 Git 修改', 'Git 分支管理', 'Git 历史与版本选择', 'Git 冲突与进行中的操作', 'Git 命令行 / Shell', 'Git 同步设置']) assert.ok(modalTitles.includes(title), title);
  assert.ok(settingNames.includes('Git 可执行文件'));
  await rename(join(root, '.git'), join(root, '.git.saved'));
  await plugin.showSyncMenu({});
  assert.equal(plugin.nativeGit, null);
  assert.equal(menus.at(-1).items.some(item => item.title === '分支管理'), false);
  assert.equal(plugin.apiNeedsReview, true, 'removing Git requires review before a different API backend can write');
  const settingStart = settingNames.length; plugin.showSettings();
  assert.equal(settingNames.slice(settingStart).includes('Git 可执行文件'), false);
  await rename(join(root, '.git.saved'), join(root, '.git'));
  await plugin.showSyncMenu({});
  assert.ok(plugin.nativeGit); assert.equal(plugin.apiNeedsReview, false);
  assert.equal(await git('rev-parse', 'HEAD'), head); assert.deepEqual(await readFile(join(root, '.git/index')), index);
  plugin.onunload();
  console.log('Desktop bundle smoke passed: real Git detection through lazy Node loading, native menu and seven panels, no API settings required, HEAD/index preserved.');
} finally { await rm(root, { recursive: true, force: true }); }
