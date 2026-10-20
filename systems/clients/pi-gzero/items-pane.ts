// items-pane.ts — the tasks sidebar: persistent right-side work items.
//
// A non-capturing overlay (never takes keyboard focus) anchored top-right,
// a la Claude Code's task panel. Refreshed on session start, after each
// agent run, and via `/tasks refresh`. Hidden automatically while the
// repo has no items or the terminal is too narrow; `/tasks` toggles
// (/items is an alias).
//
// Data comes from MCP: the `item_list` tool in json mode, called with the
// same server the model uses. The provider is injected by index.ts.

import type {
  Component,
  OverlayHandle,
  TUI,
} from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildItemTree, flattenTree, type RawItem } from "./items-tree.ts";
import {
  getLoadedSkills,
} from "./skills.ts";
import {
  SKILLS_STRIP_RIGHT,
  SKILLS_STRIP_WIDTH,
  SkillsStrip,
  initialSkillsStripMode,
} from "./skills-strip.ts";

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
): { glyph: string; color: StripColor; id: string }[] {
  const ordered = stripOrder(rows);
  let shown = ordered;
  let overflow = false;
  if (ordered.length > Math.max(1, opts.cap)) {
    shown = ordered.slice(ordered.length - (Math.max(1, opts.cap) - 1));
    overflow = true;
  }
  const cells: { glyph: string; color: StripColor; id: string }[] = overflow
    ? [{ glyph: "⋮", color: "dim", id: "" }]
    : [];
  for (const row of shown) cells.push({ ...stripGlyph(row, opts.frame), id: row.id });
  return cells;
}

/** Max visible width reserved for the current-item label. The strip has
 * exactly two widths — glyph-only (5) and with label (3 + this + 2) — so
 * the overlays don't churn when the current item's title changes. */
export const STRIP_LABEL_MAX = 18;

/** Hard-clip plain text to `max` visible columns, "…" marking the cut.
 * (truncateToWidth is for styled strings — it emits ANSI escapes.) */
function clipToWidth(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  const target = Math.max(0, max - visibleWidth("…"));
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = visibleWidth(ch);
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** The current item's title as a strip label: first ≤3 words, "…" when
 * more words remain, clipped to STRIP_LABEL_MAX visible columns. */
export function stripLabel(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  let label = words.slice(0, 3).join(" ");
  if (words.length > 3) label += "…";
  return clipToWidth(label, STRIP_LABEL_MAX);
}

/** The strip's current item: first in_progress row in strip order
 * (oldest first), or null when nothing is in progress. */
export function stripCurrent(rows: ItemRow[]): ItemRow | null {
  return stripOrder(rows).find((r) => r.status === "in_progress") ?? null;
}

/** The current item's cell index within the strip's rendered cells
 * (−1 when no current item): where the stuck-out label aligns. */
export function stripLabelRow(rows: ItemRow[], opts: { frame: number; cap: number }): number {
  const current = stripCurrent(rows);
  if (!current) return -1;
  return stripLines(rows, opts).findIndex((c) => c.id === current.id);
}

/** Total on-screen width of the strip box. */
export function stripBoxWidth(hasLabel: boolean): number {
  return hasLabel ? 3 + STRIP_LABEL_MAX + 2 : 5;
}

/** Startup mode for the tasks overlay; CX_TASKS_STRIP=0 keeps the panel. */
export function initialStripMode(env: NodeJS.ProcessEnv = process.env): "strip" | "panel" {
  return env.CX_TASKS_STRIP === "0" ? "panel" : "strip";
}

const STATUS_ICON: Record<string, { icon: string; color: "muted" | "accent" | "success" }> = {
  open: { icon: "○", color: "muted" },
  in_progress: { icon: "●", color: "accent" },
  closed: { icon: "✓", color: "success" },
};

/** Overlay maxHeight for every tasks surface (strip, skills column,
 * panel): never more than 2/3 of the terminal height, so the rails
 * can't cover the chat even when many tasks are active. Enforced twice
 * — here for the render-side cap (rows/⋮ overflow marker) and via
 * overlayOptions.maxHeight as the TUI-side safety net. */
export const TASKS_MAX_HEIGHT = "66%";

/**
 * Task cells a surface may show on a terminal of `rows` lines: the
 * binding cap is 2/3 of the terminal (see TASKS_MAX_HEIGHT) minus the
 * strip's 2 border lines, with the bottom-headroom rule (2 lines) as a
 * secondary bound. Both surfaces share this cap and end up the same
 * total height — the strip draws cap cells + 2 borders, the panel cap−2
 * task rows + 4 chrome lines (title, rule, borders).
 */
export function taskRowCap(rows: number | undefined): number {
  const r = rows ?? 40;
  return Math.max(1, Math.min(r - 6, Math.floor((r * 2) / 3) - 2));
}
/** How many recently finished items float at the top of the pane. */
const RECENT_FINISHED = 3;

/** Data source for the pane: returns the scope's items as JSON objects
 * (MCP item_list, json mode). Installed once by index.ts at startup. */
let itemsProvider: (() => Promise<RawItem[]>) | null = null;
export function setItemsProvider(fn: () => Promise<RawItem[]>): void {
  itemsProvider = fn;
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
    if (!itemsProvider) {
      // Provider not installed yet (early startup): no data, not an
      // error — the auto-opened pane stays hidden instead of nagging.
      if (this.rows.length !== 0 || this.error !== null) {
        this.rows = [];
        this.error = null;
        this.invalidate();
        this.tui?.requestRender();
        return true;
      }
      return false;
    }
    let items: RawItem[];
    try {
      items = await itemsProvider();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A server without item_list (stale install): no data, not an
      // error — the auto-opened pane stays hidden instead of nagging.
      if (/unknown tool|method not found/i.test(msg)) {
        if (this.rows.length !== 0 || this.error !== null) {
          this.rows = [];
          this.error = null;
          this.invalidate();
          this.tui?.requestRender();
          return true;
        }
        return false;
      }
      if (this.error !== msg || this.rows.length !== 0) {
        this.error = msg;
        this.rows = [];
        this.invalidate();
        this.tui?.requestRender();
        return true;
      }
      return false;
    }
    // Tree order via items-tree: siblings in queue order (Storage-owned;
    // no status/priority sorting). On top, the three most recently
    // finished items float; everything else stays in queue order.
    const flat = flattenTree(buildItemTree(items));
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
    if (this.mode === "strip") return this.renderStrip();
    const theme = this.theme;
    if (!theme || width < 12) return [];
    if (this.lines && this.cacheWidth === width) return this.lines;
    const w = Math.min(width, 60);
    const inner = w - 4; // │ + space + content + space + │
    const lines: string[] = [];
    // Same total height as the strip: taskRowCap is the strip's cell
    // budget (cells + 2 borders); the panel swaps 2 of those cells for
    // its title + rule chrome.
    const maxRows = Math.max(1, taskRowCap(process.stdout.rows) - 2);

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
   * Strip mode: a 5-column bordered rail — a 3-cell content slot per
   * task with the glyph centered, so glyphs that some terminals render
   * two cells wide still fit inside the borders and the rail reads
   * symmetric. One row per task; always visible (a quiet · when there
   * are no tasks). Capped at terminal height; overflow drops from the
   * top (past) with ⋮ marking the hidden items.
   */
  /** The strip's total on-screen extent — the 5-column rail plus the
   * stuck-out label when a current item shows (controller uses this for
   * the skills column's position and relayout decisions). */
  stripWidth(): number {
    return stripBoxWidth(!this.error && this.rows.length > 0 && stripCurrent(this.rows) !== null);
  }

  private renderStrip(): string[] {
    const theme = this.theme;
    if (!theme) return [];
    const border = (s: string) => theme.fg("borderMuted", s);
    const cells = this.error
      ? [{ glyph: "⚠", color: "warning" as StripColor, id: "" }]
      : this.rows.length === 0
        ? [{ glyph: "·", color: "dim" as StripColor, id: "" }]
        : stripLines(this.rows, { frame: this.frame, cap: taskRowCap(process.stdout.rows) });
    const lines = [border("╭───╮")];
    for (const c of cells) {
      const vw = Math.min(3, visibleWidth(c.glyph));
      const left = Math.floor((3 - vw) / 2);
      const content =
        " ".repeat(left) + theme.fg(c.color, c.glyph) + " ".repeat(3 - vw - left);
      lines.push(border("│") + content + border("│"));
    }
    lines.push(border("╰───╯"));
    return lines;
  }

  /** The stuck-out label's alignment: the current item's row inside the
   * strip (0-based cell index), or −1 when nothing is in progress. */
  currentLabelRow(): number {
    return stripLabelRow(this.rows, { frame: this.frame, cap: taskRowCap(process.stdout.rows) });
  }

  /** The current item's stuck-out label ("" when nothing is in progress
   * or the strip shows an error). */
  currentLabelText(): string {
    const current = this.error || this.rows.length === 0 ? null : stripCurrent(this.rows);
    return current ? stripLabel(current.title) : "";
  }

  private cacheWidth = -1;
}

/** The current item's label, floating left of the strip rail. A separate
 * overlay because compositing paints every overlay column: widening the
 * 5-column rail to carry the label would erase the chat behind it on
 * every row. This overlay paints only its own line, and the controller
 * re-shows it (cheap) whenever the current row moves. */
export class StripLabelPane implements Component {
  text = "";
  private theme: Theme | null = null;

  attach(_tui: TUI, theme: Theme): void {
    this.theme = theme;
  }

  dispose(): void {}

  invalidate(): void {}

  render(_width: number): string[] {
    if (!this.theme || !this.text) return [];
    return [this.theme.fg("accent", this.text)];
  }
}

/** Pad an already-styled string to the given visible width. */
function padStyled(styled: string, width: number): string {
  // Our styled strings are theme.fg() segments around plain text; strip
  // the ANSI escapes and pad by visible cell count.
  const plain = styled.replace(/\x1b\[[0-9;]*m/g, "");
  return styled + " ".repeat(Math.max(0, width - plain.length));
}


/**
 * Owns the overlay lifecycle. The `ctx.ui.custom` promise stays pending
 * for the whole session (the pane never completes on its own); `/items off`
 * completes it.
 */
export class ItemsPaneController {
  private pane: ItemsPane | null = null; // the full panel
  private handle: OverlayHandle | null = null;
  private done: ((result: undefined) => void) | null = null;
  private stripPane: ItemsPane | null = null; // the always-on rail
  private stripHandle: OverlayHandle | null = null;
  private stripDone: ((result: undefined) => void) | null = null;
  private labelPane: StripLabelPane | null = null; // the current item's stuck-out label
  private labelHandle: OverlayHandle | null = null;
  private labelDone: ((result: undefined) => void) | null = null;
  /** The label row the label overlay was opened at (−1 = not shown). */
  private labelRow = -1;
  private skillsPane: SkillsStrip | null = null; // loaded-skills column, left of the rail
  private skillsHandle: OverlayHandle | null = null;
  private skillsDone: ((result: undefined) => void) | null = null;
  private opening = false;
  /** The strip's total on-screen extent (5, or 5+1+STRIP_LABEL_MAX with a
   * stuck-out label) — governs the skills column's position, not the rail
   * overlay, which is always the narrow 5-column box. */
  private stripWidth = 5;
  /** The session context, kept so the strip can relayout when its width changes. */
  private lastCtx: ExtensionContext | null = null;
  /** Whether the 1-column strip runs at all (CX_TASKS_STRIP=0 disables). */
  private readonly stripOn = initialStripMode() === "strip";
  /** Whether the loaded-skills column runs (CX_SKILLS_STRIP=0 disables). */
  private readonly skillsStripOn = initialSkillsStripMode() === "strip";

  /** True while the full panel is open. */
  get active(): boolean {
    return this.pane !== null;
  }

  /** /tasks (/items): toggle the full panel. The strip always runs.
   * ctrl+q now belongs to the gzero panel (da36). */
  async toggle(ctx: ExtensionContext): Promise<void> {
    if (this.active) {
      this.close();
      return;
    }
    await this.open(ctx);
  }

  /** Session start: start the always-on strip and skills column (panel stays closed). */
  async start(ctx: ExtensionContext): Promise<void> {
    this.lastCtx = ctx;
    await this.ensureStrip(ctx);
    this.labelRow = this.stripPane ? this.stripPane.currentLabelRow() : -1;
    await this.ensureLabelStrip(ctx);
    // Skills column sits just left of the rail (plus the stuck-out label
    // when one shows): 1px margin + extent + 1px gap.
    await this.ensureSkillsStrip(ctx, this.stripWidth + 2);
  }

  /**
   * Open the full panel. It covers the strip's corner, so the strip
   * hides while the panel is up and returns when the panel closes.
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
          this.stripHandle?.setHidden(true);
          this.labelHandle?.setHidden(true);
          this.skillsHandle?.setHidden(true);
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: 46,
            minWidth: 32,
            // Same 2/3 cap as the rails: never reach the chat.
            maxHeight: TASKS_MAX_HEIGHT,
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
      this.stripHandle?.setHidden(false);
      this.labelHandle?.setHidden(false);
      this.skillsHandle?.setHidden(false);
    }
  }

  /** Close the panel; the strip and skills column return. */
  close(): void {
    this.pane?.dispose();
    const done = this.done;
    this.done = null;
    this.handle = null;
    this.pane = null;
    this.opening = false;
    done?.(undefined);
    this.stripHandle?.setHidden(false);
    this.labelHandle?.setHidden(false);
    this.skillsHandle?.setHidden(false);
  }

  /** Full teardown on session shutdown. */
  shutdown(): void {
    this.close();
    this.stripPane?.dispose();
    const done = this.stripDone;
    this.stripDone = null;
    this.stripHandle = null;
    this.stripPane = null;
    done?.(undefined);
    this.labelPane?.dispose();
    const labelDone = this.labelDone;
    this.labelDone = null;
    this.labelHandle = null;
    this.labelPane = null;
    labelDone?.(undefined);
    this.skillsPane?.dispose();
    const skillsDone = this.skillsDone;
    this.skillsDone = null;
    this.skillsHandle = null;
    this.skillsPane = null;
    skillsDone?.(undefined);
  }

  async refresh(): Promise<void> {
    if (this.stripPane) await this.stripPane.refresh();
    if (this.labelPane) this.labelPane.text = this.stripPane?.currentLabelText() ?? "";
    if (this.pane) {
      await this.pane.refresh();
      this.syncVisibility();
    }
    // The skills column derives from live state on every render; nothing
    // to refresh here.
    // The stuck-out label's row is fixed at open time: re-open it when
    // the current item moves to a different cell (or appears/vanishes).
    const wantRow = this.stripPane && !this.opening ? this.stripPane.currentLabelRow() : this.labelRow;
    if (this.stripOn && wantRow !== this.labelRow && !this.opening && this.lastCtx) {
      this.labelRow = wantRow;
      await this.relayoutLabel(this.lastCtx);
    }
    // The strip has two extents (glyph-only / with stuck-out label).
    // When it crosses between them, the skills column must be
    // repositioned (the rail itself is always the narrow box).
    const want = this.stripPane ? this.stripPane.stripWidth() : stripBoxWidth(false);
    if (this.stripPane && want !== this.stripWidth && !this.opening && this.lastCtx) {
      this.stripWidth = want;
      await this.relayoutStrips(this.lastCtx);
    }
  }

  /** Re-open the strip and skills overlays at the new strip width. */
  private async relayoutStrips(ctx: ExtensionContext): Promise<void> {
    // Tear down synchronously (the guards check these fields), then
    // re-open.
    this.stripPane?.dispose();
    const stripDone = this.stripDone;
    this.stripPane = null;
    this.stripHandle = null;
    this.stripDone = null;
    stripDone?.(undefined);
    this.skillsPane?.dispose();
    const skillsDone = this.skillsDone;
    this.skillsPane = null;
    this.skillsHandle = null;
    this.skillsDone = null;
    skillsDone?.(undefined);
    this.labelPane?.dispose();
    const labelDone = this.labelDone;
    this.labelPane = null;
    this.labelHandle = null;
    this.labelDone = null;
    labelDone?.(undefined);
    await this.ensureStrip(ctx);
    if (this.labelRow >= 0) {
      await this.ensureLabelStrip(ctx);
    }
    await this.ensureSkillsStrip(ctx, this.stripWidth + 2);
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
    this.stripWidth = pane.stripWidth();
    // The rail overlay is always the narrow 5-column box; the current
    // item's label is its own overlay (ensureLabelStrip) that sticks out
    // to the left — compositing paints every overlay column, so a wider
    // rail would erase the chat behind it.
    const width = stripBoxWidth(false);
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          pane.attach(tui, theme);
          this.stripDone = done;
          this.stripPane = pane;
          this.opening = false;
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width,
            minWidth: width,
            maxHeight: TASKS_MAX_HEIGHT,
            anchor: "top-right",
            margin: { top: 2, right: 1 },
            nonCapturing: true,
            visible: (termWidth: number) => termWidth >= 60,
          }),
          onHandle: (handle) => {
            this.stripHandle = handle;
          },
        },
      );
    } finally {
      pane.dispose();
      this.stripPane = null;
      this.stripHandle = null;
      this.stripDone = null;
      this.opening = false;
    }
  }

  /**
   * The current item's label, sticking out to the left of the rail. Its
   * vertical position is fixed at open time (overlay geometry doesn't
   * update), so refresh() re-opens it whenever the current row moves.
   * Hidden (via `visible`) whenever there is no current item.
   */
  private async ensureLabelStrip(ctx: ExtensionContext): Promise<void> {
    if (!this.stripOn || this.labelPane || this.opening || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.opening = true;
    const pane = new StripLabelPane();
    pane.text = this.stripPane?.currentLabelText() ?? "";
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          pane.attach(tui, theme);
          this.labelDone = done;
          this.labelPane = pane;
          this.opening = false;
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: STRIP_LABEL_MAX,
            minWidth: STRIP_LABEL_MAX,
            maxHeight: TASKS_MAX_HEIGHT,
            anchor: "top-right",
            // Strip top margin (2) + strip top border (1) + cell row.
            margin: { top: 3 + Math.max(0, this.labelRow), right: 1 + 5 + 1 },
            nonCapturing: true,
            visible: (termWidth: number) =>
              termWidth >= 60 && (this.labelPane?.text ?? "") !== "",
          }),
          onHandle: (handle) => {
            this.labelHandle = handle;
          },
        },
      );
    } finally {
      pane.dispose();
      this.labelPane = null;
      this.labelHandle = null;
      this.labelDone = null;
      this.opening = false;
    }
  }

  /** Re-open the label overlay at the current row (position is fixed at
   * open time). No-op when there is no current item. */
  private async relayoutLabel(ctx: ExtensionContext): Promise<void> {
    if (this.labelPane) {
      this.labelPane.dispose();
      const labelDone = this.labelDone;
      this.labelPane = null;
      this.labelHandle = null;
      this.labelDone = null;
      labelDone?.(undefined);
    }
    if (this.labelRow >= 0 && this.stripPane) {
      await this.ensureLabelStrip(ctx);
    }
  }

  /**
   * The loaded-skills column: a passive narrow overlay left of the rail.
   * Visible only when skills are loaded this session (checked every
   * render cycle via `visible`, so loading one makes it appear without
   * any explicit refresh).
   */
  private async ensureSkillsStrip(
    ctx: ExtensionContext,
    rightMargin: number = SKILLS_STRIP_RIGHT,
  ): Promise<void> {
    if (!this.skillsStripOn || this.skillsPane || this.opening || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.opening = true;
    const pane = new SkillsStrip();
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          pane.attach(tui, theme);
          this.skillsDone = done;
          this.skillsPane = pane;
          this.opening = false;
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: SKILLS_STRIP_WIDTH,
            minWidth: SKILLS_STRIP_WIDTH,
            maxHeight: TASKS_MAX_HEIGHT,
            anchor: "top-right",
            margin: { top: 2, right: rightMargin },
            nonCapturing: true,
            visible: (termWidth: number) => termWidth >= 60 && getLoadedSkills().length > 0,
          }),
          onHandle: (handle) => {
            this.skillsHandle = handle;
          },
        },
      );
    } finally {
      pane.dispose();
      this.skillsPane = null;
      this.skillsHandle = null;
      this.skillsDone = null;
      this.opening = false;
    }
  }

  /** Auto-hide the panel while there is nothing to show. */
  private syncVisibility(): void {
    if (!this.handle || !this.pane) return;
    this.handle.setHidden(!this.pane.hasContent() && this.pane.error === null);
  }
}
