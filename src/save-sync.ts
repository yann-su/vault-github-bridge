/** Detect the ordinary save shortcut without intercepting the editor's command. */
export function isSaveShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>): boolean {
  return event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey) &&
    !event.altKey && !event.shiftKey && !event.repeat && !event.isComposing;
}

interface SaveSyncHooks {
  enabled(): boolean;
  busy(): boolean;
  retryAt(manual: boolean): number;
  now(): number;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(timer: number): void;
  sync(manual: boolean): Promise<void>;
  pending(): void;
  error(error: unknown): void;
}

/** Keep explicit saves pending across a running sync; coalesce repeated requests. */
export class SaveSyncQueue {
  private pending = false;
  private manual = false;
  private running = false;
  private closed = false;
  private timer: number | undefined;
  constructor(private hooks: SaveSyncHooks) {}
  async request(save: () => Promise<void>, manual = false): Promise<void> {
    if (this.closed || !this.hooks.enabled()) return;
    try {
      await save();
      if (this.closed || !this.hooks.enabled()) return;
      this.pending = true;
      this.manual ||= manual;
      this.hooks.pending();
      this.wake();
    } catch (error) { this.hooks.error(error); }
  }
  wake(): void {
    if (this.timer !== undefined) { this.hooks.clearTimer(this.timer); this.timer = undefined; }
    if (this.closed || !this.hooks.enabled()) { this.pending = false; this.manual = false; return; }
    if (!this.pending || this.running || this.hooks.busy()) return;
    this.timer = this.hooks.setTimer(() => {
      this.timer = undefined;
      void this.drain();
    }, Math.max(0, this.hooks.retryAt(this.manual) - this.hooks.now()));
  }
  private async drain(): Promise<void> {
    if (this.closed || !this.hooks.enabled()) { this.pending = false; this.manual = false; return; }
    if (this.hooks.busy()) return;
    if (this.hooks.now() < this.hooks.retryAt(this.manual)) { this.wake(); return; }
    const manual = this.manual;
    this.pending = false;
    this.manual = false;
    this.running = true;
    try { await this.hooks.sync(manual); }
    catch (error) { this.hooks.error(error); }
    finally { this.running = false; this.wake(); }
  }
  clearPending(): void {
    this.pending = false; this.manual = false;
    if (this.timer !== undefined) this.hooks.clearTimer(this.timer);
    this.timer = undefined;
  }
  cancel(): void {
    this.closed = true; this.clearPending();
  }
}
