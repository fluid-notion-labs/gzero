// items-pane.ts — the tasks sidebar: persistent work-items surfaces.
//
// Two surfaces:
//
// - The strip: a one-line horizontal glyph row in pi's in-layout widget
//   slot above the editor. It is part of the layout, not an overlay, so
//   it never covers the chat — the chat just gets one row shorter.
// - The panel: a non-capturing overlay (never takes keyboard focus)
//   anchored top-right, a la Claude Code's task panel, toggled with
//   ctrl+q / /tasks.
//
// Refreshed on session start, after each agent run, and via
// `/tasks refresh`. The strip hides itself while the repo has no items;
// `/tasks` toggles the panel (/items is an alias).
//
// Data comes from the `cx` CLI (`cx item list --json`), which scopes to the
// session's repo identity by itself.

import { execFile } from "node:child_process";
import type {
  Component,
  OverlayHandle,
  TUI,
} from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildItemTree, flattenTree, type RawItem } from "./items-tree.ts";

export interface ItemRow {
  id: string;
  title: string;
  priority: number;
  status: string;
  blocked_by: string[];
  /** Tree depth from child_of edges; rendered as two spaces per level. */
  depth: number;
  /** Creation time; the strip's timeline ordering uses it within groups. */
  created: number;
}

/** Spinner frames for in-progress tasks in the strip (braille dots). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type StripColor = "muted" | "accent" | "success" | "warning" | "dim";

/**
 * Strip timeline order: closed (past) at top, then in-progress, then
 * open (future) — new tasks appear at the bottom and work flows upward
 * as it completes. Oldest first within each group. The full panel keeps
 * tree order; this ordering is strip-only.
 */
export function stripOrder(rows: ItemRow[]): ItemRow[] {
  const rank = (r: ItemRow) => (r.status === "closed" ? 0 : r.status === "in_progress" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.created - b.created);
}

/** One cell of the strip: status glyph (or spinner frame) + color. */
export function stripGlyph(row: ItemRow, frame: number): { glyph: string; color: StripColor } {
  if (row.blocked_by.length > 0 && row.status !== "closed") return { glyph: "⊘", color: "warning" };
  if (row.status === "closed") return { glyph: "✓", color: "dim" };
  if (row.status === "in_progress") {
    return { glyph: SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length], color: "accent" };
  }
  return { glyph: "○", color: "muted" };
}

/**
 * Pure strip model: timeline-ordered glyph cells, capped at `cap` rows.
 * Overflow drops from the TOP (past) — current work stays visible — and
 * a ⋮ marks the hidden older items in the first cell.
 */
export function stripLines(
  rows: ItemRow[],
  opts: { frame: number; cap: number },
): { glyph: string; color: StripColor }[] {
  const ordered = stripOrder(rows);
  let shown = ordered;
  let overflow = false;
  if (ordered.length > Math.max(1, opts.cap)) {
    shown = ordered.slice(ordered.length - (Math.max(1, opts.cap) - 1));
    overflow = true;
  }
  const cells: { glyph: string; color: StripColor }[] = overflow ? [{ glyph: "⋮", color: "dim" }] : [];
  for (const row of shown) cells.push(stripGlyph(row, opts.frame));
  return cells;
}

/** Startup mode for the tasks overlay; CX_TASKS_STRIP=0 keeps the panel. */
export function initialStripMode(env: NodeJS.ProcessEnv = process.env): "strip" | "panel" {
  return env.CX_TASKS_STRIP === "0" ? "panel" : "strip";
}

interface JsonItem {
  id: string;
  title: string;
  priority: number;
  status: string;
  blocked_by?: string[];
  child_of?: string[];
}

const STATUS_ICON: Record<string, { icon: string; color: "muted" | "accent" | "success" }> = {
  open: { icon: "○", color: "muted" },
  in_progress: { icon: "●", color: "accent" },
  closed: { icon: "✓", color: "success" },
};

/**
 * Task rows the full panel may show on a terminal of `rows` lines:
 * enough headroom that the overlay never reaches the bottom of the
 * screen — the rule is to leave 2 lines of space at the bottom.
 */
export function taskRowCap(rows: number | undefined): number {
  return Math.max(1, (rows ?? 40) - 6);
}
/** How many recently finished items float at the top of the pane. */
const RECENT_FINISHED = 3;

export function run(
  cmd: string,
  args: string[],
  timeout = 5000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const codeVal: unknown = (err as { code?: unknown } | null)?.code;
      const code = typeof codeVal === "number" ? codeVal : err ? 1 : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

export class ItemsPane implements Component {
  rows: ItemRow[] = [];
  error: string | null = null;
  /** strip = 1-column status rail; panel = the full sidebar. */
  mode: "strip" | "panel" = "strip";
  private theme: Theme | null = null;
  private tui: TUI | null = null;
  private cacheKey = "";
  private lines: string[] | null = null;
  /** Spinner animation state; only ticks while a spinner is visible. */
  private frame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
    this.syncSpinner();
  }

  invalidate(): void {
    this.lines = null;
  }

  /** Release the spinner timer — the controller calls this on close. */
  dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /**
   * Run the spinner timer only while the strip shows at least one
   * in-progress (unblocked) task; otherwise no idle re-renders.
   */
  private syncSpinner(): void {
    const spinning =
      this.mode === "strip" &&
      this.rows.some((r) => r.status === "in_progress" && !(r.blocked_by.length > 0));
    if (spinning && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.invalidate();
        this.tui?.requestRender();
      }, 120);
    } else if (!spinning && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  hasContent(): boolean {
    return this.rows.length > 0;
  }

  /** Fetch items; returns true if the visible data changed. */
  async refresh(): Promise<boolean> {
    const res = await run("cx", ["item", "list", "--json"]);
    // Stale cx without the item command: no data, not an error — the
    // auto-opened pane stays hidden instead of nagging.
    if (res.code === 2 || /unknown command/.test(res.stderr)) {
      if (this.rows.length !== 0 || this.error !== null) {
        this.rows = [];
        this.error = null;
        this.invalidate();
        this.tui?.requestRender();
        return true;
      }
      return false;
    }
    if (res.code !== 0) {
      const msg = res.stderr.trim().split("\n")[0] || `cx item failed (${res.code})`;
      if (this.error !== msg || this.rows.length !== 0) {
        this.error = msg;
        this.rows = [];
        this.invalidate();
        this.tui?.requestRender();
        return true;
      }
      return false;
    }
    const raw = res.stdout;
    let items: JsonItem[];
    try {
      const parsed: unknown = JSON.parse(raw);
      items = Array.isArray(parsed) ? (parsed as JsonItem[]) : [];
    } catch {
      if (!this.error) {
        this.error = "unparseable cx output";
        this.invalidate();
        return true;
      }
      return false;
    }
    // Tree order via items-tree: siblings in queue order (Storage-owned;
    // no status/priority sorting). On top, the three most recently
    // finished items float; everything else stays in queue order.
    const flat = flattenTree(buildItemTree(items as unknown as RawItem[]));
    const recentFinished = flat
      .filter((f) => f.item.status === "closed" && typeof f.item.closed_at === "number")
      .sort((a, b) => (b.item.closed_at ?? 0) - (a.item.closed_at ?? 0))
      .slice(0, RECENT_FINISHED)
      .map((f) => f.item.id);
    const floats = new Set(recentFinished);
    const ordered = [
      ...flat.filter((f) => floats.has(f.item.id)),
      ...flat.filter((f) => !floats.has(f.item.id)),
    ];
    const rows: ItemRow[] = ordered.map((f) => ({
      id: String(f.item.id ?? ""),
      title: String(f.item.title ?? ""),
      priority: Number(f.item.priority ?? 0),
      status: String(f.item.status ?? "open"),
      blocked_by: Array.isArray(f.item.blocked_by)
        ? f.item.blocked_by.map(String)
        : [],
      depth: f.depth,
      created: Number(f.item.created ?? 0),
    }));
    const scope = (items[0] as { scope?: string } | undefined)?.scope ?? "";
    const key = JSON.stringify(rows.slice(0, taskRowCap(process.stdout.rows))) + scope;
    this.error = null;
    if (key === this.cacheKey) return false;
    this.cacheKey = key;
    this.rows = rows;
    this.syncSpinner();
    this.invalidate();
    this.tui?.requestRender();
    return true;
  }

  render(width: number): string[] {
    if (this.mode === "strip") return this.renderStrip(width);
    const theme = this.theme;
    if (!theme || width < 12) return [];
    if (this.lines && this.cacheWidth === width) return this.lines;
    const w = Math.min(width, 60);
    const inner = w - 4; // │ + space + content + space + │
    const lines: string[] = [];
    // Same height as the strip: the same taskRowCap governs both
    // surfaces, so the old fixed 28-row cap cannot bind first on tall
    // terminals and leave the panel shorter than the strip.
    const maxRows = taskRowCap(process.stdout.rows);

    const title = truncateToWidth(" tasks ", inner);
    lines.push(
      theme.fg("borderMuted", "╭" + "─".repeat(w - 2) + "╮"),
    );
    lines.push(
      theme.fg("borderMuted", "│ ") +
        theme.fg("toolTitle", title.padEnd(inner)) +
        theme.fg("borderMuted", " │"),
    );
    // Rule under the title, separating the header from the list.
    lines.push(theme.fg("borderMuted", "├" + "─".repeat(w - 2) + "┤"));

    if (this.error) {
      lines.push(
        theme.fg("borderMuted", "│ ") +
          theme.fg("warning", truncateToWidth(`⚠ ${this.error}`, inner).padEnd(inner)) +
          theme.fg("borderMuted", " │"),
      );
    } else if (this.rows.length === 0) {
      lines.push(
        theme.fg("borderMuted", "│ ") +
          theme.fg("dim", "(no items)".padEnd(inner)) +
          theme.fg("borderMuted", " │"),
      );
    } else {
      for (const row of this.rows.slice(0, maxRows)) {
        const icon = STATUS_ICON[row.status] ?? STATUS_ICON.open;
        const blocked = row.blocked_by.length > 0 && row.status !== "closed";
        const glyph = blocked ? "⊘" : icon.icon;
        const color = blocked ? ("warning" as const) : icon.color;
        const indent = "  ".repeat(row.depth);
        const label = truncateToWidth(
          `${indent}${row.id} ${row.priority !== 0 ? `p${row.priority} ` : ""}${row.title}`,
          inner - 2,
        );
        const styled =
          theme.fg(color, glyph) + " " +
          (row.status === "closed"
            ? theme.fg("dim", label)
            : theme.fg("text", label));
        lines.push(
          theme.fg("borderMuted", "│ ") +
            padStyled(styled, inner) +
            theme.fg("borderMuted", " │"),
        );
      }
      if (this.rows.length > maxRows) {
        const more = truncateToWidth(`… +${this.rows.length - maxRows} more`, inner);
        lines.push(
          theme.fg("borderMuted", "│ ") +
            theme.fg("dim", more.padEnd(inner)) +
            theme.fg("borderMuted", " │"),
        );
      }
    }

    lines.push(theme.fg("borderMuted", "╰" + "─".repeat(w - 2) + "╯"));
    this.cacheWidth = width;
    this.lines = lines;
    return lines;
  }

  /**
   * Strip mode: a single horizontal glyph row for the widget slot above
   * the editor. In-layout, so it never covers the chat. Empty when there
   * is nothing to show (the controller then removes the widget entirely,
   * so no blank line is reserved). Capped to the terminal width;
   * overflow drops from the top (past) with ⋮ marking the hidden items.
   */
  private renderStrip(width: number): string[] {
    const theme = this.theme;
    if (!theme) return [];
    if (this.error) return [theme.fg("warning", "⚠")];
    if (this.rows.length === 0) return [];
    // Roughly one 2-cell slot per task (glyph + space); stripLines caps
    // the timeline the same way it did for the vertical rail.
    const cap = Math.max(1, Math.floor((width + 1) / 2));
    const cells = stripLines(this.rows, { frame: this.frame, cap });
    const line = cells.map((c) => theme.fg(c.color, c.glyph)).join(" ");
    return [truncateToWidth(line, width)];
  }

  private cacheWidth = -1;
}

/** Pad an already-styled string to the given visible width. */
function padStyled(styled: string, width: number): string {
  // Our styled strings are theme.fg() segments around plain text; strip
  // the ANSI escapes and pad by visible cell count.
  const plain = styled.replace(/\x1b\[[0-9;]*m/g, "");
  return styled + " ".repeat(Math.max(0, width - plain.length));
}


/**
 * Owns both surfaces. The panel is an overlay whose `ctx.ui.custom`
 * promise stays pending for the whole session (it never completes on
 * its own); `/items off` completes it. The strip is an in-layout
 * widget above the editor, registered with `ctx.ui.setWidget`.
 */
export class ItemsPaneController {
  private static readonly STRIP_KEY = "tasks-strip";
  private pane: ItemsPane | null = null; // the full panel
  private handle: OverlayHandle | null = null;
  private done: ((result: undefined) => void) | null = null;
  private stripPane: ItemsPane | null = null; // the always-on strip
  /** Last context the strip widget was registered with. */
  private stripCtx: ExtensionContext | null = null;
  /** Whether the strip widget is currently registered with pi. */
  private stripShown = false;
  private opening = false;
  /** Whether the strip runs at all (CX_TASKS_STRIP=0 disables). */
  private readonly stripOn = initialStripMode() === "strip";

  /** True while the full panel is open. */
  get active(): boolean {
    return this.pane !== null;
  }

  /** ctrl+q / /tasks: toggle the full panel. The strip always runs. */
  async toggle(ctx: ExtensionContext): Promise<void> {
    if (this.active) {
      this.close();
      return;
    }
    await this.open(ctx);
  }

  /** Session start: start the always-on strip (panel stays closed). */
  async start(ctx: ExtensionContext): Promise<void> {
    await this.ensureStrip(ctx);
  }

  /**
   * Open the full panel. The strip keeps running underneath — it sits
   * in the widget slot at the bottom, the panel is an overlay at the
   * top-right; when they meet on a short terminal the panel simply
   * draws over the strip and the strip is back when the panel closes.
   */
  async open(ctx: ExtensionContext): Promise<void> {
    if (this.active || this.opening || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.opening = true;
    const pane = new ItemsPane();
    pane.mode = "panel";
    try {
      await pane.refresh();
    } catch {
      // refresh already records errors on the pane itself
    }
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          pane.attach(tui, theme);
          this.done = done;
          this.pane = pane;
          this.opening = false;
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: 46,
            minWidth: 32,
            // Never reach the chat: leave 2 lines at the bottom.
            maxHeight: Math.max(1, (process.stdout.rows ?? 40) - 2),
            anchor: "top-right",
            margin: { top: 2, right: 1 },
            nonCapturing: true,
            visible: (termWidth: number) => termWidth >= 100,
          }),
          onHandle: (handle) => {
            this.handle = handle;
            this.syncVisibility();
          },
        },
      );
    } finally {
      this.pane?.dispose();
      this.pane = null;
      this.handle = null;
      this.done = null;
      this.opening = false;
    }
  }

  /** Close the panel; the strip was never hidden, nothing to restore. */
  close(): void {
    this.pane?.dispose();
    const done = this.done;
    this.done = null;
    this.handle = null;
    this.pane = null;
    this.opening = false;
    done?.(undefined);
  }

  /** Full teardown on session shutdown. */
  shutdown(): void {
    this.close();
    this.stripPane?.dispose();
    if (this.stripShown) {
      this.stripCtx?.ui.setWidget(ItemsPaneController.STRIP_KEY, undefined, { placement: "aboveEditor" });
    }
    this.stripCtx = null;
    this.stripShown = false;
    this.stripPane = null;
  }

  async refresh(): Promise<void> {
    if (this.stripPane) {
      await this.stripPane.refresh();
      this.syncStripWidget();
    }
    if (this.pane) {
      await this.pane.refresh();
      this.syncVisibility();
    }
  }

  private async ensureStrip(ctx: ExtensionContext): Promise<void> {
    if (!this.stripOn || this.stripPane || this.opening || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.opening = true;
    const pane = new ItemsPane();
    pane.mode = "strip";
    try {
      await pane.refresh();
    } catch {
      // refresh already records errors on the pane itself
    }
    this.opening = false;
    this.stripPane = pane;
    this.stripCtx = ctx;
    this.syncStripWidget();
  }

  /**
   * Register or remove the strip widget. The widget slot is in-layout
   * (it sits between the status area and the editor inside pi's dock),
   * so showing it costs one row of chat height but never covers chat
   * text. Hidden entirely when there is nothing to show, so no blank
   * line is reserved while the repo has no items.
   */
  private syncStripWidget(): void {
    const pane = this.stripPane;
    if (!this.stripCtx || !pane) return;
    const show = pane.hasContent() || pane.error !== null;
    if (show === this.stripShown) return;
    this.stripShown = show;
    this.stripCtx.ui.setWidget(
      ItemsPaneController.STRIP_KEY,
      show
        ? (tui, theme) => {
            pane.attach(tui, theme);
            // Stateless wrapper around the persistent pane: re-registering
            // the widget creates a fresh component but the pane (rows,
            // spinner frame, theme) survives.
            return {
              render: (width: number) => pane.render(width),
              invalidate: () => {},
            };
          }
        : undefined,
      { placement: "aboveEditor" },
    );
  }

  /** Auto-hide the panel while there is nothing to show. */
  private syncVisibility(): void {
    if (!this.handle || !this.pane) return;
    this.handle.setHidden(!this.pane.hasContent() && this.pane.error === null);
  }
}
