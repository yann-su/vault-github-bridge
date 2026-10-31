import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const events = [], workspaceEvents = [], commands = [], intervals = [], domEvents = [], timers = new Map();
let timerSequence = 0;
const element = () => ({ addClass() {}, addEventListener() {}, setText() {}, setAttribute() {} });
class Plugin {
  manifest = { id: 'vault-github-bridge' };
  app = { vault: { configDir: '.obsidian', on: (name, cb) => { events.push({ name, cb }); return {}; } }, workspace: { on: (name, cb) => { workspaceEvents.push({ name, cb }); return {}; }, onLayoutReady: cb => cb() } };
  async loadData() { return { owner: '', token: 'must-not-be-retained' }; }
  addStatusBarItem() { return element(); }
  addRibbonIcon() { return element(); }
  addSettingTab() {}
  addCommand(command) { commands.push(command); }
  registerEvent() {}
  registerDomEvent(target, name, callback) { domEvents.push({ target, name, callback }); }
  registerInterval(id) { intervals.push(id); }
}
const module = { exports: {} };
const api = { Plugin, MarkdownView: class {}, Modal: class {}, PluginSettingTab: class {}, Platform: { isIosApp: false, isAndroidApp: false } };
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
assert.equal(commands.length, 5);
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
instance.onunload();
console.log('Browser bundle smoke passed: 10s editor idle deadline, disk-save coalescing, and window-level Cmd+S save-before-sync.');
