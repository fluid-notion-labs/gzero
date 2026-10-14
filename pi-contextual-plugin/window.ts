// Line-window scrolling for overlay modals. The TUI's overlay path renders
// components directly (no layout pass), so ScrollView never gets a viewport
// and its scrollBy is inert there. This does the windowing itself: keep the
// full line list, render only the visible slice. Wrap lines to width before
// setLines — the window counts display lines.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padToVisible } from "./items-tree.ts";

/**
 * Frame `innerLines` in a full box: cornered top/bottom rules and vertical
 * rails on both sides. Lines are truncated (ANSI-aware) and padded to the
 * inner width so every row is exactly `width` columns.
 */
export function boxFrame(width: number, innerLines: string[], style: (s: string) => string): string[] {
  const inner = Math.max(width - 2, 12);
  const pad = (line: string) => {
    const fitted = truncateToWidth(line, inner);
    return fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
  };
  return [
    style(`┌${"─".repeat(inner)}┐`),
    ...innerLines.map((line) => style("│") + pad(line) + style("│")),
    style(`└${"─".repeat(inner)}┘`),
  ];
}

export class LineWindow {
  private lines: string[] = [];
  private top = 0;

  viewport: number;

  constructor(viewport: number) {
    this.viewport = viewport;
  }

  setLines(lines: string[]): void {
    this.lines = lines;
    this.top = Math.min(this.top, Math.max(0, lines.length - this.viewport));
  }

  get contentHeight(): number {
    return this.lines.length;
  }

  /** Current top line of the viewport. */
  get scrollTop(): number {
    return this.top;
  }

  get scrollable(): boolean {
    return this.lines.length > this.viewport;
  }

  /** Fraction scrolled, 0..1, for the position readout. */
  get position(): number {
    const max = Math.max(1, this.lines.length - this.viewport);
    return Math.min(1, this.top / max);
  }

  scrollBy(delta: number): void {
    this.top = Math.max(0, Math.min(this.lines.length - this.viewport, this.top + delta));
  }

  scrollToStart(): void {
    this.top = 0;
  }

  /** Scroll so the given line index is at the top (clamped). */
  scrollTo(line: number): void {
    this.top = Math.max(0, Math.min(this.lines.length - this.viewport, line));
  }

  scrollToEnd(): void {
    this.top = Math.max(0, this.lines.length - this.viewport);
  }

  /**
   * The visible slice, plus a right-edge scrollbar column when scrollable.
   * With `avail`, lines are truncated/padded to `avail - 2` first so the
   * scrollbar column lands at the right edge instead of floating mid-line
   * behind unpadded content; without it, lines pass through unpadded.
   */
  render(avail?: number): string[] {
    const slice = this.lines.slice(this.top, this.top + this.viewport);
    if (avail !== undefined) {
      const content = this.scrollable ? avail - 2 : avail;
      for (let i = 0; i < slice.length; i++) slice[i] = padToVisible(slice[i], content);
    }
    if (!this.scrollable) return slice;
    const thumbHeight = Math.max(1, Math.floor((this.viewport * this.viewport) / this.lines.length));
    const thumbStart = Math.round(this.position * (this.viewport - thumbHeight));
    return slice.map((line, i) => `${line} ${i >= thumbStart && i < thumbStart + thumbHeight ? "▐" : "│"}`);
  }
}

/**
 * Wrap plain (ANSI-free) text to a width, preserving blank lines and each
 * line's leading indentation. Continuation lines reuse the original indent,
 * so task-list/nested content keeps its shape (e.g. `  - [ ] child`).
 *
 * Widths are display columns (visibleWidth), not string lengths — wide
 * characters (CJK, emoji) would otherwise wrap at the wrong position.
 */
export function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const indent = para.match(/^[ \t]*/)?.[0] ?? "";
    const body = para.slice(indent.length);
    if (body === "") {
      out.push("");
      continue;
    }
    // The indent is spaces/tabs; tab counts as one column here, matching
    // how the terminal renders it after `indent + line` is emitted.
    const indentWidth = visibleWidth(indent);
    const lineWidth = width - indentWidth;
    let line = "";
    let lineWidthSoFar = 0;
    for (const word of body.split(/\s+/)) {
      const add = (lineWidthSoFar > 0 ? 1 : 0) + visibleWidth(word);
      if (lineWidthSoFar + add > lineWidth && line) {
        out.push(indent + line);
        line = word;
        lineWidthSoFar = visibleWidth(word);
      } else {
        line = line ? `${line} ${word}` : word;
        lineWidthSoFar += add;
      }
    }
    if (line) out.push(indent + line);
  }
  return out;
}

/**
 * Visible content rows for a modal sized to ~3/4 of the screen: 75% of the
 * terminal height minus chrome (header, hints, borders), clamped.
 */
export function modalViewport(): number {
  const rows = process.stdout.rows ?? 40;
  return Math.max(8, Math.round(rows * 0.75) - 9);
}
