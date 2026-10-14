// contextual pi plugin — connects the context system to pi sessions.
//
// Speaks to contextual only via MCP: registers cx-mcp for the model's
// tools, injects the resolved default context (global + project tiers)
// into the system prompt on every turn, and adds /context commands.
//
// Spec: research/context/pi-plugin.md. Curation policy:
// research/context/curation.md.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { boxFrame, LineWindow, modalViewport, scrollIndicator, wrapPlain } from "./window.ts";
import { keyHint, viewerNav, type ViewerNav } from "./keymap.ts";
import {
  distillSkill,
  extractSkillRefs,
  getSkillsCache,
  getLoadedSkills,
  startDiscovery,
  ensureSkills,
  registerSkills,
  SkillsAutocomplete,
  skillBody,
  type SkillEntry,
  addLoadedSkill,
} from "./skills.ts";
import {
  ContexturePanel,
  docsToNodes,
  itemsToNodes,
  skillsToNodes,
  skillId,
  tiersToNodes,
  type ItemPatch,
  type PanelActions,
  type PanelNode,
  type PanelSkills,
} from "./contexture-panel.ts";
import { ItemsPaneController, run as runProc } from "./items-pane.ts";
import { messageText, registerReview, type ReviewDeps } from "./review.ts";
import {
  ensureWorkstyles,
  extractWorkstyleRefs,
  findEntry,
  peekWorkstyles,
  registerWorkstyles,
} from "./workstyles.ts";
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO = "https://github.com/fluid-notion-labs/contextual";
const INSTALL_CMD = `cargo install --git ${REPO}`;

/** Tools every cx-mcp must expose; a stale install warns instead of failing. */
const EXPECTED_TOOLS = [
  "resolve",
  "search",
  "add",
  "remove",
  "tags",
  "item_add",
  "item_ready",
  "item_pin",
  "item_gate",
  "plan_next",
];

/** Look up a binary on PATH (a lookup, not a long-running process). */
function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [bin], (err, stdout) => {
      const p = stdout.trim();
      resolve(err || !p ? null : p);
    });
  });
}

/**
 * One MCP request over a fresh stdio session: spawn cx-mcp, initialize,
 * send one request, resolve with its result. Needed because event and
 * command handlers get no executeTool — a session of our own is the only
 * way to speak MCP. Same server, same protocol, no logic duplication.
 */
function mcpRequest(cxMcp: string, method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(cxMcp, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const requestId = 2; // 1 is the initialize reply
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`cx-mcp ${method}: timed out`))),
      timeoutMs,
    );
    child.on("error", (e) => finish(() => reject(e)));
    child.stdout.on("data", (d) => {
      buf += d;
      // A chunk may carry several lines (initialize + call replies often
      // coalesce); drain the whole buffer, not just the first line.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== requestId) continue; // initialize reply or notification
        if (msg.error) {
          const m = typeof msg.error === "object" && msg.error !== null && "message" in msg.error
            ? String((msg.error as { message: unknown }).message)
            : JSON.stringify(msg.error);
          finish(() => reject(new Error(`cx-mcp ${method}: ${m}`)));
          return;
        }
        finish(() => resolve(msg.result));
        return;
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-plugin-context", version: "0.1.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: requestId, method, params });
  });
}

/** Tool text from a one-shot tools/call. */
async function mcpCall(cxMcp: string, tool: string, args: unknown): Promise<string> {
  const result = await mcpRequest(cxMcp, "tools/call", { name: tool, arguments: args });
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** Tool names from a one-shot tools/list. */
async function mcpTools(cxMcp: string): Promise<string[]> {
  const result = await mcpRequest(cxMcp, "tools/list", {});
  return ((result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
}

/** Framing block injected before the resolved atoms (curation.md §4). */
const PREAMBLE = `The context below is persistent memory: carried across sessions and machines, present in every session. Tagged knowledge is not shown here — when the user names technologies or domains, pull it via mcp__context__resolve with tags; discover hashtags with search. Facts that belong here apply to every session; task-specific learnings get tags instead. When saving: declarative facts, never imperatives to yourself; batch changes; consolidate rather than skip.`;

/**
 * Newest mtime across the bag's SQLite files (db + WAL): WAL mode means a
 * write may touch only the -wal file, and a checkpoint moves content back
 * into the db. -shm is deliberately excluded — readers update its wal-index,
 * so its mtime is not a write signal. This is the "bag changed on disk"
 * signal that lets the injected context pick up any writer — the model's
 * MCP add/remove, /context add, cx in a shell, another session, hub sync —
 * without needing hooks per writer. 0 when nothing exists yet.
 */
async function bagStamp(): Promise<number> {
  const db = process.env.CX_DB || path.join(os.homedir(), ".pi", "agent", "context.db");
  let newest = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      newest = Math.max(newest, (await stat(db + suffix)).mtimeMs);
    } catch {
      // missing file (e.g. no -wal) is normal; try the rest
    }
  }
  return newest;
}

interface TierNode {
  /** Section label within the tier, e.g. "git" or "jj-skills/jj-workflow". */
  label: string;
  text: string;
}

interface TierSection {
  label: string;
  nodes: TierNode[];
}

/**
 * Split rendered atoms into the three browsable tiers by scope header:
 * `# global/…` → global, `# skills/…` → skillbag, everything else → local
 * (the project tier, whatever its repo identity is). Each tier is a list
 * of named sections (the nodes) so the viewer can offer a second menu
 * level below the three top-level tabs.
 */
export function bucketTiers(rendered: string): TierSection[] {
  const tiers: Record<string, TierNode[]> = { global: [], local: [], skillbag: [] };
  let tier: keyof typeof tiers = "local";
  let current: TierNode | null = null;
  for (const line of rendered.split("\n")) {
    if (line.startsWith("# ")) {
      const header = line.slice(2);
      const first = header.split("/")[0].toLowerCase();
      tier = first === "global" ? "global" : first === "skills" ? "skillbag" : "local";
      // Section label keeps the full header so a flat document can show
      // where each section lives.
      const label = header;
      current = { label, text: "" };
      tiers[tier].push(current);
      continue;
    }
    if (!current) {
      current = { label: "(start)", text: "" };
      tiers[tier].push(current);
    }
    current.text += (current.text ? "\n" : "") + line;
  }
  for (const key of Object.keys(tiers) as (keyof typeof tiers)[]) {
    for (const n of tiers[key]) n.text = n.text.trim();
  }
  return [
    { label: "global", nodes: tiers.global },
    { label: "local", nodes: tiers.local },
    { label: "skillbag", nodes: tiers.skillbag },
  ];
}

/**
 * Read-only overlay viewer for /context: a tab bar with the top-level
 * tiers, and below it a flat document of that tier's sections, each
 * introduced by a horizontal divider with its title. Navigation: ←/→
 * switch tiers, ↑/↓ scroll line-wise, PgUp/PgDn page-wise,
 * ctrl+↓/ctrl+↑ jump to the next/previous section, esc/q closes.
 * Fixed-size body like the context panel (renderFixed + indicator slot).
 */
class TierViewer implements Component, Focusable {
  focused = false;
  private tab = 0;
  private window = new LineWindow(modalViewport());
  /** Active tier's document (titled dividers + wrapped content). */
  private docCache: { tab: number; width: number; lines: string[]; sectionStarts: number[] } | null = null;
  private lastStarts: number[] = [];
  private nav: ViewerNav;
  private kb: KeybindingsManager | undefined;

  constructor(
    private sections: TierSection[],
    private theme: Theme,
    private done: (result?: unknown) => void,
    /** Extra footer note, e.g. "2 skills". */
    private note?: string,
    /** Injected by ctx.ui.custom; optional for tests. */
    keybindings?: KeybindingsManager,
  ) {
    this.nav = viewerNav(keybindings);
    this.kb = keybindings;
  }

  invalidate(): void {}

  private switchTo(tab: number) {
    if (tab === this.tab || tab < 0 || tab >= this.sections.length) return;
    this.tab = tab;
    this.docCache = null;
    this.window.scrollToStart();
  }

  /** Build the flat document for the active tier. */
  private document(width: number): { lines: string[]; sectionStarts: number[] } {
    if (this.docCache && this.docCache.tab === this.tab && this.docCache.width === width) {
      return this.docCache;
    }
    const t = this.theme;
    const inner = Math.max(width - 2, 20);
    const tier = this.sections[this.tab];
    const lines: string[] = [];
    const sectionStarts: number[] = [];
    const divider = (title: string) => {
      const head = "── ";
      const tail = Math.max(0, inner - head.length - title.length - 1);
      return t.fg("borderMuted", head) + t.fg("accent", title) + t.fg("borderMuted", " " + "─".repeat(tail));
    };
    for (const node of tier?.nodes ?? []) {
      // the tab already names the tier — drop its prefix from titles
      const title = node.label.startsWith(`${tier.label}/`)
        ? node.label.slice(tier.label.length + 1)
        : node.label;
      sectionStarts.push(lines.length);
      lines.push(divider(title));
      for (const wrapped of wrapPlain(node.text || "(empty)", inner - 1)) {
        lines.push(` ${wrapped}`);
      }
      lines.push("");
    }
    if (lines.length === 0) lines.push(` ${t.fg("dim", "(empty)")}`);
    this.docCache = { tab: this.tab, width, lines, sectionStarts };
    this.lastStarts = sectionStarts;
    this.window.setLines(lines);
    return this.docCache;
  }

  /** Index of the section divider at or before the current scroll top. */
  private currentSection(starts: number[]): number {
    let idx = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= this.window.scrollTop) idx = i;
      else break;
    }
    return idx;
  }

  handleInput(data: string): void {
    // esc / q close; ctrl+w closes while the overlay owns input (same
    // toggle pattern as the context panel). The ctrl+b shortcut was
    // removed — it shadowed the built-in tui.editor.cursorLeft.
    if (this.nav.cancel(data) || matchesKey(data, "q")) {
      this.done();
    } else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      this.switchTo((this.tab + this.sections.length - 1) % this.sections.length);
    } else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.switchTo((this.tab + 1) % this.sections.length);
    } else if (matchesKey(data, "ctrl+down")) {
      const cur = this.currentSection(this.lastStarts);
      const next = this.lastStarts[Math.min(cur + 1, this.lastStarts.length - 1)];
      this.window.scrollTo(next);
    } else if (matchesKey(data, "ctrl+up")) {
      const cur = this.currentSection(this.lastStarts);
      const prev = this.lastStarts[Math.max(0, cur - 1)];
      this.window.scrollTo(prev);
    } else if (this.nav.up(data)) {
      this.window.scrollBy(-1);
    } else if (this.nav.down(data)) {
      this.window.scrollBy(1);
    } else if (this.nav.pageUp(data)) {
      this.window.scrollBy(-this.window.viewport + 2);
    } else if (this.nav.pageDown(data)) {
      this.window.scrollBy(this.window.viewport - 2);
    } else if (matchesKey(data, "home")) {
      this.window.scrollToStart();
    } else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.window.scrollToEnd();
    } else if (matchesKey(data, "j")) {
      this.window.scrollBy(1);
    } else if (matchesKey(data, "k")) {
      this.window.scrollBy(-1);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(width - 2, 20);
    const doc = this.document(width);
    const tabs = this.sections
      .map((s, i) => {
        const label = ` ${s.label} `;
        return i === this.tab ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
      })
      .join(t.fg("dim", "│"));
    const divider = t.fg("borderMuted", "─".repeat(inner));
    const hints =
      `←→ tier · ${keyHint(this.kb, "tui.select.up", "↑")}${keyHint(this.kb, "tui.select.down", "↓")} line ` +
      `· ${keyHint(this.kb, "tui.select.pageUp", "pgup")}/${keyHint(this.kb, "tui.select.pageDown", "pgdn")} page ` +
      `· ctrl+↓↑ section · ${keyHint(this.kb, "tui.select.cancel", "esc")}/q close`;
    const body = this.note ? `${hints} · ${this.note}` : hints;
    // Fixed-size: the body area renders exactly viewport rows, so the
    // box height doesn't jump as content changes. Indicator outside the
    // dim wrapper — nested fg() resets would strip the dim styling.
    const footer = scrollIndicator(this.window, t) + t.fg("dim", body);
    return boxFrame(width, [
      ...new Text(tabs, 1).render(inner),
      divider,
      ...this.window.renderFixed().map((line) => ` ${line}`),
      divider,
      ...new Text(footer, 1).render(inner),
    ], (s: string) => t.fg("borderMuted", s));
  }
}

// ---- Ctrl+W context panel: tabbed tasks / workspace sections ----
// Tree logic lives in items-tree.ts, the viewer component in
// workflow-viewer.ts (both unit-tested).

import {
  buildItemTree,
  flattenTree,
  type FlatRow,
  type RawItem,
} from "./items-tree.ts";
import {
  WorkflowViewer,
  buildItemBody,
  buildSectionBody,
  type WorkflowPage,
} from "./workflow-viewer.ts";

// ---- workspace sections for the context panel's section tabs ----

/** Fetch JSON from the cx CLI; throws with stderr's first line. */
async function cxJson(args: string[]): Promise<unknown> {
  const res = await runProc("cx", args);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim().split("\n")[0] || `cx ${args[0]} failed`);
  }
  return JSON.parse(res.stdout);
}

async function loadWorkflowSections(): Promise<TierSection[]> {
  const list = (await cxJson(["ws", "list", "--json"])) as {
    name: string;
    kind: string;
    title: string;
  }[];
  const sections: TierSection[] = [];
  for (const s of list) {
    let body = "(empty)";
    let title = s.title || s.name;
    try {
      const detail = (await cxJson(["ws", "show", s.name, "--json"])) as {
        title?: string;
        body?: string;
      };
      if (detail.body) body = renderChecklist(detail.body, s.kind);
      if (detail.title) title = detail.title;
    } catch {
      // body fetch failed; the list entry still shows
    }
    sections.push({
      label: s.name,
      nodes: [{ label: title, text: body }],
    });
  }
  return sections;
}

/** Checklist sections: `- [ ]`/`- [x]` → ☐/☑, indentation kept. */
function renderChecklist(md: string, kind: string | undefined): string {
  if (kind !== "checklist") return md;
  return md.replace(/^([ \t]*)- \[( |x|X)\] /gm, (_m, indent, mark) => {
    const glyph = mark.toLowerCase() === "x" ? "☑" : "☐";
    return indent + glyph + " ";
  });
}

/** The contexture panel's tree: tasks (work items), context (the
 * three tiers, plus loaded skills), documentation (ws sections
 * expanded into n-deep heading trees). Failed sources degrade to a
 * placeholder child so the pane still opens. */
function contextureTree(
  items: RawItem[] | null,
  tiers: TierSection[] | null,
  loadedSkills: SkillEntry[] | null,
  docs: TierSection[] | null,
): PanelNode[] {
  const placeholder = (id: string, label: string): PanelNode[] => [{ id, label }];
  const itemsNodes =
    items && items.length > 0 ? itemsToNodes(items) : placeholder("tasks-empty", "(no work items)");
  const tierNodes = tiers
    ? tiersToNodes(tiers)
    : placeholder("tiers-empty", "(nothing resolved)");
  const skillNodes =
    loadedSkills && loadedSkills.length > 0
      ? skillsToNodes(loadedSkills)
      : placeholder("skills-empty", "(none loaded — / to search and add)");
  const docsNodes = docs && docs.length > 0 ? docsToNodes(docs) : placeholder("docs-empty", "(no ws sections)");
  return [
    { id: "tasks", label: "tasks", expanded: true, children: itemsNodes },
    {
      id: "context",
      label: "context",
      expanded: true,
      children: [
        ...tierNodes,
        { id: "skills", label: "skills", children: skillNodes },
      ],
    },
    { id: "documentation", label: "documentation", children: docsNodes },
  ];
}

/** The panel's edit path: cx item edit for patches, cx item note for
 * note appends (separate command). */
function panelActions(): PanelActions {
  const cxEdit = async (id: string, patch: ItemPatch): Promise<void> => {
    if (patch.note) {
      const res = await runProc("cx", ["item", "note", id, patch.note], 10000);
      if (res.code !== 0) throw new Error(res.stderr.trim().split("\n")[0] || "cx item note failed");
      return;
    }
    const args = ["item", "edit", id];
    if (patch.status) args.push("--status", patch.status);
    if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
    if (patch.title) args.push("--title", patch.title);
    const res = await runProc("cx", args, 10000);
    if (res.code !== 0) throw new Error(res.stderr.trim().split("\n")[0] || "cx item edit failed");
  };
  return {
    editItem: cxEdit,
    reloadItems: async () => (await cxJson(["item", "list", "--json"])) as RawItem[],
    moveItem: async (id, rel, sibling) => {
      const res = await runProc("cx", ["item", "move", id, rel, sibling], 10000);
      if (res.code !== 0) throw new Error(res.stderr.trim().split("\n")[0] || "cx item move failed");
    },
  };
}

/** The panel's skills path: the catalog comes from the discovery cache
 * (warmed below), activation is the same session-loaded set the
 * injection uses. */
function panelSkills(): PanelSkills {
  return {
    catalog: () => getSkillsCache(),
    activated: () => getLoadedSkills(),
    activate: async (id) => {
      const entry = getSkillsCache().find((s) => skillId(s) === id);
      if (!entry) throw new Error(`skill ${id} not found in catalog`);
      addLoadedSkill(entry);
    },
  };
}

/** The contexture panel: alt+c / /panel. The unified pane replacing
 * the overlay family once it reaches parity (work item 2c31). */
async function openContexturePanel(
  ctx: ExtensionContext,
  loadTiers: () => Promise<TierSection[]>,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The contexture panel needs TUI mode", "warning");
    return;
  }
  const [itemsRes, tiersRes, skillsRes, docsRes] = await Promise.allSettled([
    cxJson(["item", "list", "--json"]) as Promise<RawItem[]>,
    loadTiers(),
    ensureSkills(),
    loadWorkflowSections(),
  ]);
  const unwrap = <T>(r: PromiseSettledResult<T>): T | null =>
    r.status === "fulfilled" ? r.value : null;
  const nodes = contextureTree(
    unwrap(itemsRes),
    unwrap(tiersRes),
    getLoadedSkills(), // only loaded skills in the tree; catalog is for search
    unwrap(docsRes),
  );
  await ctx.ui.custom(
    (_tui, theme, keybindings, done) =>
      new ContexturePanel(nodes, theme, done, keybindings, panelActions(), panelSkills()),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
    },
  );
}

async function openWorkflow(
  ctx: ExtensionContext,
  pane: ItemsPaneController,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The context panel needs TUI mode", "warning");
    return;
  }
  const paneWasActive = pane.active;
  pane.close();
  // Fetch both tab sources concurrently; either may be missing — the
  // viewer shows whichever tabs have content.
  const [itemsRes, sectionsRes] = await Promise.allSettled([
    cxJson(["item", "list", "--json"]) as Promise<RawItem[]>,
    loadWorkflowSections(),
  ]);
  // Flat tabs: one per thing. "todo" is the work-item tree; every ws
  // section gets its own tab (in cx ws list order) so navigation is
  // tab-cycle + scroll instead of scrolling through everything. Each
  // section tab still renders its titled divider — the tab shows the
  // short name, the divider carries the full title.
  const pages: WorkflowPage[] = [];
  if (itemsRes.status === "fulfilled") {
    const rows = flattenTree(buildItemTree(itemsRes.value));
    if (rows.length > 0) {
      pages.push({
        label: "tasks",
        note: `${rows.filter((r) => r.item.status !== "closed").length} open`,
        build: (inner, t) => buildItemBody(rows, inner, t),
      });
    }
  }
  if (sectionsRes.status === "fulfilled") {
    for (const section of sectionsRes.value) {
      pages.push({
        label: section.label,
        build: (inner, t) => buildSectionBody([section], inner, t),
      });
    }
  }
  if (pages.length === 0) {
    const err = (r: PromiseSettledResult<unknown>) =>
      r.status === "rejected" && r.reason instanceof Error ? r.reason.message : "";
    const problems = [err(itemsRes), err(sectionsRes)].filter(Boolean).join(" · ");
    ctx.ui.notify(
      problems
        ? `Workflow unavailable: ${problems}`
        : "Nothing to show — `cx item add` / `cx ws set` create content",
      problems ? "warning" : "info",
    );
    return;
  }
  try {
    await ctx.ui.custom(
      (_tui, theme, keybindings, done) => new WorkflowViewer(pages, theme, done, 0, keybindings),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
      },
    );
  } finally {
    if (paneWasActive) void pane.open(ctx);
  }
}

export default function (pi: ExtensionAPI) {
  const itemsPane = new ItemsPaneController();
  let cxMcpPath: string | null | undefined;
  /** Resolved default context for this session; injected every turn. */
  let resolvedBody: string | null = null;
  /** Newest bag-file mtime when resolvedBody was produced (see bagStamp). */
  let bagStampAtResolve = 0;
  /** The #skill autocomplete stacks once per process; sessions may start more than once. */
  let autocompleteInstalled = false;
  /** Skill references already distilled into the bag this session. */
  const addedToBag = new Set<string>();

  /** Distill any of the given skills not yet in the bag into the skillbag.
   * Bag atoms dedupe by text; already-imported skills are skipped by node check. */
  const ensureInBag = async (
    cxMcp: string,
    entries: SkillEntry[],
    ui: ExtensionContext["ui"],
  ) => {
    const pending = entries.filter((e) => !addedToBag.has(`${e.vendor}/${e.name.toLowerCase()}`));
    if (pending.length === 0) return;
    let inBag: string | null = null;
    try {
      inBag = await mcpCall(cxMcp, "resolve", { scope_prefix: "skills/" });
    } catch {
      // bag check failed; adding is still safe (dedupe by text)
    }
    for (const entry of pending) {
      const key = `${entry.vendor}/${entry.name.toLowerCase()}`;
      addedToBag.add(key);
      if (inBag?.includes(`# skills/${entry.vendor}/${entry.name}`)) continue;
      const atoms = distillSkill(entry);
      if (atoms.length === 0) continue;
      try {
        await mcpCall(cxMcp, "add", {
          operations: atoms.map((a) => ({
            action: "add",
            text: a.text,
            scope: `skills/${entry.vendor}`,
            node: entry.name,
            tags: a.tags,
          })),
        });
        ui.notify(`skillbag: added ${entry.name} (${atoms.length} atoms)`, "info");
      } catch (e) {
        addedToBag.delete(key);
        ui.notify(
          `skillbag add failed for ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    }
  };

  const findCxMcp = async (): Promise<string | null> => {
    // Repo-level dev override: a project can ship .pi/dev-cx-mcp (see
    // .pi/mcp.json in the contextual repo) and dev sessions then use the
    // locally built server for the plugin's own calls too, matching the
    // mcp.json override pi applies for the model's tools.
    const dev = path.join(process.cwd(), ".pi", "dev-cx-mcp");
    try {
      if (existsSync(dev) && statSync(dev).mode & 0o111) return dev;
    } catch {
      // unreadable/odd entry — fall through to PATH
    }
    if (cxMcpPath === undefined) cxMcpPath = await which("cx-mcp");
    return cxMcpPath;
  };

  /** Resolve once and cache; returns null when nothing usable came back.
   * Stamps the cache after resolving so our own resolve's bag writes
   * (a fresh cx-mcp pulls from the hub at startup) don't count as changes. */
  const resolveContext = async (cxMcp: string): Promise<string | null> => {
    const text = await mcpCall(cxMcp, "resolve", {});
    const body = text.trim();
    bagStampAtResolve = await bagStamp();
    if (!body || body === "(no matching context)") return null;
    return body;
  };

  /** Cached resolution, invalidated when the bag changed on disk since it
   * was resolved. Returns null when nothing is resolved for this project
   * (an empty resolution is not cached; the next turn re-resolves so newly
   * added atoms appear without a manual reload). */
  const cachedResolved = async (cxMcp: string): Promise<string | null> => {
    if (resolvedBody !== null && (await bagStamp()) > bagStampAtResolve) resolvedBody = null;
    if (resolvedBody === null) resolvedBody = await resolveContext(cxMcp);
    return resolvedBody;
  };

  // The tiered bag overlay (global / local / skills), opened by
  // /context. Shows ground truth: exactly what is injected
  // into the system prompt this session — the <context> block (global
  // + project tier defaults) and the <skills> block (session-loaded
  // skills). Returns when there is nothing to show.
  const openContextBag = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The context bag viewer needs TUI mode", "warning");
      return;
    }
    const cxMcp = await findCxMcp();
    if (!cxMcp) {
      ctx.ui.notify(`cx-mcp not found. Install with: ${INSTALL_CMD}`, "error");
      return;
    }
    try {
      resolvedBody = await cachedResolved(cxMcp);
    } catch {
      ctx.ui.notify("Could not resolve context", "error");
      return;
    }
    if (resolvedBody === null) {
      ctx.ui.notify("Nothing resolved for this project — /context add or tagged pulls", "info");
      return;
    }
    const sections = bucketTiers(resolvedBody).filter((s) => s.nodes.length > 0);
    const loaded = getLoadedSkills();
    if (loaded.length > 0) {
      sections.push({
        label: "skills (loaded)",
        nodes: loaded.map((s) => ({ label: s.name, text: skillBody(s.file) })),
      });
    }
    const note =
      loaded.length > 0
        ? `${loaded.length} skill${loaded.length === 1 ? "" : "s"}`
        : undefined;
    await ctx.ui.custom(
      (_tui, theme, keybindings, done) => new TierViewer(sections, theme, done, note, keybindings),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
      },
    );
  };

  // The model's MCP tools. Registered in the factory; pi connects the
  // server when the session starts. A user mcp.json entry named "context"
  // wins — that is the escape hatch for custom flags.
  pi.registerMcpServer("context", {
    command: "cx-mcp",
    env: Object.fromEntries(
      ["CX_DB", "CX_HUB_URL", "CX_TOKEN"]
        .map((k) => [k, process.env[k]])
        .filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });

  pi.on("session_start", async (_event, ctx) => {
    resolvedBody = null; // fresh session → resolve again
    startDiscovery();
    if (!autocompleteInstalled && ctx.mode === "tui") {
      autocompleteInstalled = true;
      ctx.ui.addAutocompleteProvider(
        (current) => new SkillsAutocomplete(current, () => {
          const cached = getSkillsCache();
          return cached.length > 0 ? cached : null;
        }),
      );
    }
    const cxMcp = await findCxMcp();
    if (!cxMcp) {
      if (!ctx.hasUI) {
        console.error(`contextual pi plugin: cx-mcp not found; install with: ${INSTALL_CMD}`);
        return;
      }
      if (!(await which("cargo"))) {
        ctx.ui.notify(
          `contextual is not installed and cargo is unavailable. Install manually from ${REPO}`,
          "warning",
        );
        return;
      }
      const ok = await ctx.ui.confirm(
        "contextual is not installed",
        `Install it now? Runs: ${INSTALL_CMD} (provides cx and cx-mcp).`,
      );
      if (!ok) return;
      ctx.ui.notify("Installing contextual in the background…", "info");
      // Detached so the install survives the session; notified on completion.
      const child = spawn("cargo", ["install", "--git", REPO], {
        stdio: "ignore",
        detached: true,
      });
      child.on("exit", (code) => {
        ctx.ui.notify(
          code === 0
            ? "contextual installed — restart pi to connect it"
            : `contextual install failed (exit ${code})`,
          code === 0 ? "info" : "error",
        );
      });
      child.unref();
      return;
    }
    // Stale-install check: tools/list must show the full surface.
    try {
      const tools = await mcpTools(cxMcp);
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
      if (missing.length > 0) {
        ctx.ui.notify(
          `cx-mcp is missing tools: ${missing.join(", ")}. Update with: ${INSTALL_CMD}`,
          "warning",
        );
      }
    } catch {
      // tools/list failure shouldn't block the session; injection degrades anyway.
    }
    // The pane's custom interaction stays pending by design, so nothing
    // may await it. It opens fire-and-forget.
    if (ctx.mode === "tui") {
      void itemsPane.start(ctx);
    }
  });

  pi.on("agent_end", async () => {
    await itemsPane.refresh();
  });

  pi.on("session_shutdown", () => {
    itemsPane.shutdown();
  });

  // ctrl+q → toggle the full task panel; the 1-column strip on the
  // right edge is always visible underneath. CX_TASKS_STRIP=0 removes
  // the strip and restores the old panel-only behavior.
  pi.registerShortcut(Key.ctrl("q"), {
    description: "Toggle the task panel (strip stays)",
    handler: (ctx) => itemsPane.toggle(ctx),
  });

  pi.registerCommand("tasks", {
    description: "Toggle the task panel (same as ctrl+q); 'refresh' refetches now",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "off") {
        itemsPane.close();
      } else if (sub === "refresh") {
        await itemsPane.refresh();
      } else {
        await itemsPane.toggle(ctx);
      }
    },
  });

  pi.registerCommand("items", {
    description: "Toggle the tasks sidebar (alias for /tasks)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "off") {
        itemsPane.close();
      } else if (sub === "refresh") {
        await itemsPane.refresh();
      } else {
        await itemsPane.toggle(ctx);
      }
    },
  });

  pi.registerCommand("workflow", {
    description: "Open the context panel (same as Ctrl+W)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await openWorkflow(ctx, itemsPane);
    },
  });

  // Ctrl+W → the context panel (tasks + workspace sections, one tab
  // each). First-class pi shortcut instead of an editor subclass:
  // matched before app keybindings and listed under Extensions in
  // /hotkeys. It shadows `deleteWordBackward` (still on alt+backspace);
  // /workflow is the discoverable path for the same action. Toggles:
  // while the panel is open the overlay owns input and closes on the
  // same ctrl+w (WorkflowViewer.handleInput); esc keeps working too.
  pi.registerShortcut(Key.ctrl("w"), {
    description: "Toggle the context panel (tasks / sections)",
    handler: (ctx) => openWorkflow(ctx, itemsPane),
  });

  // ---- contexture panel (alt+c) — the unified pane ----
  // Fresh build (design: work item 2c31): one left-tree pane with
  // tasks / context / documentation. The existing overlays above are
  // untouched until this reaches parity (P5 cutover); /panel is the
  // discoverable path.
  /** Tiers for the panel's context subtree: resolved via the same
   * cached resolution the injection uses. Empty on failure — the pane
   * shows a placeholder. */
  const loadTierSections = async (): Promise<TierSection[]> => {
    const cxMcp = await findCxMcp();
    if (!cxMcp) return [];
    const body = await cachedResolved(cxMcp);
    if (!body) return [];
    return bucketTiers(body).filter((s) => s.nodes.length > 0);
  };
  pi.registerShortcut(Key.alt("c"), {
    description: "Toggle the contexture panel (tasks / context / documentation)",
    handler: (ctx) => openContexturePanel(ctx, loadTierSections),
  });

  pi.registerCommand("panel", {
    description: "Toggle the contexture panel (same as alt+c)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await openContexturePanel(ctx, loadTierSections);
    },
  });

  // Work guard: claim / park / release the repo so later sessions see
  // in-flight work via the injected context instead of clobbering it.
  for (const [cmd, action] of [
    ["claim", "claim"],
    ["park", "park"],
    ["release", "release"],
  ] as const) {
    pi.registerCommand(cmd, {
      description:
        cmd === "claim"
          ? "Claim this repo for active work (guard for future sessions)"
          : cmd === "park"
            ? "Park the claim (suspended; guard stays up — verify freshness before obeying)"
            : "Release the claim (done, or verified stale)",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("The guard needs TUI mode", "warning");
          return;
        }
        const cxMcp = await findCxMcp();
        if (!cxMcp) {
          ctx.ui.notify("No cx-mcp available — run `cx " + cmd + "` in a shell", "warning");
          return;
        }
        try {
          const out = await mcpCall(cxMcp, "park_claim", { action, note: args.trim() });
          ctx.ui.notify(out.replace(/\n/g, " — "), "info");
          await itemsPane.refresh();
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "warning");
        }
      },
    });
  }

  pi.on("before_agent_start", async (event, ctx) => {
    // Workstyle directives enter a turn via ##workstyle.key codes in the
    // prompt; the parenthetical (extra info for this repo/message) stays in
    // the prompt, the directive text is injected as a section.
    const codeRefs = extractWorkstyleRefs(event.prompt);
    if (codeRefs.length > 0) {
      const cxMcpForCodes = await findCxMcp();
      if (cxMcpForCodes) {
        try {
          const entries = await ensureWorkstyles(cxMcpForCodes, mcpCall);
          const parts: string[] = [];
          const missing: string[] = [];
          for (const ref of codeRefs) {
            const entry = findEntry(entries, ref);
            if (entry) {
              parts.push(`## ${entry.workstyle}.${entry.key}\n\n${entry.text}`);
            } else if (peekWorkstyles().length > 0) {
              missing.push(`##${ref.workstyle}.${ref.key}`);
            }
          }
          if (parts.length > 0) {
            event.systemPromptOptions.sections["workstyles"] =
              `<workstyles>\nDirectives referenced as ##workstyle.key in this message; their full instructions follow. Anything in parentheses after a code is extra info for this repo/message, not part of the directive.\n\n${parts.join("\n\n")}\n</workstyles>`;
          }
          if (missing.length > 0) {
            ctx.ui.notify(`Unknown workstyle code${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, "warning");
          }
        } catch {
          // resolve failed → leave codes visible; the model can use MCP search
        }
      }
    }
    // Skills enter a turn two ways: loaded via enter in the picker detail view
    // (every turn of the session) and referenced as #skill:<name> in the
    // prompt (that turn). Both are injected; both distill into the skillbag.
    const refs = extractSkillRefs(event.prompt);
    const cxMcp = await findCxMcp();
    const loaded = getLoadedSkills();
    if (!cxMcp && refs.length === 0 && loaded.length === 0) {
      return; // offline degradation: no server, AGENTS.md fallback remains
    }
    if (refs.length > 0 || loaded.length > 0) {
      const skills = await ensureSkills();
      const entries = new Map<string, SkillEntry>();
      for (const name of refs) {
        const entry = skills.find((s) => s.name.toLowerCase() === name);
        if (entry) entries.set(`${entry.vendor}/${entry.name.toLowerCase()}`, entry);
      }
      for (const entry of loaded) {
        entries.set(`${entry.vendor}/${entry.name.toLowerCase()}`, entry);
      }
      if (entries.size > 0) {
        const parts = [...entries.values()].map(
          (entry) => `## ${entry.name} (${entry.vendor})\n\n${skillBody(entry.file)}`,
        );
        event.systemPromptOptions.sections["skills"] =
          `<skills>\nThese skills are loaded for this session or were referenced with #skill:<name>; their full instructions are included here.\n\n${parts.join("\n\n")}\n</skills>`;
      }
      if (cxMcp && entries.size > 0) {
        await ensureInBag(cxMcp, [...entries.values()], ctx.ui);
      }
    }
    if (cxMcp) {
      try {
        resolvedBody = await cachedResolved(cxMcp);
        if (resolvedBody !== null) {
          // A fresh normalized copy arrives every turn; the returned options
          // become the turn's system prompt, so the section must be set
          // every turn or it is dropped from the prompt diff.
          event.systemPromptOptions.sections["context"] =
            `<context>\n${PREAMBLE}\n\n${resolvedBody}\n</context>`;
        }
      } catch (e) {
        resolvedBody = null; // resolve failed → retry next turn
        // Degrade silently: pi still works without injection.
      }
    }
  });

  pi.registerCommand("context", {
    description:
      "Show exactly what is sent to the model; 'reload' re-resolves; 'add <text>' saves an atom; 'local|global <text>' condenses via the model then saves to that tier",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cxMcp = await findCxMcp();
      if (!cxMcp) {
        ctx.ui.notify(`cx-mcp not found. Install with: ${INSTALL_CMD}`, "error");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/);
      const argText = rest.join(" ").trim();

      if (sub === "reload") {
        try {
          resolvedBody = await resolveContext(cxMcp);
          ctx.ui.notify(
            resolvedBody === null
              ? "Context reloaded: nothing resolved for this project"
              : `Context reloaded (${resolvedBody.length} chars) — applies to the next turn`,
            "info",
          );
        } catch (e) {
          ctx.ui.notify(`Reload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      // local/global: the model condenses the raw note into one terse
      // atom, the confirm dialog shows the query and the rewrite, then it
      // is saved to the chosen tier (local = this repo's project scope,
      // global = scope "global").
      if (sub === "local" || sub === "global") {
        const tier = sub as "local" | "global";
        let note = argText;
        if (!note) {
          note =
            (await ctx.ui.input(
              `Add to ${tier}`,
              "the raw note — it will be condensed into one atom",
            )) ?? "";
        }
        if (!note.trim()) return;

        const model = ctx.model;
        if (!model) {
          ctx.ui.notify("No model available to condense the note", "error");
          return;
        }
        const query =
          `Rewrite the note below as a single terse, durable instruction atom for a context bag. Rules:\n` +
          `- one sentence, plain declarative, addressed to a coding agent\n` +
          `- keep concrete details (names, commands, paths); drop filler\n` +
          `- no markdown, no quotes, no hashtags, under 25 words\n` +
          `- reply with only the atom text, nothing else\n\n` +
          `Note:\n${note.trim()}`;
        let polished = "";
        try {
          const result = await ctx.modelRegistry.complete(
            model,
            { messages: [{ role: "user", content: query, timestamp: Date.now() }] },
            { maxTokens: 200 },
          );
          polished = messageText(result).trim();
        } catch (e) {
          ctx.ui.notify(`Condense failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
        if (!polished) {
          ctx.ui.notify("The model returned nothing — nothing saved", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(`Add to ${tier}`, `"${polished}"\n\nquery:\n${query}`);
        if (!confirmed) return;
        try {
          const result = await mcpCall(cxMcp, "add", {
            text: polished,
            scope: tier === "global" ? "global" : undefined,
          });
          ctx.ui.notify(`Context: ${result}`, "info");
        } catch (e) {
          ctx.ui.notify(`Add failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (sub === "add") {
        const text = argText || (await ctx.ui.input("Add to context", "the terse assertion"));
        if (!text?.trim()) return;
        const tags = await ctx.ui.input("Tags (optional)", "comma-separated hashtags");
        const confirmed = await ctx.ui.confirm(
          "Add to context",
          `"${text.trim()}"${tags?.trim() ? `\ntags: ${tags.trim()}` : ""}`,
        );
        if (!confirmed) return;
        try {
          const result = await mcpCall(cxMcp, "add", {
            text: text.trim(),
            tags: tags?.trim() || undefined,
          });
          ctx.ui.notify(`Context: ${result}`, "info");
        } catch (e) {
          ctx.ui.notify(`Add failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (sub !== undefined && sub !== "") {
        ctx.ui.notify("Usage: /context [reload|add <text>]", "warning");
        return;
      }

      // Plain /context: show what the model is injected. In TUI mode the
      // tiered overlay; elsewhere a notification.
      // Uses the same cache as injection, so this shows exactly what the
      // model gets.
      if (ctx.mode === "tui") {
        await openContextBag(ctx);
        return;
      }
      try {
        resolvedBody = await cachedResolved(cxMcp);
      } catch {
        ctx.ui.notify("Could not resolve context", "error");
        return;
      }
      if (resolvedBody === null) {
        ctx.ui.notify("Nothing resolved for this project — /context add or tagged pulls", "info");
        return;
      }
      const full = `<context>\n${PREAMBLE}\n\n${resolvedBody}\n</context>`;
      ctx.ui.notify(full.length > 400 ? `${full.slice(0, 400)}…` : full, "info");
    },
  });

  registerSkills(pi);
  registerWorkstyles(pi, { findCxMcp, mcpCall });
  registerReview(pi, { findCxMcp, mcpCall } satisfies ReviewDeps);
}
