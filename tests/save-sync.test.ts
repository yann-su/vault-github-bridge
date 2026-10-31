import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSaveShortcut, SaveSyncQueue } from '../src/save-sync';

function setup() {
  let now = 0, busy = false, enabled = true, retryAt = 0, counter = 0, calls = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const errors: unknown[] = [];
  let run: () => Promise<void> = async () => { calls++; };
  const queue = new SaveSyncQueue({
    now: () => now, busy: () => busy, enabled: () => enabled, retryAt: () => retryAt,
    setTimer: (callback, delay) => { const id = ++counter; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimer: id => { timers.delete(id); }, sync: () => run(), pending: () => {}, error: error => { errors.push(error); }
  });
  const tick = async (time = now) => {
    now = time;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    await Promise.resolve(); await Promise.resolve();
  };
  return { queue, errors, tick, calls: () => calls, busy: (v: boolean) => { busy = v; }, enabled: (v: boolean) => { enabled = v; }, retry: (v: number) => { retryAt = v; }, run: (fn: () => Promise<void>) => { run = fn; } };
}
test('recognizes Cmd+S and Ctrl+S, ignores typing, composition, repeat and save-as', () => {
  const key = { key: 's', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false };
  assert.equal(isSaveShortcut(key), true);
  assert.equal(isSaveShortcut({ ...key, metaKey: false, ctrlKey: true }), true);
  for (const override of [{ metaKey: false }, { key: 'a' }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) assert.equal(isSaveShortcut({ ...key, ...override }), false);
});
test('save is flushed to disk before immediate sync reads the note', async () => {
  const d = setup(); let disk = 'old'; let finish!: () => void;
  d.run(async () => { assert.equal(disk, 'new'); });
  const request = d.queue.request(async () => { await new Promise<void>(resolve => { finish = resolve; }); disk = 'new'; });
  await d.tick(); assert.equal(disk, 'old');
  finish(); await request; await d.tick(); assert.equal(disk, 'new');
});
test('repeated saves before the next turn become one sync', async () => {
  const d = setup(); await d.queue.request(async () => {}); await d.queue.request(async () => {}); await d.queue.request(async () => {});
  await d.tick(); assert.equal(d.calls(), 1);
});
test('save during an existing sync is retained until it finishes', async () => {
  const d = setup(); d.busy(true); await d.queue.request(async () => {}); await d.tick(); assert.equal(d.calls(), 0);
  d.busy(false); d.queue.wake(); await d.tick(); assert.equal(d.calls(), 1);
});
test('save during this queue running sync produces exactly one follow-up', async () => {
  const d = setup(); let calls = 0, finish!: () => void;
  d.run(async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { finish = resolve; }); });
  await d.queue.request(async () => {}); await d.tick(); assert.equal(calls, 1);
  await d.queue.request(async () => {}); await d.queue.request(async () => {}); await d.tick(); assert.equal(calls, 1);
  finish(); await Promise.resolve(); await Promise.resolve(); await d.tick(); assert.equal(calls, 2);
});
test('manual save respects rate-limit retry deadline', async () => {
  const d = setup(); d.retry(5000); await d.queue.request(async () => {}); await d.tick(4999); assert.equal(d.calls(), 0);
  await d.tick(5000); assert.equal(d.calls(), 1);
});
test('failed save never uploads an older disk snapshot', async () => {
  const d = setup(); await d.queue.request(async () => { throw new Error('disk full'); }); await d.tick();
  assert.equal(d.calls(), 0); assert.equal(d.errors.length, 1);
});
test('plugin unload while saving prevents a later network sync', async () => {
  const d = setup(); let finish!: () => void;
  const request = d.queue.request(() => new Promise<void>(resolve => { finish = resolve; }));
  d.queue.cancel(); finish(); await request; await d.tick(); assert.equal(d.calls(), 0);
});
test('turning auto-sync off cancels queued save sync', async () => {
  const d = setup(); await d.queue.request(async () => {}); d.enabled(false); d.queue.wake(); await d.tick(); assert.equal(d.calls(), 0);
});
