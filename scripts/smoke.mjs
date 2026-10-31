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
const browserWindow = { setInterval: () => 1, setTimeout: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) };
runInNewContext(await readFile('dist/main.js', 'utf8'), {
  module, exports: module.exports,
  require: name => { assert.equal(name, 'obsidian'); return api; },
  TextEncoder, TextDecoder, structuredClone, Uint8Array, btoa, atob,
  document: { visibilityState: 'visible' },
  window: browserWindow
});
const instance = new module.exports.default();
await instance.onload();
assert.equal(commands.length, 7);
assert.equal(events.length, 4);
assert.equal(instance.settings.token, undefined);
assert.equal(instance.settings.autoSync, false);
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
console.log('Browser bundle smoke passed: 10s idle, Cmd+S save-before-sync, ribbon/status menus, busy actions, and persisted pause/resume.');
