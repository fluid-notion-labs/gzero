// palette.ts — the ctrl+space everything-palette overlay (docs.plan:
// docs.palette). One input, all regions ranked, one colored icon per
// region. Mirrors the GzeroPanel overlay pattern: a focused component
// that owns input until done.
//
// v0 regions: items, docs, atoms, branches, commits, skills.
// Actions insert the picked entry's action text into the editor and
// close — composing context into the prompt is the universal verb.

import { matchesKey } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { viewerNav, type ViewerNav } from "./keymap.ts";
import {
  REGION_ICONS,
  REGION_LABELS,
  parseQuery,
  type RecallEntry,
  type RecallRegion,
  type ScoredEntry,
} from "./recall.ts";

export interface PaletteDeps {
  /** Ranked results for the current query (already limited). */
  search: (query: string) => Promise<ScoredEntry[]>;
  /** Rows shown before any typing: pinned items, recent commits... */
  dashboard: () => { entry: RecallEntry; score: number }[];
  /** Perform the picked entry's action; return a user-facing note.
   * Runs AFTER the overlay has closed (pick calls done first), so an
   * action may open another overlay safely. */
  act: (entry: RecallEntry) => Promise<string> | string;
  /** Post-close feedback for the note (e.g. ctx.ui.notify). */
  notify?: (text: string) => void;
  done: (result?: unknown) => void;
  keybindings?: KeybindingsManager;
}

/** How many result rows fit under the input+footer. */
const MAX_ROWS = 12;

export class Palette {
  private deps: PaletteDeps;
  private theme: Theme;
  private nav: ViewerNav;
  private tui?: { requestRender(): void };
  private query = "";
  private results: ScoredEntry[] = [];
  private cursor = 0;
  private status = "";
  private searchSeq = 0;
  /** Set once the first search resolves; lets render show a spinner
   * before that without flickering on every keystroke. */
  private ready = false;

  constructor(deps: PaletteDeps, theme: Theme, tui?: { requestRender(): void }) {
    this.deps = deps;
    this.theme = theme;
    this.nav = viewerNav(deps.keybindings);
    this.tui = tui;
    this.results = deps.dashboard().slice(0, MAX_ROWS) as ScoredEntry[];
  }

  /** Kick the first real search (index refresh included). */
  async warm(): Promise<void> {
    await this.runSearch();
  }

  private async runSearch(): Promise<void> {
    const seq = ++this.searchSeq;
    const parsed = parseQuery(this.query);
    try {
      const res = parsed.text
        ? await this.deps.search(this.query)
        : (this.deps.dashboard().slice(0, MAX_ROWS) as ScoredEntry[]);
      if (seq !== this.searchSeq) return; // stale keystroke
      this.results = res;
      this.cursor = Math.min(this.cursor, Math.max(0, res.length - 1));
      this.status = "";
    } catch (e) {
      if (seq !== this.searchSeq) return;
      this.status = e instanceof Error ? e.message : String(e);
    }
    this.ready = true;
    // Async results arrive outside the input loop; nudge a render so
    // they actually appear.
    this.tui?.requestRender();
  }

  private async resync(): Promise<void> {
    this.cursor = 0;
    await this.runSearch();
  }

  handleInput(data: string): void {
    if (this.nav.cancel(data) || matchesKey(data, "escape")) {
      this.deps.done();
      return;
    }
    if (this.nav.up(data) || matchesKey(data, "ctrl+up")) {
      this.move(-1);
      return;
    }
    if (this.nav.down(data) || matchesKey(data, "ctrl+down")) {
      this.move(1);
      return;
    }
    if (this.nav.confirm(data) || matchesKey(data, "enter")) {
      void this.pick();
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
      this.query = this.query.slice(0, -1);
      void this.resync();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      void this.resync();
      return;
    }
    const printable = printableText(data);
    if (printable) {
      this.query += printable;
      void this.resync();
    }
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + delta));
  }

  private async pick(): Promise<void> {
    const hit = this.results[this.cursor];
    if (!hit) return;
    const entry = hit.entry;
    this.deps.done(undefined); // close the overlay before acting
    const note = await this.deps.act(entry);
    if (note) this.deps.notify?.(note);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const parsed = parseQuery(this.query);
    // input line
    const regionNote = parsed.region ? `[${REGION_LABELS[parsed.region]}] ` : "";
    const prompt = `${regionNote}${this.query}▏`;
    lines.push(this.theme.fg("accent", truncateToWidth(`find: ${prompt}`, width)));
    lines.push("");

    if (!this.ready && this.results.length === 0) {
      lines.push(this.theme.fg("muted", "  indexing…"));
    } else if (this.results.length === 0) {
      lines.push(this.theme.fg("muted", "  nothing matches"));
    }
    for (let i = 0; i < this.results.length && i < MAX_ROWS; i++) {
      const r = this.results[i];
      const icon = REGION_ICONS[r.entry.region] ?? "•";
      const label = truncateToWidth(r.entry.title, Math.max(10, width - 10));
      const prefix = i === this.cursor ? "▸ " : "  ";
      const line = `${prefix}${icon} ${label}`;
      const styled =
        i === this.cursor
          ? this.theme.fg("accent", line)
          : line;
      lines.push(truncateToWidth(styled, width));
    }
    if (this.status) {
      lines.push("");
      lines.push(this.theme.fg("warning", `  ${truncateToWidth(this.status, width - 4)}`));
    }
    lines.push("");
    lines.push(
      this.theme.fg(
        "muted",
        truncateToWidth(
          "  enter: act · type to search (t: d: x: b: c: k: filters) · esc: close",
          width,
        ),
      ),
    );
    return lines;
  }
}

/** Extract printable text from a key event (typing into the query),
 * ignoring control sequences. */
function printableText(data: string): string {
  if (!data || data.length === 0) return "";
  // single printable character (incl. space), no control prefix
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  // paste-like multi-char input: keep printable runs
  if (data.length > 1 && !data.includes("\x1b")) {
    return data.replace(/[^\x20-\x7e]/g, "");
  }
  return "";
}
