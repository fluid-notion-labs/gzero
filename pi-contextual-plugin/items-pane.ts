// items-pane.ts — the workflow pane: persistent right-side work items.
//
// A non-capturing overlay (never takes keyboard focus) anchored top-right,
// a la Claude Code's task panel. Refreshed on session start, after each
// agent run, and via `/items refresh`. Hidden automatically while the
// workflow doc has no items or the terminal is too narrow; `/items` toggles.
//
// Data comes from the `cx` CLI (`cx item list --json`), which scopes to the
// session's repo identity by itself.

import { execFile } from "node:child_process";
import type {
  Component,
  OverlayHandle,
  TUI,
} from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
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

const MAX_ROWS = 28;
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
  scopeLabel = "";
  error: string | null = null;
  private theme: Theme | null = null;
  private tui: TUI | null = null;
  private cacheKey = "";
  private lines: string[] | null = null;

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
  }

  invalidate(): void {
    this.lines = null;
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
    }));
    const scope = (items[0] as { scope?: string } | undefined)?.scope ?? "";
    const key = JSON.stringify(rows.slice(0, MAX_ROWS)) + scope;
    this.scopeLabel = shortScope(scope);
    this.error = null;
    if (key === this.cacheKey) return false;
    this.cacheKey = key;
    this.rows = rows;
    this.invalidate();
    this.tui?.requestRender();
    return true;
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (!theme || width < 12) return [];
    if (this.lines && this.cacheWidth === width) return this.lines;
    const w = Math.min(width, 60);
    const inner = w - 4; // │ + space + content + space + │
    const lines: string[] = [];

    const title = truncateToWidth(` workflow${this.scopeLabel ? " · " + this.scopeLabel : ""} `, inner);
    lines.push(
      theme.fg("borderMuted", "╭" + "─".repeat(w - 2) + "╮"),
    );
    lines.push(
      theme.fg("borderMuted", "│ ") +
        theme.fg("toolTitle", title.padEnd(inner)) +
        theme.fg("borderMuted", " │"),
    );

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
      for (const row of this.rows.slice(0, MAX_ROWS)) {
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
      if (this.rows.length > MAX_ROWS) {
        const more = truncateToWidth(`… +${this.rows.length - MAX_ROWS} more`, inner);
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

  private cacheWidth = -1;
}

/** Pad an already-styled string to the given visible width. */
function padStyled(styled: string, width: number): string {
  // Our styled strings are theme.fg() segments around plain text; strip
  // the ANSI escapes and pad by visible cell count.
  const plain = styled.replace(/\x1b\[[0-9;]*m/g, "");
  return styled + " ".repeat(Math.max(0, width - plain.length));
}

function shortScope(scope: string): string {
  if (!scope) return "";
  const parts = scope.split("/");
  return parts[parts.length - 1];
}

/**
 * Owns the overlay lifecycle. The `ctx.ui.custom` promise stays pending
 * for the whole session (the pane never completes on its own); `/items off`
 * completes it.
 */
export class ItemsPaneController {
  private pane: ItemsPane | null = null;
  private handle: OverlayHandle | null = null;
  private done: ((result: undefined) => void) | null = null;
  private opening = false;

  get active(): boolean {
    return this.pane !== null;
  }

  async toggle(ctx: ExtensionContext): Promise<void> {
    if (this.active) {
      this.close();
      return;
    }
    await this.open(ctx);
  }

  async open(ctx: ExtensionContext): Promise<void> {
    if (this.active || this.opening || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.opening = true;
    const pane = new ItemsPane();
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
          return pane;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: 46,
            minWidth: 32,
            maxHeight: "96%",
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
      this.opening = false;
      this.pane = null;
      this.handle = null;
      this.done = null;
    }
  }

  close(): void {
    const done = this.done;
    this.done = null;
    this.handle = null;
    this.pane = null;
    done?.(undefined);
  }

  async refresh(): Promise<void> {
    if (!this.pane) return;
    await this.pane.refresh();
    this.syncVisibility();
  }

  /** Auto-hide while there is nothing to show. */
  private syncVisibility(): void {
    if (!this.handle || !this.pane) return;
    this.handle.setHidden(!this.pane.hasContent() && this.pane.error === null);
  }
}
