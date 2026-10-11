// Line-window scrolling for overlay modals. The TUI's overlay path renders
// components directly (no layout pass), so ScrollView never gets a viewport
// and its scrollBy is inert there. This does the windowing itself: keep the
// full line list, render only the visible slice. Wrap lines to width before
// setLines — the window counts display lines.

export class LineWindow {
  private lines: string[] = [];
  private top = 0;

  constructor(public viewport: number) {}

  setLines(lines: string[]): void {
    this.lines = lines;
    this.top = Math.min(this.top, Math.max(0, lines.length - this.viewport));
  }

  get contentHeight(): number {
    return this.lines.length;
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

  scrollToEnd(): void {
    this.top = Math.max(0, this.lines.length - this.viewport);
  }

  /** The visible slice, plus a right-edge scrollbar column when scrollable. */
  render(): string[] {
    const slice = this.lines.slice(this.top, this.top + this.viewport);
    if (!this.scrollable) return slice;
    const thumbHeight = Math.max(1, Math.floor((this.viewport * this.viewport) / this.lines.length));
    const thumbStart = Math.round(this.position * (this.viewport - thumbHeight));
    return slice.map((line, i) => `${line} ${i >= thumbStart && i < thumbStart + thumbHeight ? "▐" : "│"}`);
  }
}

/** Wrap plain (ANSI-free) text to a width, preserving blank lines. */
export function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > width && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Visible content rows for a modal: terminal height minus chrome, clamped. */
export function modalViewport(): number {
  const rows = process.stdout.rows ?? 40;
  return Math.max(8, Math.min(45, rows - 14));
}
