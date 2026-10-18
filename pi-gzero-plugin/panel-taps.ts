// panel-taps.ts — open the gzero panel by tapping backtick.
//
// Backticks are precious (inline code, fences), so the tap counting is
// a hold-and-flush state machine: each tap is buffered for a short
// window; when the window expires, `trigger` or more taps open the
// panel and fewer are inserted as literal backticks. A non-backtick
// keystroke flushes immediately (held backticks forward first, order
// preserved). CX_PANEL_TAPS selects the trigger: 2 (default) = double
// or triple tap opens; 3 = double tap still types `` (empty code span)
// and only a genuine triple opens — triple is exactly the markdown
// fence, so switching to 3 trades fence-clash for inline-clash.
// CX_PANEL_TAPS=0 disables the editor interception entirely.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Tap window: taps closer than this count toward one sequence. */
export const TAP_WINDOW_MS = 300;

/** Trigger from the environment: CX_PANEL_TAPS=2|3, 0 disables, default 2. */
export function tapTrigger(env: NodeJS.ProcessEnv = process.env): 0 | 2 | 3 {
  const raw = env.CX_PANEL_TAPS;
  if (raw === "0") return 0;
  if (raw === "3") return 3;
  return 2;
}

/**
 * Pure tap-counting state machine. Actions are returned to the caller,
 * which owns insertion and panel opening — this class never touches the
 * editor, so node tests can drive it directly.
 */
export class TapCounter {
  private count = 0;
  private trigger: 2 | 3;

  constructor(trigger: 2 | 3 = tapTrigger() || 2) {
    this.trigger = trigger;
  }

  get pending(): number {
    return this.count;
  }

  /**
   * One backtick tap. Returns "open" as soon as the sequence can no
   * longer be part of a smaller valid sequence that would NOT open:
   * with trigger 2, two taps open immediately (a third can't change the
   * outcome); with trigger 3, three taps open and one or two keep
   * buffering until expiry.
   */
  tap(): "open" | null {
    this.count++;
    if (this.count >= 2 && this.trigger === 2) {
      const open = this.count >= 2;
      this.count = 0;
      return open ? "open" : null;
    }
    if (this.count >= 3) {
      this.count = 0;
      return "open";
    }
    return null;
  }

  /**
   * The sequence ended (window expiry or a different key). Returns the
   * action and the number of literal backticks to insert first
   * (`insert` is 0 when the panel opens).
   */
  flush(): { action: "open" | "insert"; insert: number } {
    const held = this.count;
    this.count = 0;
    if (held >= this.trigger) return { action: "open", insert: 0 };
    return { action: "insert", insert: held };
  }
}

/**
 * The editor component that intercepts backticks for tap counting and
 * forwards everything else untouched. Installed from session_start in
 * TUI mode; the `open` callback opens the gzero panel.
 */
export class TapEditor extends CustomEditor {
  private counter: TapCounter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openPanel: () => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    open: () => void,
    trigger: 2 | 3 = tapTrigger() || 2,
  ) {
    super(tui, theme, keybindings);
    this.counter = new TapCounter(trigger);
    this.openPanel = open;
  }

  /** Drop the pending timer (editor is being replaced/disposed). */
  disposeTaps(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  handleInput(data: string): void {
    if (data === "`") {
      this.handleTap();
      return;
    }
    // A different key ends any pending sequence: act on it, then let
    // the editor handle this key. A paste containing backticks goes
    // through untouched (exact-match only counts deliberate taps).
    this.flushPending();
    super.handleInput(data);
  }

  private handleTap(): void {
    const action = this.counter.tap();
    if (action === "open") {
      this.disposeTaps();
      this.openPanel();
      return;
    }
    // Sequence still live (trigger 3 with one or two taps): resolve it
    // when the window expires. A faster keystroke (tap or other key)
    // resolves it first, keeping order (held backticks forward before
    // the new key).
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, TAP_WINDOW_MS);
  }

  private flushPending(): void {
    if (this.counter.pending === 0) return;
    const { action, insert } = this.counter.flush();
    if (action === "open") {
      this.openPanel();
      return;
    }
    for (let i = 0; i < insert; i++) super.handleInput("`");
  }
}
