import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const events = [], workspaceEvents = [], commands = [], intervals = [], domEvents = [], timers = new Map(), menus = [], notices = [];
let timerSequence = 0;
let ribbonClick, statusClick, ribbonLabel, persisted;
const element = () => ({ addClass() {}, addEventListener(_name, callback) { statusClick = callback; }, setText() {}, setAttribute(_name, value) { ribbonLabel = value; }, getBoundingClientRect: () => ({ right: 42, bottom: 64 }) });
class Plugin {
  manifest = { id: 'vault-github-bridge' };
  app = { vault: { configDir: '.obsidian', on: (name, cb) => { events.push({ name, cb }); return {}; } }, workspace: { on: (name, cb) => { workspaceEvents.push({ name, cb }); return {}; }, onLayoutReady: cb => cb() } };
  async loadData() { return { owner: '', token: 'must-not-be-retained' }; }
  async saveData(data) { persisted = structuredClone(data); }
  addStatusBarItem() { return element(); }
  addRibbonIcon(_icon, _label, callback) { ribbonClick = callback; return element(); }
  addSettingTab() {}
  addCommand(command) { commands.push(command); }
  registerEvent() {}
  registerDomEvent(target, name, callback) { domEvents.push({ target, name, callback }); }
  registerInterval(id) { intervals.push(id); }
}
class Menu {
  items = [];
  constructor() { menus.push(this); }
  setUseNativeMenu(value) { this.native = value; return this; }
  addItem(callback) {
    const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, setDisabled(value) { this.disabled = value; return this; }, onClick(value) { this.click = value; return this; } };
    callback(item); this.items.push(item); return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent(event) { this.event = event; return this; }
  showAtPosition(position) { this.position = position; return this; }
}
const module = { exports: {} };
const api = { Plugin, Menu, Notice: class { constructor(text) { notices.push(text); } }, MarkdownView: class {}, Modal: class {}, PluginSettingTab: class {}, Platform: { isIosApp: false, isAndroidApp: false } };
const browserDocument = { visibilityState: 'visible' }, browserNavigator = { onLine: true };
const browserWindow = { setInterval: () => 1, setTimeout: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) };
runInNewContext(await readFile('dist/main.js', 'utf8'), {
  module, exports: module.exports,
  require: name => { assert.equal(name, 'obsidian'); return api; },
  TextEncoder, TextDecoder, structuredClone, Uint8Array, btoa, atob,
  document: browserDocument, navigator: browserNavigator,
  window: browserWindow
});
const instance = new module.exports.default();
await instance.onload();
assert.equal(commands.length, 12);
assert.equal(commands.filter(command => command.checkCallback).every(command => command.checkCallback(true) === false), true, 'Git-only commands are hidden without a local repository');
assert.equal(events.length, 4);
assert.equal(instance.settings.token, undefined);
assert.equal(instance.settings.autoSync, false);
assert.equal(instance.settings.syncOnStartup, true);
assert.ok(!('process' in instance));
let disk = 'old', syncs = 0;
instance.settings.autoSync = true; instance.settings.owner = 'fixture'; instance.settings.repo = 'fixture';
instance.app.workspace.getActiveViewOfType = () => ({ file: { path: 'note.md' }, editor: { hasFocus: () => true }, save: async () => { disk = 'saved'; } });
instance.sync = async () => { assert.equal(disk, 'saved'); syncs++; };
assert.equal(instance.settings.idleSeconds, 10);
const editorChange = workspaceEvents.find(event => event.name === 'editor-change');
assert.ok(editorChange);
editorChange.cb({}, { file: { path: 'note.md' } });
const idleTimer = [...timers.entries()].find(([, timer]) => timer.delay === 10_000);
assert.ok(idleTimer);
events.find(event => event.name === 'modify').cb({ path: 'note.md' });
assert.equal(timers.get(idleTimer[0]), idleTimer[1], 'disk autosave must not postpone editor idle deadline');
// Obsidian handles save at window capture and stops propagation to document.
const keydown = domEvents.find(event => event.name === 'keydown' && event.target === browserWindow);
assert.ok(keydown);
keydown.callback({ key: 's', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, preventDefault: () => { throw new Error('Must not intercept native save'); } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(disk, 'saved');
for (const [id, timer] of [...timers]) if (timer.delay === 0) { timers.delete(id); timer.callback(); }
await new Promise(resolve => setImmediate(resolve));
assert.equal(syncs, 1);

// Both visible entry points open the same menu without syncing or fetching.
const event = { clientX: 12, clientY: 24 };
ribbonClick(event);
assert.equal(syncs, 1);
let menu = menus.at(-1);
assert.equal(menu.event, event);
assert.equal(menu.native, false);
assert.match(ribbonLabel, /点击打开同步菜单/);
assert.deepEqual(menu.items.slice(1).map(item => item.title), ['立即同步', '查看同步状态', '预览同步计划', '处理同步冲突', '查看本机恢复版本', '暂停自动同步', '同步设置']);
await menu.items.find(item => item.title === '立即同步').click();
assert.equal(syncs, 2);
let action;
for (const [title, method] of [['预览同步计划', 'previewConnection'], ['处理同步冲突', 'showConflicts'], ['查看本机恢复版本', 'showHistory'], ['同步设置', 'showSettings']]) {
  instance[method] = async () => { action = method; };
  await menu.items.find(item => item.title === title).click();
  assert.equal(action, method);
}
statusClick(event);
assert.equal(menus.at(-1).event, event);
instance.busy = true; ribbonClick(event);
menu = menus.at(-1);
for (const title of ['正在同步，请稍候…', '预览同步计划', '处理同步冲突', '查看本机恢复版本', '暂停自动同步']) assert.equal(menu.items.find(item => item.title === title).disabled, true);
instance.busy = false;
commands.find(command => command.id === 'show-menu').callback();
assert.deepEqual({ ...menus.at(-1).position }, { x: 42, y: 64 });

// Pause cancels idle and already queued saves while preserving engine/backoff.
instance.context = { engine: { cancel() {} } };
const context = instance.context;
instance.blockedUntil = 12345;
keydown.callback({ key: 's', metaKey: true });
await new Promise(resolve => setImmediate(resolve));
await menus.at(-1).items.find(item => item.title === '暂停自动同步').click();
assert.equal(instance.settings.autoSync, false);
assert.equal(persisted.autoSync, false);
assert.equal(persisted.token, undefined);
assert.equal(instance.context, context);
assert.equal(instance.blockedUntil, 12345);
assert.equal(timers.size, 0, 'pause clears idle and queued-save timers');
assert.match(ribbonLabel, /自动同步已暂停/);
ribbonClick(event);
await menus.at(-1).items.find(item => item.title === '恢复自动同步').click();
assert.equal(instance.settings.autoSync, true);
assert.equal(persisted.autoSync, true);
assert.ok([...timers.values()].some(timer => timer.delay === 1500));
assert.equal(notices.at(-1), '自动同步已恢复。');
instance.onunload();

// Exercise the real controller, queue and lifecycle with a local engine stand-in.
async function startupFixture(saved = {}, approved = true) {
  assert.equal(timers.size, 0);
  browserDocument.visibilityState = 'visible'; browserNavigator.onLine = true;
  const plugin = new module.exports.default(), eventStart = domEvents.length;
  let ready, runs = 0, saves = 0;
  plugin.loadData = async () => ({ owner: 'fixture', repo: 'fixture', autoSync: false, ...saved });
  plugin.app.workspace.onLayoutReady = callback => { ready = callback; };
  plugin.app.workspace.getActiveViewOfType = () => ({ file: { path: 'note.md' }, save: async () => { saves++; } });
  plugin.getContext = () => ({ engine: {
    inspect: async () => ({ approved, conflicts: [] }),
    run: async () => { assert.ok(saves > 0, 'startup flushes the editor before reading files'); runs++; return { uploaded: 0, downloaded: 0, conflicts: 0, deferred: 0 }; }
  } });
  await plugin.onload();
  assert.equal(timers.size, 0, 'wait for vault layout before scheduling startup');
  return { plugin, ready: () => ready(), get runs() { return runs; },
    emit(name) { const event = domEvents.slice(eventStart).find(event => event.name === name); assert.ok(event); event.callback(); }
  };
}
async function fireTimer(delay) {
  const timer = [...timers].find(([, entry]) => entry.delay === delay);
  assert.ok(timer, `expected a ${delay}ms timer`);
  timers.delete(timer[0]); timer[1].callback();
  await new Promise(resolve => setImmediate(resolve));
}
let startup = await startupFixture();
startup.ready(); startup.ready();
assert.equal(timers.size, 1, 'duplicate layout-ready callbacks coalesce');
await fireTimer(1500); await fireTimer(0);
assert.equal(startup.runs, 1, 'legacy settings launch once even when edit auto-sync is paused');
startup.emit('focus'); startup.emit('online');
assert.equal(timers.size, 0, 'one launch does not become recurring auto-sync');
startup.plugin.onunload();

startup = await startupFixture({ syncOnStartup: false });
startup.ready(); startup.emit('focus');
assert.equal(timers.size, 0, 'disabled startup stays disabled');
startup.plugin.onunload();

startup = await startupFixture({ autoSync: true });
startup.ready();
const launchTimer = [...timers.keys()][0];
workspaceEvents.at(-1).cb({}, { file: { path: 'note.md' } });
startup.emit('focus'); startup.emit('online');
assert.ok(timers.has(launchTimer), 'typing and foreground events do not postpone or duplicate startup');
assert.equal(timers.size, 1);
await fireTimer(1500); await fireTimer(0);
assert.equal(startup.runs, 1);
startup.plugin.onunload();

startup = await startupFixture();
browserDocument.visibilityState = 'hidden'; browserNavigator.onLine = false;
startup.ready(); await fireTimer(1500);
assert.equal(startup.runs, 0);
browserNavigator.onLine = true; startup.emit('online'); await fireTimer(1000);
assert.equal(startup.runs, 0, 'online alone does not sync a hidden vault');
browserDocument.visibilityState = 'visible'; startup.emit('visibilitychange');
await fireTimer(1000); await fireTimer(0);
assert.equal(startup.runs, 1, 'deferred launch runs on return to an online foreground');
startup.plugin.onunload();

startup = await startupFixture();
startup.ready();
let finishSettingsSave;
startup.plugin.saveData = () => new Promise(resolve => { finishSettingsSave = resolve; });
const settingsSave = startup.plugin.toggleAutoSync();
assert.equal(startup.plugin.busy, true);
await fireTimer(1500);
assert.equal(startup.runs, 0);
finishSettingsSave(); await settingsSave;
await fireTimer(0);
assert.equal(startup.runs, 1, 'launch stays queued until a busy task completes');
assert.equal(timers.size, 0);
startup.plugin.onunload();

startup = await startupFixture({}, false);
startup.ready(); await fireTimer(1500); await fireTimer(0);
assert.equal(startup.runs, 0, 'first connection approval is never bypassed');
assert.equal(startup.plugin.statusText, '请先预览并建立连接');
startup.plugin.onunload();

startup = await startupFixture();
startup.ready(); startup.plugin.onunload();
assert.equal(timers.size, 0, 'unload cancels launch');
startup.ready();
assert.equal(timers.size, 0, 'late layout-ready cannot restart an unloaded plugin');

// Native menus only exist in repository mode; sync dispatch cannot reach the API.
const nativeMode = new module.exports.default();
await nativeMode.onload();
nativeMode.app.workspace.getActiveViewOfType = () => null;
let nativeSyncs = 0;
nativeMode.nativeGit = { root: '/fixture', cancel() {}, snapshot: async () => ({ branch: 'main' }),
  sync: async () => { nativeSyncs++; return { committed: 1, pushed: 1, pulled: 0, merged: false, conflicts: 0 }; } };
nativeMode.nativeBranch = 'main';
nativeMode.getContext = () => { throw new Error('Native mode must never invoke the GitHub API engine'); };
await nativeMode.showSyncMenu(event);
menu = menus.at(-1);
for (const title of ['Git 仓库管理', '分支管理', '提交笔记修改', '历史与版本恢复', 'Git 命令行 / Shell']) assert.ok(menu.items.some(item => item.title === title));
assert.equal(menu.items.some(item => item.title === '预览同步计划'), false);
assert.ok(commands.slice(-12).filter(command => command.checkCallback).every(command => command.checkCallback(true)));
await nativeMode.sync(true);
assert.equal(nativeSyncs, 1);
assert.match(nativeMode.statusText, /commit 1 ↑1/);
nativeMode.nativeGit.sync = async () => ({ committed: 1, pushed: 2, pulled: 1, merged: true, conflicts: 0 });
await nativeMode.sync(true);
assert.match(nativeMode.statusText, /已合并上游并同步/);
nativeMode.nativeGit.snapshot = async () => ({ branch: 'main', head: 'fixture', operation: 'merge', changes: [{ path: 'note.md', conflict: true }] });
nativeMode.nativeGit.sync = async () => ({ committed: 0, pushed: 0, pulled: 0, merged: false, conflicts: 1 });
const beforeConflictNotice = notices.length;
await nativeMode.sync(false);
assert.match(nativeMode.statusText, /1 项 Git 合并冲突.*处理同步冲突/);
assert.equal(notices.length, beforeConflictNotice + 1, 'automatic merge conflicts notify the user');
await nativeMode.sync(false);
assert.equal(notices.length, beforeConflictNotice + 1, 'unchanged conflicts do not repeatedly notify');
nativeMode.nativeGit.sync = async () => ({ committed: 0, pushed: 0, pulled: 0, merged: false, conflicts: 0, divergent: true });
await nativeMode.sync(true);
assert.match(nativeMode.statusText, /只接收更新.*关闭只接收更新/);
nativeMode.nativeGit = null;
await nativeMode.showSyncMenu(event);
assert.equal(menus.at(-1).items.some(item => item.title === '分支管理'), false);
nativeMode.onunload();
console.log('Browser bundle smoke passed: mobile-safe load, conditional Git menus/commands, native sync/merge/conflict routing, deduplicated notices, startup queue, 10s idle, Cmd+S, and menu actions.');
