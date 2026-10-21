// panel.ts — the prompt-history overlay: a scrollable list of the
// project's user prompts (filler already removed).
//
// Styled like the chat: entries are blue blocks (userMessageBg, same token
// the chat uses for user messages), anchored at the top of the screen, and
// chronological — oldest at top, newest at bottom by the editor, so time
// "fades upwards" and ↑ walks to older prompts exactly like ctrl+up walks
// up through the chat history.
//
// Standalone copy of the shared keymap pattern (gzero-plugin's
// keymap.ts) — plugins are blessed standalone, so no cross-package imports.
// Standard ids resolve through the injected KeybindingsManager so user
// rebinds apply; q is a hardcoded extra since plugin-only keys can't be
// rebindable actions.

import { matchesKey, wrapTextWithAnsi, type Keybinding, type KeyId, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PromptEntry } from "./history.ts";
import { SPINNER_FRAMES } from "../items-pane.ts";

/** How many list lines render at once. */
const WINDOW = 20;
/** Hard ceiling on summary lines (more only fits if the list is short). */
const SUMMARY_MAX = 5;
/** Overall line budget of the overlay (its maxHeight). */
const MAX_LINES = 28;

/** The summary block below the prompt list. */
export type SummaryState =
  | { status: "idle" } // no transcript to summarize
  | { status: "pending" } // request in flight, nothing to show yet
  | { status: "ready"; text: string }
  | { status: "stale"; text: string } // cached, but refreshing
  | { status: "error"; text: string };

function id(binding: Keybinding, fallback: KeyId) {
  return (data: string, kb?: KeybindingsManager) => (kb ? kb.matches(data, binding) : matchesKey(data, fallback));
}

const CANCEL = id("tui.select.cancel", "escape");
const CONFIRM = id("tui.select.confirm", "return");
const UP = id("tui.select.up", "up");
const DOWN = id("tui.select.down", "down");
const PAGE_UP = id("tui.select.pageUp", "pageUp");
const PAGE_DOWN = id("tui.select.pageDown", "pageDown");

export interface HistoryPanelOptions {
  onClose: () => void;
  /** Enter: pick the prompt (the opener inserts it into the editor) and close. */
  onPick: (entry: PromptEntry) => void;
}

export class HistoryPanel {
  private scroll = 0;
  private selected = 0;
  // Explicit fields, not constructor parameter properties: node's
  // strip-only TS mode rejects parameter properties, and panel.ts is
  // test-reachable.
  private readonly entries: PromptEntry[];
  private readonly theme: Theme;
  private readonly kb: KeybindingsManager | undefined;
  private readonly opts: HistoryPanelOptions;
  private summary: SummaryState = { status: "idle" };
  /** Spinner animation; only ticks while the summary is in flight. */
  private tui: TUI | null = null;
  private frame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    // chronological, oldest first (as loadHistory now returns)
    entries: PromptEntry[],
    theme: Theme,
    kb: KeybindingsManager | undefined,
    opts: HistoryPanelOptions,
  ) {
    this.entries = entries;
    this.theme = theme;
    this.kb = kb;
    this.opts = opts;
    // start on the newest prompt (bottom row, by the editor)
    this.selected = Math.max(0, entries.length - 1);
  }

  /** Give the panel the tui so the spinner can drive re-renders. */
  attach(tui: TUI): void {
    this.tui = tui;
    this.syncSpinner();
  }

  /** Release the spinner timer; the overlay calls dispose on close. */
  dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /** Update the summary block (call again when the async request settles,
   * then requestRender on the tui — the panel doesn't own the tui). */
  setSummary(state: SummaryState): void {
    this.summary = state;
    this.syncSpinner();
  }

  /** Run the spinner timer only while the summary block is animating
   * (pending or refreshing); otherwise no idle re-renders. */
  private syncSpinner(): void {
    const spinning = this.summary.status === "pending" || this.summary.status === "stale";
    if (spinning && this.tui && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.tui?.requestRender();
      }, 120);
    } else if (!spinning && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  invalidate(): void {}

  private keepVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + WINDOW) this.scroll = this.selected - WINDOW + 1;
    if (this.scroll < 0) this.scroll = 0;
    const maxScroll = Math.max(0, this.entries.length - WINDOW);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
  }

  handleInput(data: string): void {
    // F1 toggles: the same key that opened the panel closes it.
    if (CANCEL(data, this.kb) || data === "q" || matchesKey(data, "f1")) {
      this.opts.onClose();
      return;
    }
    if (CONFIRM(data, this.kb)) {
      const entry = this.entries[this.selected];
      if (entry) this.opts.onPick(entry);
      return;
    }
    const last = this.entries.length - 1;
    if (UP(data, this.kb) || data === "k") {
      // up = older, like ctrl+up through chat history
      this.selected = Math.max(0, this.selected - 1);
    } else if (DOWN(data, this.kb) || data === "j") {
      this.selected = Math.min(last, this.selected + 1);
    } else if (PAGE_UP(data, this.kb) || data === "g") {
      this.selected = Math.max(0, this.selected - WINDOW);
    } else if (PAGE_DOWN(data, this.kb) || data === "G") {
      this.selected = Math.min(last, this.selected + WINDOW);
    }
    this.keepVisible();
  }

  private label(entry: PromptEntry): string {
    // date is enough for recall; time-of-day noise isn't worth the columns
    const date = entry.timestamp ? entry.timestamp.slice(0, 10) : "?";
    return `${date}  ${entry.text}`;
  }

  render(width: number): string[] {
    const total = this.entries.length;
    this.keepVisible();

    // Box spans width-1 columns; the trailing column stays empty so no row
    // reaches the terminal's wrap column (the margin the unbordered panel
    // kept). Inside the frame, a one-space gutter separates the walls from
    // the content; title and footer hints sit in the top/bottom border.
    const outer = Math.max(9, width - 1);
    const content = outer - 4; // │ + gutter space on each side

    const title = `prompt history — ${total} prompt${total === 1 ? "" : "s"}, filler filtered`;
    const footer =
      "↑ older · ↓ newer · enter insert · esc/f1 close" +
      (total > WINDOW ? ` · ${this.scroll + 1}-${Math.min(total, this.scroll + WINDOW)} of ${total}` : "");

    // Border row: `${open}─ ${text} ${dashes}${close}`, sized so the total
    // is always exactly `outer` columns — text yields room to the fill.
    const edge = (open: string, close: string, text: string): string =>
      this.edgeRow(open, close, text, outer);

    const lines: string[] = [];
    lines.push(edge("┌", "┐", title));
    if (total === 0) {
      lines.push(`│ ${this.theme.fg("dim", " no prompts yet".padEnd(content))} │`);
    } else {
      for (let i = this.scroll; i < Math.min(total, this.scroll + WINDOW); i++) {
        const marker = i === this.selected ? "▸ " : "  ";
        const body = ` ${marker}${truncate(this.label(this.entries[i]), content - 3)}`;
        // full-width blue block inside the gutter, like a chat user message
        lines.push(`│ ${this.theme.bg("userMessageBg", body.padEnd(content))} │`);
      }
    }
    this.renderSummary(lines, content, outer);
    lines.push(edge("└", "┘", footer));
    return lines;
  }

  /** Border row sized so the total is always exactly `outer` columns —
   * text yields room to the dash fill. */
  private edgeRow(open: string, close: string, text: string, outer: number): string {
    const vis = Math.min(visibleLen(text), outer - 5);
    const dashes = outer - 5 - vis;
    return (
      this.theme.fg("dim", `${open}─ ${clip(text, vis)} `) +
      this.theme.fg("dim", "─".repeat(dashes) + close)
    );
  }

  /** Append the summary section below the list: a ├─ summary ─┤ rule,
   * then the wrapped summary text — or a placeholder while the request
   * is in flight. Fits inside the overlay's line budget: list lines the
   * scroll window didn't use give the summary extra room. */
  private renderSummary(lines: string[], content: number, outer: number): void {
    const shown = lines.length - 1; // rows between the two border lines
    const budget = Math.max(0, MAX_LINES - 2 - shown - 1); // borders, list, rule
    const s = this.summary;
    const rule = this.edgeRow("├", "┤", "summary", outer);
    if (s.status === "idle") return;
    if (budget < 1) return;
    lines.push(rule);
    if (s.status === "pending" || s.status === "stale") {
      // One animated spinner row while the request runs.
      const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      const label = s.status === "pending" ? "summarizing…" : "updating…";
      lines.push(
        `│ ${this.theme.fg("accent", ` ${glyph}`)} ${this.theme.fg("dim", label.padEnd(content - 3))} │`,
      );
      if (s.status === "stale" && budget >= 2) {
        this.summaryLines(lines, s.text, content, budget - 1);
      }
      return;
    }
    if (s.status === "error") {
      lines.push(`│ ${this.theme.fg("warning", truncate(`summary failed: ${s.text}`, content).padEnd(content))} │`);
      return;
    }
    this.summaryLines(lines, s.text, content, budget);
  }

  /** Word-wrap the summary into gutter-framed rows (up to `max`). */
  private summaryLines(lines: string[], text: string, content: number, max: number): void {
    const wrapped = wrapTextWithAnsi(text.trim(), content - 2).slice(0, Math.max(1, max));
    for (const w of wrapped) {
      lines.push(`│ ${this.theme.fg("dim", ` ${w}`.padEnd(content))} │`);
    }
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Rendered column count, ignoring SGR escapes. */
function visibleLen(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Hard-truncate plain text to `max` visible columns with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n+/g, " ↵ ");
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + "…";
}
