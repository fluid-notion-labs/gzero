// contexture-panel.ts — the unified left-tree pane (alt+c).
//
// One pane, fresh build (design: work item 2c31). A vertical tree
// along the left with three top-levels — tasks | context |
// documentation — and a content area to the right. There is no header
// strip along the top: the title and the section headings live in the
// tree column itself, so navigation is one cursor over one column.
//
// The existing overlays (ctrl+w panel, ctrl+b viewer, alt-s picker)
// stay untouched until this reaches parity; remapping happens in the
// P5 cutover only.
//
// P0 skeleton: tree interaction (cursor, expand/collapse, top-level
// jumps) over a static tree. Data wiring (tasks, tiers, ws sections)
// lands in P1/P2.

import { readFileSync } from "node:fs";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxFrame, LineWindow, scrollIndicator, wrapPlain } from "./window.ts";
import { keyHint, viewerNav, type ViewerNav } from "./keymap.ts";
import { buildItemTree, flattenTree as flattenItems, type FlatRow, type RawItem } from "./items-tree.ts";

/** A node in the panel tree. Top-levels are the three sections. */
export interface PanelNode {
  /** Stable identity (jump-to-result, tests). */
  id: string;
  label: string;
  expanded?: boolean;
  children?: PanelNode[];
  /** Content-area lines for this node at a given width. Absent → placeholder. */
  detail?: (width: number, theme: Theme) => string[];
  /** Extra text for fuzzy search beyond the label (descriptions, atom bodies). */
  searchText?: string;
  /** Set on task nodes: enables the edit actions (P4). */
  item?: RawItem;
}

/** A single edit to apply to a work item (cx item edit / item note). */
export interface ItemPatch {
  status?: string;
  priority?: number;
  title?: string;
  note?: string;
}

/** How the panel mutates work items; wired to the cx CLI by the caller. */
export interface PanelActions {
  editItem(id: string, patch: ItemPatch): Promise<void>;
  reloadItems(): Promise<RawItem[]>;
}

/** One visible row: a node plus its depth in the tree. */
export interface PanelRow {
  node: PanelNode;
  depth: number;
}

/** Visible rows: children only under expanded parents. */
export function flattenTree(nodes: PanelNode[], depth = 0, out: PanelRow[] = []): PanelRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children && node.expanded) flattenTree(node.children, depth + 1, out);
  }
  return out;
}

/** Body-row count for the full-height pane: terminal rows minus chrome. */
export function panelBodyRows(): number {
  return Math.max(6, (process.stdout.rows ?? 40) - 6);
}

/**
 * Fuzzy score, higher is better; null when the query doesn't match.
 * Substring beats subsequence, earlier matches beat later ones, and
 * consecutive (streaked) characters score higher — enough ranking for
 * a panel, not an IDE.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return Math.min(9999, 100 - idx);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak;
    ti = found + 1;
  }
  return Math.min(9999, score);
}

/** A fuzzy-search hit. Category ordering: tasks (0) > skills (1) > terms (2). */
interface SearchHit {
  node: PanelNode;
  category: number;
  score: number;
}
/** Higher is better. */
function hitRank(hit: SearchHit): number {
  return (2 - hit.category) * 10000 + hit.score;
}

/** Status filter matching: `active` covers open + in_progress. */
function matchesStatus(status: string, wanted: string[]): boolean {
  if (wanted.includes("active")) return status === "open" || status === "in_progress";
  return wanted.includes(status);
}

// ---- P1 data wiring: tasks, tiers, skills, documentation ----
// Structural types: the real sources live in index.ts (TierSection /
// bucketTiers) and skills.ts (SkillEntry); the panel builders accept
// their shapes without importing them, keeping this module strip-mode
// testable.

interface TierLike {
  label: string;
  nodes: { label: string; text: string }[];
}

interface SkillLike {
  name: string;
  description: string;
  vendor: string;
  file: string;
}

const STATUS_ICON: Record<string, string> = {
  open: "○",
  in_progress: "●",
  closed: "✓",
};

/** Work items → PanelNodes, preserving the child_of tree (DFS order). */
export function itemsToNodes(items: RawItem[]): PanelNode[] {
  const roots: PanelNode[] = [];
  const parentLists: PanelNode[][] = [];
  for (const row of flattenItems(buildItemTree(items))) {
    const list = row.depth === 0 ? roots : parentLists[row.depth - 1];
    if (!list) continue; // cycle guard: buildItemTree already breaks cycles
    const node: PanelNode = {
      id: row.item.id,
      label: itemLabel(row),
      children: [],
      expanded: true,
      detail: itemDetail(row),
      searchText: row.item.title,
      item: row.item,
    };
    list.push(node);
    parentLists[row.depth] = node.children!;
  }
  return roots;
}

function itemLabel(row: FlatRow): string {
  const icon = STATUS_ICON[row.item.status] ?? "○";
  return `${icon} ${row.item.title}`;
}

function itemDetail(row: FlatRow) {
  return (width: number, theme: Theme): string[] => {
    const i = row.item;
    const blocked = (i.blocked_by ?? []).length > 0 ? ` · blocked by ${i.blocked_by.join(", ")}` : "";
    const lines = [
      theme.fg("accent", theme.bold(i.title ?? "(untitled)")),
      theme.fg("dim", `${i.status ?? "open"} · p${i.priority ?? 0} · ${i.id}${i.assignee ? ` · ${i.assignee}` : ""}${blocked}`),
    ];
    // Notes are string values in storage today, but older items (and
    // the RawItem type) use { text } objects — accept both.
    for (const note of Object.values(i.notes ?? {})) {
      const text = typeof note === "string" ? note : note?.text;
      if (typeof text === "string" && text.length > 0) {
        lines.push("");
        lines.push(text);
      }
    }
    return lines.map((l) => truncateToWidth(l, width));
  };
}

/** Context tiers (global / local / skills-of-the-bag) → PanelNodes.
 * Each tier's sections become children; a section's text is its detail. */
export function tiersToNodes(tiers: TierLike[]): PanelNode[] {
  return tiers.map((tier) => ({
    id: `tier-${tier.label}`,
    label: tier.label,
    children: tier.nodes.map((node) => ({
      id: `tier-${tier.label}/${node.label}`,
      label: node.label,
      detail: textDetail(node.text),
      // The full atom text is searchable: terms match on content.
      searchText: node.text,
    })),
  }));
}

/** Vendored skills → PanelNodes (flat list; the tier node holds it). */
export function skillsToNodes(entries: SkillLike[]): PanelNode[] {
  return entries.map((entry) => ({
    id: `skill-${entry.vendor}/${entry.name.toLowerCase()}`,
    label: entry.name,
    searchText: `${entry.description} ${entry.vendor}`,
    detail: (width: number, theme: Theme): string[] => {
      const lines = [
        theme.fg("accent", theme.bold(entry.name)),
        theme.fg("dim", `${entry.vendor} · ${entry.file}`),
        "",
        ...wrapPlain(skillBodyFromFile(entry.file), width),
      ];
      return lines.map((l) => truncateToWidth(l, width));
    },
  }));
}

/** Body below the frontmatter of a SKILL.md. */
function skillBodyFromFile(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.replace(/^---\n.*?\n---(?:\n|$)/s, "").trim() || text;
  } catch {
    return "(unreadable)";
  }
}

/** Wrap once per width; long section bodies otherwise re-wrap each render. */
function textDetail(text: string) {
  let cache: { width: number; lines: string[] } | null = null;
  return (width: number, theme: Theme): string[] => {
    if (!cache || cache.width !== width) {
      cache = { width, lines: wrapPlain(text || "(empty)", width) };
    }
    return cache.lines;
  };
}

/**
 * Markdown → an n-deep heading tree: ATX headings become nodes nested
 * by level, text between headings attaches to the nearest preceding
 * heading as its detail; text before the first heading becomes an
 * "(intro)" node. Headings deeper than the stack (e.g. `####` after
 * `##`) nest under the closest shallower heading.
 */
interface HNode {
  level: number;
  title: string;
  texts: string[];
  children: HNode[];
}

export function headingTree(md: string): PanelNode[] {
  const root: HNode = { level: 0, title: "", texts: [], children: [] };
  const stack: HNode[] = [root];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    stack[stack.length - 1].texts.push(pending.join("\n"));
    pending = [];
  };
  for (const line of md.split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      flush();
      const level = match[1].length;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node: HNode = { level, title: match[2].trim(), texts: [], children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      pending.push(line);
    }
  }
  flush();
  const toPanel = (n: HNode): PanelNode => ({
    id: `h${n.level}-${n.title.toLowerCase().replace(/\s+/g, "-")}`,
    label: n.title,
    children: n.children.map(toPanel),
    detail: textDetail(n.texts.join("\n\n")),
  });
  const out: PanelNode[] = [];
  if (root.texts.length > 0) {
    out.push({ id: "doc-intro", label: "(intro)", detail: textDetail(root.texts.join("\n\n")) });
  }
  out.push(...root.children.map(toPanel));
  return out;
}

/** Documentation sections → PanelNodes with heading-tree children.
 * A section without ATX headings gets a single (body) leaf. */
export function docsToNodes(sections: TierLike[]): PanelNode[] {
  return sections.map((section) => {
    const body = section.nodes[0]?.text ?? "";
    const hasHeadings = /^#{1,6}\s+/m.test(body);
    return {
      id: `doc-${section.label}`,
      label: section.label,
      children: hasHeadings
        ? headingTree(body)
        : [{ id: `doc-${section.label}-body`, label: "(body)", detail: textDetail(body) }],
    };
  });
}

export class ContexturePanel implements Component, Focusable {
  focused = false;
  private nodes: PanelNode[];
  private theme: Theme;
  private done: (result?: unknown) => void;
  private rows: PanelRow[];
  private cursor = 0;
  private treeWin: LineWindow;
  private contentWin: LineWindow;
  private nav: ViewerNav;
  private kb: KeybindingsManager | undefined;
  // Search state (P3): one query across tasks > skills > terms.
  private mode: "tree" | "search" | "actions" | "note" = "tree";
  private query = "";
  private hits: SearchHit[] = [];
  private sel = 0;
  private corpus: { node: PanelNode; category: number; text: string; root: string }[] = [];
  // Edit state (P4): action menu over a task, note input, scope.
  private actions: PanelActions | undefined;
  private actionSel = 0;
  private noteBuf = "";
  /** 0 = all sections; 1..N = the (N-1)th top-level is the query scope. */
  private scope = 0;
  private error: string | null = null;

  constructor(
    nodes: PanelNode[],
    theme: Theme,
    done: (result?: unknown) => void,
    /** Injected by ctx.ui.custom; optional for tests. */
    keybindings?: KeybindingsManager,
    actions?: PanelActions,
  ) {
    this.nodes = nodes;
    this.theme = theme;
    this.done = done;
    this.actions = actions;
    this.rows = flattenTree(nodes);
    const viewport = panelBodyRows();
    this.treeWin = new LineWindow(viewport);
    this.contentWin = new LineWindow(viewport);
    this.kb = keybindings;
    this.nav = viewerNav(keybindings);
    this.buildCorpus();
  }

  /** Searchable entries: tasks, skills, terms — documentation is browsable,
   * not searchable (the three sources in the design). Category order is
   * the ranking backbone: task hits always rank above skill hits, etc. */
  private buildCorpus(): void {
    this.corpus = [];
    const walk = (nodes: PanelNode[], root: string | null): void => {
      for (const node of nodes) {
        const r = root ?? node.id;
        const category = r === "tasks" ? 0 : node.id.startsWith("skill-") ? 1 : r === "context" ? 2 : 3;
        if (category <= 2) {
          const text = `${node.label} ${node.searchText ?? ""}`.trim();
          if (text) this.corpus.push({ node, category, text, root: r });
        }
        if (node.children) walk(node.children, r);
      }
    };
    walk(this.nodes, null);
  }

  invalidate(): void {}

  get selected(): PanelRow {
    return this.rows[this.cursor];
  }

  private moveCursor(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    this.followCursor();
  }

  /** Keep the selected row inside the tree window. */
  private followCursor(): void {
    const top = this.treeWin.scrollTop;
    if (this.cursor < top) this.treeWin.scrollTo(this.cursor);
    else if (this.cursor >= top + this.treeWin.viewport) {
      this.treeWin.scrollTo(this.cursor - this.treeWin.viewport + 1);
    }
  }

  /** ctrl+up / ctrl+down: jump to the previous/next top-level section. */
  private jumpTopLevel(direction: 1 | -1): void {
    let i = this.cursor + direction;
    while (i >= 0 && i < this.rows.length) {
      if (this.rows[i].depth === 0) {
        this.cursor = i;
        this.followCursor();
        return;
      }
      i += direction;
    }
  }

  private toggleExpanded(): void {
    const node = this.selected.node;
    if (!node.children || node.children.length === 0) return;
    node.expanded = !node.expanded;
    this.rows = flattenTree(this.nodes);
    // Collapsing can leave the cursor past the end.
    if (this.cursor >= this.rows.length) this.cursor = this.rows.length - 1;
    this.followCursor();
  }

  handleInput(data: string): void {
    if (this.mode === "search") {
      this.handleSearchInput(data);
      return;
    }
    if (this.mode === "actions") {
      this.handleActionInput(data);
      return;
    }
    if (this.mode === "note") {
      this.handleNoteInput(data);
      return;
    }
    // alt+c toggles — the overlay owns input while active, so the
    // extension shortcut can't see it (same pattern as ctrl+w/ctrl+b).
    if (this.nav.cancel(data) || matchesKey(data, "q") || matchesKey(data, "alt+c")) {
      this.done();
    } else if (matchesKey(data, "shift+down")) {
      this.moveScope(1);
    } else if (matchesKey(data, "shift+up")) {
      this.moveScope(-1);
    } else if (this.nav.up(data) || matchesKey(data, "k")) {
      this.moveCursor(-1);
    } else if (this.nav.down(data) || matchesKey(data, "j")) {
      this.moveCursor(1);
    } else if (matchesKey(data, "ctrl+up")) {
      this.jumpTopLevel(-1);
    } else if (matchesKey(data, "ctrl+down")) {
      this.jumpTopLevel(1);
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      this.toggleExpanded();
    } else if (matchesKey(data, "left")) {
      const node = this.selected.node;
      if (node.children && node.children.length > 0 && node.expanded) this.toggleExpanded();
    } else if (data === "/") {
      this.enterSearch();
    } else if (data === "e" && this.selected.node.item && this.actions) {
      this.mode = "actions";
      this.actionSel = 0;
      this.error = null;
    }
  }

  // ---- edit actions (P4) ----

  /** The task node the action menu is open for. */
  private actionNode(): PanelNode | null {
    const node = this.selected.node;
    return node.item ? node : null;
  }

  private handleActionInput(data: string): void {
    const menu = this.buildActions();
    if (this.nav.cancel(data) || matchesKey(data, "q")) {
      this.mode = "tree";
      return;
    }
    if (this.nav.up(data) || matchesKey(data, "k")) {
      this.actionSel = Math.max(0, this.actionSel - 1);
      return;
    }
    if (this.nav.down(data) || matchesKey(data, "j")) {
      this.actionSel = Math.min(menu.length - 1, this.actionSel + 1);
      return;
    }
    if (this.nav.confirm(data)) {
      const act = menu[this.actionSel];
      if (!act) return;
      if (act.note) {
        this.mode = "note";
        this.noteBuf = "";
      } else if (act.patch) {
        void this.runAction(act.patch);
      }
    }
  }

  private handleNoteInput(data: string): void {
    if (this.nav.cancel(data)) {
      this.mode = "actions";
      return;
    }
    if (this.nav.confirm(data)) {
      const text = this.noteBuf.trim();
      if (text) void this.runAction({ note: text });
      return;
    }
    if (/^[\x7f\b]+$/.test(data)) {
      this.noteBuf = this.noteBuf.slice(0, -data.length);
      return;
    }
    if (/^[ -~]+$/.test(data)) this.noteBuf += data;
  }

  /** Menu items for the selected task, based on its current status. */
  private buildActions(): { label: string; patch?: ItemPatch; note?: boolean }[] {
    const node = this.actionNode();
    if (!node) return [];
    const item = node.item!;
    const acts: { label: string; patch?: ItemPatch; note?: boolean }[] = [];
    if (item.status !== "in_progress") {
      acts.push({ label: `status → in_progress`, patch: { status: "in_progress" } });
    }
    if (item.status !== "open") {
      acts.push({ label: `status → open`, patch: { status: "open" } });
    }
    if (item.status !== "closed") {
      acts.push({ label: `status → closed`, patch: { status: "closed" } });
    }
    acts.push({ label: `priority ${item.priority} → ${item.priority + 1}`, patch: { priority: item.priority + 1 } });
    acts.push({ label: `priority ${item.priority} → ${Math.max(0, item.priority - 1)}`, patch: { priority: Math.max(0, item.priority - 1) } });
    acts.push({ label: "add note…", note: true });
    return acts;
  }

  private async runAction(patch: ItemPatch): Promise<void>
  {
    const node = this.actionNode();
    if (!node || !this.actions) return;
    try {
      await this.actions.editItem(node.id, patch);
      await this.refreshItems();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.mode = "tree";
  }

  /** Rebuild the tasks subtree after an edit; keeps the cursor on the
   * same item when it still exists. */
  private async refreshItems(): Promise<void> {
    if (!this.actions) return;
    const items = await this.actions.reloadItems();
    const tasksNode = this.nodes.find((n) => n.id === "tasks");
    if (!tasksNode) return;
    const expanded = tasksNode.expanded;
    tasksNode.children = itemsToNodes(items);
    tasksNode.expanded = expanded;
    const curId = this.selected.node.id;
    this.rows = flattenTree(this.nodes);
    const idx = this.rows.findIndex((r) => r.node.id === curId);
    this.cursor = idx >= 0 ? idx : Math.min(this.cursor, this.rows.length - 1);
    this.buildCorpus();
    this.followCursor();
  }

  // ---- query scope (P4): shift+up/down selects a section for search ----

  private moveScope(delta: number): void {
    const count = this.nodes.length + 1; // +1 for "all"
    this.scope = (this.scope + delta + count) % count;
  }

  /** Id of the scoped top-level section, or null when scope is "all". */
  private scopedRoot(): string | null {
    return this.scope === 0 ? null : this.nodes[this.scope - 1]?.id ?? null;
  }

  // ---- fuzzy search (P3) ----

  private enterSearch(): void {
    this.mode = "search";
    this.query = "";
    this.hits = [];
    this.sel = 0;
    this.contentWin.scrollToStart();
  }

  private handleSearchInput(data: string): void {
    if (this.nav.cancel(data)) {
      this.mode = "tree";
      return;
    }
    if (this.nav.up(data)) {
      this.sel = Math.max(0, this.sel - 1);
      return;
    }
    if (this.nav.down(data)) {
      this.sel = Math.min(Math.max(0, this.hits.length - 1), this.sel + 1);
      return;
    }
    if (this.nav.confirm(data)) {
      this.jumpToHit();
      return;
    }
    // Backspace, including repeats from a held key: erase one char each.
    if (/^[\x7f\b]+$/.test(data)) {
      this.query = this.query.slice(0, -data.length);
      this.runSearch();
      return;
    }
    // Printable input (including pasted multi-char) extends the query.
    if (/^[ -~]+$/.test(data)) {
      this.query += data;
      this.runSearch();
    }
  }

  private runSearch(): void {
    const parsed = this.parseQuery();
    this.contentWin.scrollToStart();
    this.sel = 0;
    if (!parsed.text && !parsed.statuses && parsed.priority === null) {
      this.hits = [];
      return;
    }
    const root = this.scopedRoot();
    const scored: SearchHit[] = [];
    for (const entry of this.corpus) {
      // Scope restricts to one top-level section's subtree.
      if (root && entry.root !== root) continue;
      // Query tokens (is:open, is:active, p<N>) restrict to matching tasks.
      if (parsed.statuses || parsed.priority !== null) {
        const item = entry.node.item;
        if (!item) continue;
        if (parsed.statuses && !matchesStatus(item.status, parsed.statuses)) continue;
        if (parsed.priority !== null && item.priority !== parsed.priority) continue;
      }
      const score = fuzzyScore(parsed.text, entry.text);
      if (score !== null) {
        scored.push({ node: entry.node, category: entry.category, score });
      }
    }
    // Category dominates (tasks > skills > terms); fuzzy ranks within it.
    scored.sort((a, b) => hitRank(b) - hitRank(a));
    this.hits = scored.slice(0, 50);
  }

  /** Split query tokens: `is:open`/`is:closed`/`is:active`/`status:X` set a
   * status filter, `p<N>` a priority filter; the rest is the fuzzy text. */
  private parseQuery(): { text: string; statuses: string[] | null; priority: number | null } {
    const tokens = this.query.trim().split(/\s+/).filter(Boolean);
    let text = "";
    let statuses: string[] | null = null;
    let priority: number | null = null;
    for (const token of tokens) {
      const sm = token.match(/^(?:is|status):(\w+)$/);
      if (sm) {
        statuses = statuses ?? [];
        statuses.push(sm[1]);
        continue;
      }
      const pm = token.match(/^p(\d)$/);
      if (pm) {
        priority = Number(pm[1]);
        continue;
      }
      text += (text ? " " : "") + token;
    }
    return { text, statuses, priority };
  }

  private jumpToHit(): void {
    const hit = this.hits[this.sel];
    if (!hit) return;
    const path = this.pathTo(hit.node);
    if (!path) return;
    for (const node of path.slice(0, -1)) node.expanded = true;
    this.rows = flattenTree(this.nodes);
    const idx = this.rows.findIndex((r) => r.node === hit.node);
    if (idx >= 0) {
      this.cursor = idx;
      this.followCursor();
    }
    this.mode = "tree";
  }

  /** Path from the roots to the target node, or null if detached. */
  private pathTo(target: PanelNode): PanelNode[] | null {
    const dfs = (nodes: PanelNode[], path: PanelNode[]): PanelNode[] | null => {
      for (const node of nodes) {
        if (node === target) return [...path, node];
        const found = node.children ? dfs(node.children, [...path, node]) : null;
        if (found) return found;
      }
      return null;
    };
    return dfs(this.nodes, []);
  }

  /**
   * The left tree column. Row 0 is the pane title, row 1 a rule under
   * it; the section headings (tasks / context / documentation) follow
   * as the top-level tree rows — headings live here, not in a strip
   * along the top.
   */
  private treeLines(width: number): string[] {
    const t = this.theme;
    const title = t.fg("accent", t.bold("contexture"));
    const rule = t.fg("borderMuted", "─".repeat(Math.max(0, width - 1)));
    const rows = this.rows.map((row, i) => {
      const indent = "  ".repeat(row.depth);
      const expandable = (row.node.children?.length ?? 0) > 0;
      const glyph = expandable ? (row.node.expanded ? "▾" : "▸") : "·";
      const text = `${indent}${glyph} ${row.node.label}`;
      const styled =
        i === this.cursor ? t.fg("accent", t.bold(text)) : row.depth === 0 ? t.bold(text) : text;
      return ` ${styled}`;
    });
    return [title, rule, ...rows];
  }

  /** Content-area lines: search results, action menu, note input, or
   * the selected node's detail. Parents without a detail show a
   * child-count hint; leaves without one, a stub. */
  private contentLines(width: number): string[] {
    if (this.mode === "search") return this.searchLines(width);
    if (this.mode === "actions") return this.actionLines(width);
    if (this.mode === "note") return this.noteLines(width);
    return this.detailLines(width);
  }

  private actionLines(width: number): string[] {
    const t = this.theme;
    const node = this.actionNode();
    if (!node) return [t.fg("dim", "(not a task)")];
    const menu = this.buildActions();
    const out = [
      t.fg("accent", t.bold(node.label)),
      t.fg("dim", `edit actions — ${node.item?.status} · p${node.item?.priority}`),
      "",
    ];
    menu.forEach((act, i) => {
      const marker = i === this.actionSel ? t.fg("accent", "▸ ") : "  ";
      out.push(truncateToWidth(`${marker}${act.label}`, width));
    });
    if (this.error) out.push("", t.fg("warning", this.error));
    return out;
  }

  private noteLines(width: number): string[] {
    const t = this.theme;
    return [
      t.fg("accent", "note"),
      t.fg("dim", "appended to the task; enter to save, esc to cancel"),
      "",
      `${t.fg("accent", "›")} ${this.noteBuf}▌`,
    ].map((line) => truncateToWidth(line, width));
  }

  private searchLines(width: number): string[] {
    const t = this.theme;
    const out = [`${t.fg("accent", "/")}${this.query}▌`];
    if (!this.query.trim()) {
      out.push(t.fg("dim", "(type to search — tasks, skills, terms)"));
      return out;
    }
    if (this.hits.length === 0) {
      out.push(t.fg("dim", "(no matches)"));
      return out;
    }
    const tags = ["task", "skill", "term"];
    this.hits.forEach((hit, i) => {
      const marker = i === this.sel ? t.fg("accent", "▸ ") : "  ";
      const tag = t.fg("dim", `[${tags[hit.category]}] `);
      out.push(truncateToWidth(`${marker}${tag}${hit.node.label}`, width));
    });
    return out;
  }

  private detailLines(width: number): string[] {
    const t = this.theme;
    const node = this.selected.node;
    if (node.detail) return node.detail(width, t);
    const count = node.children?.length ?? 0;
    if (count > 0) {
      return [
        t.fg("accent", t.bold(node.label)),
        "",
        t.fg("dim", `${count} item${count === 1 ? "" : "s"} — enter to expand, select a child for detail`),
      ];
    }
    return [t.fg("accent", t.bold(node.label)), "", t.fg("dim", "(no detail)")];
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(width - 2, 24);
    const treeW = Math.min(40, Math.max(20, Math.round(inner * 0.35)));
    const contentW = inner - treeW - 1; // 1 column for the vertical divider

    this.treeWin.setLines(this.treeLines(treeW - 1));
    this.contentWin.setLines(this.contentLines(contentW));

    const treeRows = this.treeWin.renderFixed(treeW - 1);
    const contentRows = this.contentWin.renderFixed(contentW);
    const body: string[] = [];
    for (let i = 0; i < Math.max(treeRows.length, contentRows.length); i++) {
      const tree = treeRows[i] ?? "";
      const content = truncateToWidth(contentRows[i] ?? "", contentW);
      const treeVisible = visibleWidth(tree);
      const pad = Math.max(0, treeW - 1 - treeVisible);
      body.push(`${tree}${" ".repeat(pad)}${t.fg("borderMuted", "│")}${content}`);
    }

    const scoped = this.scopedRoot();
    const scopeLabel = scoped ? ` ◆${scoped}` : "";
    const hints =
      this.mode === "search"
        ? `type to search · ↑↓ result · enter jump · esc back`
        : this.mode === "actions"
          ? `↑↓ action · enter run · esc back`
          : this.mode === "note"
            ? `type note · enter save · esc cancel`
            : `/ search · shift+↑↓ scope${scopeLabel} · e edit · ctrl+↑↓ toplevel · ↑↓ move · ` +
              `${keyHint(this.kb, "tui.select.cancel", "esc")}/alt+c close`;

    return boxFrame(width, [
      ...body,
      t.fg("borderMuted", "─".repeat(inner)),
      scrollIndicator(this.contentWin, t) + t.fg("dim", hints),
    ], (s: string) => t.fg("borderMuted", s));
  }
}
