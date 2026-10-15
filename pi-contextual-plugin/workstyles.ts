// Workstyles: named sets of directives — how we get things done — stored in
// the store under scope `workstyle/<name>`, one atom per directive, node =
// directive key. Referenced from chat as `##workstyle.key(extra)`: the code
// expands to the directive text before the turn goes out, and the
// parenthetical stays inline as extra info for this repo/message.
//
// Spec: research/context/workstyle.md. The picker mirrors the
// skills picker: ctrl-space (or /workstyle) opens a searchable list of
// `workstyle.key` entries; enter inserts the code at the cursor.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  Input,
  SelectList,
  Text,
  type Component,
  type KeybindingsManager,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { keyHint, viewerNav, type ViewerNav } from "./keymap.ts";
import { boxFrame } from "./window.ts";

export interface WorkstyleEntry {
  /** Workstyle name, e.g. "dev". */
  workstyle: string;
  /** Directive key within the workstyle, e.g. "jjc". */
  key: string;
  /** Full directive text, inline #tags stripped. */
  text: string;
}

const MAX_VISIBLE = 12;

/** `##workstyle.key` codes, optionally with a parenthetical; the
 * parenthetical is extra info for this repo/message and stays in the prompt. */
export const WORKSTYLE_CODE_RE = /##([A-Za-z0-9][\w.-]*)\.([A-Za-z0-9][\w-]*)(\([^)\n]*\))?/g;

/** Unique `workstyle.key` codes referenced in a prompt. */
export function extractWorkstyleRefs(prompt: string): { workstyle: string; key: string }[] {
  const seen = new Map<string, { workstyle: string; key: string }>();
  for (const m of prompt.matchAll(WORKSTYLE_CODE_RE)) {
    const workstyle = m[1].toLowerCase();
    const key = m[2].toLowerCase();
    seen.set(`${workstyle}.${key}`, { workstyle, key });
  }
  return [...seen.values()];
}

/**
 * Parse the rendered output of `resolve { scope_prefix: "workstyle/" }`.
 * Headers look like `# workstyle/<name>/<key>`; atoms are the `- ` bullets
 * under each header.
 */
export function parseWorkstyles(rendered: string): WorkstyleEntry[] {
  const entries: WorkstyleEntry[] = [];
  let current: { workstyle: string; key: string } | null = null;
  for (const raw of rendered.split("\n")) {
    const header = raw.match(/^# workstyle\/([\w.-]+)\/([\w-]+)\s*$/);
    if (header) {
      current = { workstyle: header[1].toLowerCase(), key: header[2].toLowerCase() };
      continue;
    }
    if (raw.startsWith("# ")) current = null; // some other scope
    if (!current) continue;
    const line = raw.replace(/^-\s*/, "").trim();
    if (!line) continue;
    const text = line.replace(/\s+#[\w-]+/g, "").trim();
    if (text) entries.push({ ...current, text });
  }
  return entries;
}

// --- session cache ---------------------------------------------------------

let cache: { entries: WorkstyleEntry[]; at: number } | null = null;
const TTL = 5 * 60_000;

export function peekWorkstyles(): WorkstyleEntry[] {
  return cache && Date.now() - cache.at < TTL ? cache.entries : [];
}

export async function ensureWorkstyles(
  cxMcp: string,
  mcpCall: (cxMcp: string, tool: string, args: unknown) => Promise<string>,
  force = false,
): Promise<WorkstyleEntry[]> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.entries;
  const rendered = await mcpCall(cxMcp, "resolve", { scope_prefix: "workstyle/" });
  const entries = parseWorkstyles(rendered);
  cache = { entries, at: Date.now() };
  return entries;
}

/** The directive for a code, or undefined when the store has no such entry. */
export function findEntry(
  entries: WorkstyleEntry[],
  ref: { workstyle: string; key: string },
): WorkstyleEntry | undefined {
  return entries.find((e) => e.workstyle === ref.workstyle && e.key === ref.key);
}

/** Search: every whitespace term must appear in workstyle, key, or text. */
function matches(entry: WorkstyleEntry, query: string): boolean {
  const hay = `${entry.workstyle} ${entry.key} ${entry.text}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

// --- picker ----------------------------------------------------------------

class WorkstylePicker implements Component {
  private input = new Input({ placeholder: "search workstyle, key, or text…" });
  private list: SelectList;
  private byValue = new Map<string, WorkstyleEntry>();

  constructor(
    private entries: WorkstyleEntry[],
    private theme: Theme,
    private done: (result?: WorkstyleEntry) => void,
    /** Injected by ctx.ui.custom; optional for tests. */
    keybindings?: KeybindingsManager,
  ) {
    this.nav = viewerNav(keybindings);
    this.kb = keybindings;
    this.input.focused = true;
    this.list = this.rebuildList("");
  }

  private nav: ViewerNav;
  private kb: KeybindingsManager | undefined;

  private listTheme() {
    const t = this.theme;
    return {
      selectedPrefix: (text: string) => t.fg("accent", text),
      selectedText: (text: string) => t.fg("accent", text),
      description: (text: string) => t.fg("muted", text),
      scrollInfo: (text: string) => t.fg("dim", text),
      noMatch: (text: string) => t.fg("warning", text),
    };
  }

  private rebuildList(query: string): SelectList {
    const found = this.entries.filter((e) => matches(e, query));
    this.byValue.clear();
    const items: SelectItem[] = found.map((e) => {
      const value = `${e.workstyle}.${e.key}`;
      this.byValue.set(value, e);
      return {
        value,
        label: value,
        description: e.text.length > 90 ? `${e.text.slice(0, 89)}…` : e.text,
      };
    });
    const list = new SelectList(items, MAX_VISIBLE, this.listTheme());
    list.onSelect = (item) => {
      const entry = this.byValue.get(item.value);
      if (entry) this.done(entry);
    };
    list.onCancel = () => this.done();
    return list;
  }

  handleInput(data: string): void {
    if (this.nav.cancel(data)) {
      this.done();
      return;
    }
    if (
      this.nav.up(data) ||
      this.nav.down(data) ||
      this.nav.pageUp(data) ||
      this.nav.pageDown(data)
    ) {
      this.list.handleInput(data);
      return;
    }
    if (this.nav.confirm(data)) {
      const sel = this.list.getSelectedItem();
      const entry = sel ? this.byValue.get(sel.value) : undefined;
      if (entry) this.done(entry);
      return;
    }
    this.input.handleInput(data);
    this.list = this.rebuildList(this.input.getValue());
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(width - 2, 20);
    return boxFrame(width, [
      ...new Text(t.fg("accent", t.bold("Workstyles")), 1).render(inner),
      ...new Text(t.fg("dim", "pick a directive — inserts ##workstyle.key (parenthesize for extra info)"), 1).render(inner),
      ...this.input.render(Math.max(inner - 2, 20)).map((line) => ` ${line}`),
      ...this.list.render(inner),
      ...new Text(
        t.fg(
          "dim",
          `type to filter · ${keyHint(this.kb, "tui.select.up", "↑")}${keyHint(this.kb, "tui.select.down", "↓")} select · ${keyHint(this.kb, "tui.select.confirm", "enter")} insert · ${keyHint(this.kb, "tui.select.cancel", "esc")} close`,
        ),
        1,
      ).render(inner),
    ], (s: string) => t.fg("borderMuted", s));
  }
}

async function openPicker(
  ctx: ExtensionContext,
  cxMcp: string,
  mcpCall: (cxMcp: string, tool: string, args: unknown) => Promise<string>,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Workstyle picker is available in TUI mode (/workstyle)", "warning");
    return;
  }
  let entries: WorkstyleEntry[];
  try {
    entries = await ensureWorkstyles(cxMcp, mcpCall);
  } catch (e) {
    ctx.ui.notify(`Could not load workstyles: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  if (entries.length === 0) {
    ctx.ui.notify(
      "No workstyles in the store. Add one: /context add, with scope workstyle/<name> and node <key>",
      "info",
    );
    return;
  }
  const picked = await ctx.ui.custom<WorkstyleEntry | undefined>(
    (_tui, theme, keybindings, done) => new WorkstylePicker(entries, theme, done, keybindings),
    {
      overlay: true,
      overlayOptions: { width: "75%", minWidth: 70, maxHeight: "85%", anchor: "center" },
    },
  );
  if (picked) {
    ctx.ui.pasteToEditor(`##${picked.workstyle}.${picked.key} `);
  }
}

export function registerWorkstyles(
  pi: ExtensionAPI,
  deps: {
    findCxMcp: () => Promise<string | null>;
    mcpCall: (cxMcp: string, tool: string, args: unknown) => Promise<string>;
  },
): void {
  const open = async (ctx: ExtensionContext) => {
    const cxMcp = await deps.findCxMcp();
    if (!cxMcp) {
      ctx.ui.notify("cx-mcp not found; workstyles live in contexture", "warning");
      return;
    }
    await openPicker(ctx, cxMcp, deps.mcpCall);
  };
  pi.registerShortcut(Key.ctrl("space"), {
    description: "Insert a workstyle directive (##workstyle.key)",
    handler: open,
  });
  pi.registerCommand("workstyle", {
    description: "Insert a workstyle directive (##workstyle.key) — search, pick",
    handler: async (_args, ctx) => open(ctx),
  });
}
