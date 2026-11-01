import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, rename } from 'node:fs/promises';
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
  await writeFile(join(root, 'note.md'), 'fixture');
  await mkdir(join(root, '.obsidian')); await writeFile(join(root, '.obsidian/workspace.json'), '{"layout":"base"}');
  await git('add', 'note.md', '.obsidian/workspace.json'); await git('commit', '-m', 'fixture');
  const head = await git('rev-parse', 'HEAD'), index = await readFile(join(root, '.git/index'));
  const modalTitles = [], commands = [], menus = [], settingNames = [], buttons = [];
  const element = () => ({ empty() {}, addClass() {}, addEventListener() {}, setText() {}, setAttribute() {}, createEl: () => element(), createDiv: () => element(), getBoundingClientRect: () => ({ right: 10, bottom: 20 }) });
  class Control {
    setValue() { return this; } setPlaceholder() { return this; } onChange() { return this; }
    setButtonText(label) { this.label = label; return this; } setDisabled() { return this; } onClick(callback) { this.click = callback; buttons.push(this); return this; }
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
  const network = await mkdtemp(join(tmpdir(), 'vault-bridge-desktop-network-'));
  try {
    const remote = join(network, 'origin.git'), peer = join(network, 'peer');
    const peerGit = async (...args) => (await exec('git', ['-C', peer, ...args])).stdout.trim();
    await git('init', '--bare', remote); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
    await git('clone', '-b', 'main', remote, peer);
    await peerGit('config', 'user.name', 'Desktop Peer'); await peerGit('config', 'user.email', 'peer@example.invalid');
    await peerGit('config', 'commit.gpgsign', 'false');
    await writeFile(join(peer, 'peer.md'), 'remote addition');
    await writeFile(join(peer, '.obsidian/workspace.json'), '{"layout":"remote"}');
    await peerGit('add', 'peer.md', '.obsidian/workspace.json');
    await peerGit('commit', '-m', 'remote addition'); await peerGit('push');
    await writeFile(join(root, 'note.md'), 'local edit');
    await writeFile(join(root, '.obsidian/workspace.json'), '{"layout":"running app"}');
    await plugin.sync(true);
    assert.match(plugin.statusText, /修复布局文件并同步/);
    await plugin.showNativeRepository();
    await buttons.findLast(b => b.label === '修复布局文件并同步').click();
    assert.equal(modalTitles.at(-1), '将工作区布局保留在本机');
    await buttons.findLast(b => b.label === '备份布局并修复同步').click();
    assert.match(plugin.statusText, /已合并上游并同步/);
    assert.equal(await readFile(join(root, '.obsidian/workspace.json'), 'utf8'), '{"layout":"running app"}');
    assert.equal(await git('ls-files', '--', '.obsidian/workspace.json'), '');
    assert.equal(await readFile(join(root, 'peer.md'), 'utf8'), 'remote addition');
    assert.equal((await git('rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3);
    assert.equal(await git('rev-parse', 'HEAD'), await git('rev-parse', 'origin/main'));
    await peerGit('pull', '--ff-only');
    await writeFile(join(peer, 'note.md'), 'remote conflict'); await peerGit('commit', '-am', 'remote conflict'); await peerGit('push');
    const remoteHead = await peerGit('rev-parse', 'HEAD');
    await writeFile(join(root, 'note.md'), 'local conflict');
    await plugin.sync(false);
    assert.match(plugin.statusText, /1 项 Git 合并冲突.*处理同步冲突/);
    assert.equal((await plugin.nativeGit.snapshot()).operation, 'merge');
    assert.equal((await exec('git', ['-C', remote, 'rev-parse', 'refs/heads/main'])).stdout.trim(), remoteHead);
    await plugin.showNativeConflicts();
    const conflict = await plugin.nativeGit.conflict('note.md');
    assert.equal(conflict.ours, 'local conflict'); assert.equal(conflict.theirs, 'remote conflict');
  } finally { await rm(network, { recursive: true, force: true }); }
  plugin.onunload();
  console.log('Desktop bundle smoke passed: lazy Node/Git detection, seven panels, metadata reads preserve HEAD/index; workspace repair buttons preserve running app JSON, merge notes and push through a real bare remote; genuine note conflicts retain both sides.');
} finally { await rm(root, { recursive: true, force: true }); }
