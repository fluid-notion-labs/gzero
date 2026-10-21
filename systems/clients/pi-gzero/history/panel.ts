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

/** How many list lines render at once when there's room. */
const WINDOW = 20;
/** The list never shrinks below this many rows to make room for the
 * summary block; a longer summary gets cut instead. */
const LIST_FLOOR = 10;
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
  /** List rows the last render actually showed (can be < WINDOW when the
   * summary block takes space); page keys and scroll clamping use it. */
  private viewRows = WINDOW;
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
    const rows = this.viewRows;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + rows) this.scroll = this.selected - rows + 1;
    if (this.scroll < 0) this.scroll = 0;
    const maxScroll = Math.max(0, this.entries.length - rows);
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
      this.selected = Math.max(0, this.selected - this.viewRows);
    } else if (PAGE_DOWN(data, this.kb) || data === "G") {
      this.selected = Math.min(last, this.selected + this.viewRows);
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

    // Box spans width-1 columns; the trailing column stays empty so no row
    // reaches the terminal's wrap column (the margin the unbordered panel
    // kept). Inside the frame, a one-space gutter separates the walls from
    // the content; title and footer hints sit in the top/bottom border.
    const outer = Math.max(9, width - 1);
    const content = outer - 4; // │ + gutter space on each side

    // Border row: `${open}─ ${text} ${dashes}${close}`, sized so the total
    // is always exactly `outer` columns — text yields room to the fill.
    const edge = (open: string, close: string, text: string): string =>
      this.edgeRow(open, close, text, outer);

    // The summary block is laid out FIRST so the list can yield room to
    // it: a section list deserves to be shown in full, with the list
    // shrinking (down to a floor) rather than the summary being cut.
    const contentBudget = MAX_LINES - 2 - 1; // borders + summary rule
    const summaryRows = this.summaryRows(content, Math.max(1, contentBudget - LIST_FLOOR));
    const listRows = total === 0 ? 1 : Math.max(1, Math.min(WINDOW, contentBudget - summaryRows.length));
    this.viewRows = listRows;
    this.keepVisible();

    const title = `prompt history — ${total} prompt${total === 1 ? "" : "s"}, filler filtered`;
    const footer =
      "↑ older · ↓ newer · enter insert · esc/f1 close" +
      (total > listRows ? ` · ${this.scroll + 1}-${Math.min(total, this.scroll + listRows)} of ${total}` : "");

    const lines: string[] = [];
    lines.push(edge("┌", "┐", title));
    if (total === 0) {
      lines.push(`│ ${this.theme.fg("dim", " no prompts yet".padEnd(content))} │`);
    } else {
      for (let i = this.scroll; i < Math.min(total, this.scroll + listRows); i++) {
        const marker = i === this.selected ? "▸ " : "  ";
        const body = ` ${marker}${truncate(this.label(this.entries[i]), content - 3)}`;
        // full-width blue block inside the gutter, like a chat user message
        lines.push(`│ ${this.theme.bg("userMessageBg", body.padEnd(content))} │`);
      }
    }
    if (summaryRows.length > 0) {
      lines.push(this.edgeRow("├", "┤", "summary", outer));
      lines.push(...summaryRows);
    }
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

  /** Build the summary section's rows (without the rule): the spinner
   * row while a request runs, the wrapped summary text, or an error line.
   * Capped at `max` rows — a long list of sections gets cut, not the
   * whole panel. */
  private summaryRows(content: number, max: number): string[] {
    const s = this.summary;
    if (s.status === "idle" || max < 1) return [];
    const rows: string[] = [];
    if (s.status === "pending" || s.status === "stale") {
      // One animated spinner row while the request runs.
      const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      const label = s.status === "pending" ? "summarizing…" : "updating…";
      rows.push(
        `│ ${this.theme.fg("accent", glyph)} ${this.theme.fg("text", label.padEnd(content - 2))} │`,
      );
      if (s.status === "stale" && max >= 2) {
        this.summaryLines(rows, s.text, content, max - 1);
      }
      return rows;
    }
    if (s.status === "error") {
      rows.push(`│ ${this.theme.fg("warning", truncate(`summary failed: ${s.text}`, content).padEnd(content))} │`);
      return rows;
    }
    this.summaryLines(rows, s.text, content, max);
    return rows;
  }

  /** Word-wrap the summary into gutter-framed rows (up to `max`),
   * padded exactly 1 character from the frame wall. Newlines in the
   * summary are preserved — one line in, one row out. */
  private summaryLines(lines: string[], text: string, content: number, max: number): void {
    const wrapped = wrapTextWithAnsi(text.trim(), content - 1).slice(0, Math.max(1, max));
    for (const w of wrapped) {
      lines.push(`│ ${this.theme.fg("text", w.padEnd(content))} │`);
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
