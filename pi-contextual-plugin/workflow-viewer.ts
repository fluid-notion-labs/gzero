// workflow-viewer.ts — the Ctrl+W / /workflow full-screen viewer.
//
// Two tabs: work items (the child_of tree) and workflow sections
// (ws sections, checklists rendered as task lists). Kept free of
// session/extension wiring so node:test can drive it directly; the
// theme is passed in and callers feed it body data.
//
// The theme arrives via the constructor: pi-tui has no attach()
// lifecycle, so relying on attach() left the theme null and the
// overlay invisible (the "ctrl+w freezes pi" report).

import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type FlatRow } from "./items-tree.ts";
import { boxFrame, LineWindow, modalViewport, wrapPlain } from "./window.ts";

const STATUS_ICON_FULL: Record<string, { icon: string; color: "muted" | "accent" | "success" | "warning" }> = {
  open: { icon: "○", color: "muted" },
  in_progress: { icon: "●", color: "accent" },
  closed: { icon: "✓", color: "success" },
};

export interface WorkflowPage {
  label: string;
  /** Body lines (no chrome) for the given inner width. */
  build: (inner: number, t: Theme) => string[];
  /** Appended to the hints footer, e.g. "11 open". */
  note?: string;
}

/**
 * Re-flow hard-wrapped prose to the pane width. Markdown authors often
 * wrap source lines at ~70 columns; rendered as-is, that leaves ragged
 * short lines and dead space on wide panes. Consecutive plain text lines
 * are joined into one paragraph (markdown treats single newlines inside
 * a paragraph as soft breaks). Everything structural stays put: blank
 * lines, headings, list items and their indented continuations,
 * blockquotes, fenced code blocks, and table rows.
 */
export function reflowMarkdown(md: string): string {
  const startsBlock = (l: string) =>
    l === "" ||
    /^#{1,6}\s/.test(l) ||
    /^\s*[-*+]\s/.test(l) ||
    /^\s*\d+[.)]\s/.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*(```|~~~)/.test(l) ||
    /^\s*\|/.test(l) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
    /^[ \t]/.test(l); // indented = list continuation or code, keep as-is
  const out: string[] = [];
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    if (para.length > 0) {
      out.push(para.join(" "));
      para = [];
    }
  };
  for (const line of md.split("\n")) {
    if (fence) {
      flush();
      out.push(line);
      if (/^\s*(```|~~~)/.test(line)) fence = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = true;
      out.push(line);
      continue;
    }
    if (startsBlock(line)) {
      flush();
      out.push(line);
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/**
 * Render markdown tables as aligned plain-text columns. A table is a
 * run of consecutive lines that start and end with `|`; the `---`
 * separator row is dropped, columns are sized to their widest cell,
 * and a dash rule sits under the header. Non-table lines pass through
 * unchanged, so section bodies keep their shape.
 */
export function renderTables(md: string): string {
  const lines = md.split("\n");
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isRow(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && isRow(lines[i])) i++;
    const rows = lines
      .slice(start, i)
      .map((l) =>
        l
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim()),
      )
      // drop separator rows (|---|---|)
      .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c) || c === ""));
    if (rows.length === 0) continue;
    const cols = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (const row of rows) {
      for (let c = 0; c < cols; c++) {
        widths[c] = Math.max(widths[c] ?? 0, (row[c] ?? "").length);
      }
    }
    const line = (cells: string[]) =>
      cells
        .map((cell, c) => (cell ?? "").padEnd(widths[c]))
        .join("  ")
        .trimEnd();
    out.push(line(rows[0]));
    out.push(widths.map((w) => "─".repeat(w)).join("  "));
    for (const row of rows.slice(1)) out.push(line(row));
  }
  return out.join("\n");
}

/** Work items tab body: the child_of tree as indented rows. */
export function buildItemBody(rows: FlatRow[], inner: number, t: Theme): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const st = STATUS_ICON_FULL[row.item.status] ?? STATUS_ICON_FULL.open;
    const blocked = row.item.blocked_by.length > 0 && row.item.status !== "closed";
    const glyph = blocked ? "⊘" : st.icon;
    const color = blocked ? "warning" : st.color;
    const indent = "  ".repeat(row.depth);
    const prefix = indent + glyph + " ";
    const meta = `${row.item.id}${row.item.priority !== 0 ? ` p${row.item.priority}` : ""}`;
    const titleWidth = Math.max(0, inner - prefix.length - meta.length - 1);
    const title = truncateToWidth(row.item.title, titleWidth);
    const line =
      t.fg(color, prefix) +
      (row.item.status === "closed" ? t.fg("dim", title) : t.fg("text", title)) +
      " " +
      t.fg("dim", meta);
    lines.push(line); // LineWindow pads to width and owns the scrollbar column
  }
  if (lines.length === 0) lines.push(` ${t.fg("dim", "(no items)")}`);
  return lines;
}

/** Workflow sections tab body: titled dividers over wrapped bodies. */
/** Structural subset of index's TierSection; avoids an import cycle. */
export interface SectionNodeGroup {
  nodes: { label: string; text: string }[];
}

export function buildSectionBody(
  sections: SectionNodeGroup[],
  inner: number,
  t: Theme,
): string[] {
  const lines: string[] = [];
  const divider = (title: string) => {
    const head = "── ";
    const tail = Math.max(0, inner - head.length - title.length - 2);
    return t.fg("borderMuted", head) + t.fg("accent", title) + t.fg("borderMuted", " " + "─".repeat(tail));
  };
  for (const section of sections) {
    for (const node of section.nodes) {
      lines.push(` ${divider(node.label)}`);
      for (const wrapped of wrapPlain(renderTables(reflowMarkdown(node.text || "(empty)")), inner - 1)) {
        lines.push(` ${wrapped}`);
      }
      lines.push("");
    }
  }
  if (lines.length === 0) lines.push(` ${t.fg("dim", "(no sections)")}`);
  return lines;
}

/**
 * Tabbed full-screen viewer for Ctrl+W and /workflow: work items and
 * workflow sections (incl. checklist/task lists) side by side as tabs.
 * tab / shift+tab (or ←/→) switch tabs, ↑↓/j/k scroll, pgup/pgdn page,
 * home/end jump, esc/q closes. One LineWindow, reset on tab switch;
 * bodies rebuild per (tab, width) with caching. The theme arrives via
 * the constructor — pi-tui has no attach() lifecycle (see TierViewer;
 * relying on attach() left the theme null and the overlay invisible).
 */
export class WorkflowViewer implements Component, Focusable {
  focused = false;
  private pages: WorkflowPage[];
  private theme: Theme;
  private done: (result?: unknown) => void;
  private tab: number;
  private window = new LineWindow(modalViewport());
  private cache: { tab: number; inner: number; lines: string[] } | null = null;

  constructor(
    pages: WorkflowPage[],
    theme: Theme,
    done: (result?: unknown) => void,
    startTab = 0,
  ) {
    this.pages = pages;
    this.theme = theme;
    this.done = done;
    this.tab = Math.max(0, Math.min(startTab, pages.length - 1));
  }

  invalidate(): void {
    this.cache = null;
  }

  private switchTo(tab: number): void {
    const next = (tab + this.pages.length) % this.pages.length;
    if (next === this.tab) return;
    this.tab = next;
    this.cache = null;
    this.window.scrollToStart();
  }

  private body(width: number): string[] {
    const inner = Math.max(width - 2, 20);
    if (this.cache && this.cache.tab === this.tab && this.cache.inner === inner) {
      return this.cache.lines;
    }
    const page = this.pages[this.tab];
    const lines = page ? page.build(inner, this.theme) : [];
    this.cache = { tab: this.tab, inner, lines };
    this.window.setLines(lines);
    return lines;
  }

  render(width: number): string[] {
    const t = this.theme;
    if (width < 12) return [];
    const body = this.body(width);
    const inner = Math.max(width - 2, 20);
    const tabs = this.pages
      .map((p, i) => {
        const label = ` ${p.label} `;
        return i === this.tab ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
      })
      .join(t.fg("dim", "│"));
    const page = this.pages[this.tab];
    const hints = `tab/shift+tab tab · ↑↓ line · pgup/pgdn page · home/end · esc/q close`;
    const footer = page?.note ? `${hints} · ${page.note}` : hints;
    return boxFrame(width, [
      ...new Text(tabs, 1).render(inner),
      t.fg("borderMuted", "─".repeat(inner)),
      ...this.window.render(inner - 1).map((line) => ` ${line}`),
      t.fg("borderMuted", "─".repeat(inner)),
      ...new Text(t.fg("dim", footer), 1).render(inner),
    ], (s: string) => t.fg("borderMuted", s));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
    } else if (matchesKey(data, "tab") || matchesKey(data, "ctrl+tab") || matchesKey(data, "right")) {
      this.switchTo(this.tab + 1);
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.switchTo(this.tab - 1);
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.window.scrollBy(-1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.window.scrollBy(1);
    } else if (matchesKey(data, "pageUp")) {
      this.window.scrollBy(-this.window.viewport + 2);
    } else if (matchesKey(data, "pageDown")) {
      this.window.scrollBy(this.window.viewport - 2);
    } else if (matchesKey(data, "home")) {
      this.window.scrollToStart();
    } else if (matchesKey(data, "end") || data === "G") {
      this.window.scrollToEnd();
    }
  }
}
