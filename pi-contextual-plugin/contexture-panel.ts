// contexture-panel.ts — the unified left-tree pane (ctrl+q / /contexture).
//
// One pane, fresh build (design: work item 2c31). A vertical tree
// along the left with three top-levels — tasks | context |
// documentation — and a content area to the right. There is no header
// strip along the top: the title and the section headings live in the
// tree column itself, so navigation is one cursor over one column.
//
// The panel is the primary since the P5 cutover (da36 bindings):
// ctrl+q toggles, /contexture [section] opens with an optional
// section, and the retired overlays (ctrl+w viewer, ctrl+b viewer)
// are gone.
//
// P0 skeleton: tree interaction (cursor, expand/collapse, top-level
// jumps) over a static tree. Data wiring (tasks, tiers, ws sections)
// lands in P1/P2.

import { readFileSync } from "node:fs";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxFrame, LineWindow, scrollIndicator, wrapPlain } from "./window.ts";
import { reflowMarkdown, renderTables } from "./reflow.ts";
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
  /** Reorder in the queue: `id` moves before/after `sibling` (cx item move). */
  moveItem(id: string, rel: "before" | "after", sibling: string): Promise<void>;
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
  /** Set on catalog hits: enter loads this skill instead of jumping. */
  skillId?: string;
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

/** Canonical skill node id (vendor/name, lowercased). */
export function skillId(entry: { vendor: string; name: string }): string {
  return `skill-${entry.vendor}/${entry.name.toLowerCase()}`;
}

/** Skills capability: the panel tree shows only loaded skills; search
 * additionally matches the full catalog so enter can load one. */
export interface PanelSkills {
  /** The full vendored catalog (for search). */
  catalog(): SkillLike[];
  /** Load a skill for the session (by canonical id). */
  activate(id: string): Promise<void>;
  /** Currently loaded skills (rebuilds the skills node after activation). */
  activated(): SkillLike[];
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

/** Loaded skills → PanelNodes (flat list; the tier node holds it). */
export function skillsToNodes(entries: SkillLike[]): PanelNode[] {
  return entries.map((entry) => ({
    id: skillId(entry),
    label: entry.name,
    searchText: `${entry.description} ${entry.vendor}`,
    detail: (width: number, theme: Theme): string[] => {
      const lines = [
        theme.fg("accent", theme.bold(entry.name)),
        theme.fg("dim", `${entry.vendor} · ${entry.file}`),
        "",
        ...wrapPlain(renderTables(reflowMarkdown(skillBodyFromFile(entry.file))), width),
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
export function textDetail(text: string) {
  let cache: { width: number; lines: string[] } | null = null;
  return (width: number, theme: Theme): string[] => {
    if (!cache || cache.width !== width) {
      cache = {
        width,
        lines: wrapPlain(renderTables(reflowMarkdown(text || "(empty)")), width),
      };
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
  private mode: "tree" | "search" | "actions" | "note" | "move" = "tree";
  private query = "";
  private hits: SearchHit[] = [];
  private sel = 0;
  private corpus: { node: PanelNode; category: number; text: string; root: string }[] = [];
  /** Skills capability: catalog searchable in the context section. */
  private skills: PanelSkills | undefined;
  /** Catalog entries not yet loaded: { id, entry, text }. */
  private catalog: { id: string; entry: SkillLike; text: string }[] = [];
  // Edit state (P4): action menu over a task, note input, scope.
  private actions: PanelActions | undefined;
  private actionSel = 0;
  private noteBuf = "";
  /** True while a move request is in flight (key repeat guard). */
  private moving = false;
  /** Active section (tasks | context | documentation) shown in the top bar. */
  private active = 0;
  /** Remembered tree cursor per section, restored on switch. */
  private sectionCursors: number[] = [];
  private error: string | null = null;
  /** Presence (S1): prebuilt label like "2 other sessions here"; empty
   * when this session is solo or presence is unavailable. */
  private presence: string;

  constructor(
    nodes: PanelNode[],
    theme: Theme,
    done: (result?: unknown) => void,
    /** Injected by ctx.ui.custom; optional for tests. */
    keybindings?: KeybindingsManager,
    actions?: PanelActions,
    skills?: PanelSkills,
    presence?: string,
  ) {
    this.nodes = nodes;
    this.theme = theme;
    this.done = done;
    this.actions = actions;
    this.sectionCursors = nodes.map(() => 0);
    this.rows = flattenTree(nodes[this.active]?.children ?? []);
    const viewport = panelBodyRows();
    this.treeWin = new LineWindow(viewport);
    this.contentWin = new LineWindow(viewport);
    this.kb = keybindings;
    this.nav = viewerNav(keybindings);
    this.skills = skills;
    this.presence = presence ?? "";
    this.buildCorpus();
    this.buildCatalog();
  }

  /** Catalog entries minus already-loaded ones (those are in the tree). */
  private buildCatalog(): void {
    if (!this.skills) {
      this.catalog = [];
      return;
    }
    const loaded = new Set(this.skills.activated().map(skillId));
    this.catalog = this.skills
      .catalog()
      .filter((e) => !loaded.has(skillId(e)))
      .map((e) => ({
        id: skillId(e),
        entry: e,
        text: `${e.name} ${e.description} ${e.vendor}`.trim(),
      }));
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

  get activeSection(): PanelNode | undefined {
    return this.nodes[this.active];
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
    // New selection → show its detail from the top.
    this.contentWin.scrollToStart();
  }

  /** Content-area paging: long details (skill bodies, ws docs) overflow
   * the viewport; pgup/pgdn/home/end page them. */
  private handleContentScroll(data: string): boolean {
    if (this.nav.pageUp(data)) {
      this.contentWin.scrollBy(-this.contentWin.viewport + 2);
      return true;
    }
    if (this.nav.pageDown(data)) {
      this.contentWin.scrollBy(this.contentWin.viewport - 2);
      return true;
    }
    if (matchesKey(data, "home")) {
      this.contentWin.scrollToStart();
      return true;
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.contentWin.scrollToEnd();
      return true;
    }
    return false;
  }

  /** Section switching: the top bar tabs (tab/shift+tab, ctrl+up/ctrl+down).
   * The left tree then navigates inside the active section. Cursor is
   * remembered per section. */
  private switchSection(direction: 1 | -1): void {
    const count = this.nodes.length;
    if (count === 0) return;
    this.sectionCursors[this.active] = this.cursor;
    this.active = (this.active + direction + count) % count;
    this.rows = flattenTree(this.activeSection?.children ?? []);
    this.cursor = Math.min(this.sectionCursors[this.active] ?? 0, Math.max(0, this.rows.length - 1));
    this.contentWin.scrollToStart();
    this.followCursor();
    if (this.mode === "search") this.runSearch();
  }

  /** Open directly on a section (/contexture context starts here).
   * Index-based so callers can't depend on labels. */
  showSection(index: number): void {
    const count = this.nodes.length;
    if (count === 0) return;
    this.active = Math.max(0, Math.min(index, count - 1));
    this.rows = flattenTree(this.activeSection?.children ?? []);
    this.cursor = Math.min(this.sectionCursors[this.active] ?? 0, Math.max(0, this.rows.length - 1));
    this.contentWin.scrollToStart();
    this.followCursor();
  }

  private toggleExpanded(): void {
    const node = this.selected.node;
    if (!node.children || node.children.length === 0) return;
    node.expanded = !node.expanded;
    this.rows = flattenTree(this.activeSection?.children ?? []);
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
    if (this.mode === "move") {
      this.handleMoveInput(data);
      return;
    }
    if (this.mode === "note") {
      this.handleNoteInput(data);
      return;
    }
    // ctrl+q toggles — the overlay owns input while active, so the
    // extension shortcut can't see it (same pattern as the old
    // ctrl+w viewer).
    if (
      this.nav.cancel(data) ||
      matchesKey(data, "q") ||
      matchesKey(data, "ctrl+q")
    ) {
      this.done();
    } else if (this.handleContentScroll(data)) {
      // content-area paging (pgup/pgdn/home/end)
    } else if (matchesKey(data, "tab")) {
      this.switchSection(1);
    } else if (matchesKey(data, "shift+tab")) {
      this.switchSection(-1);
    } else if (this.nav.up(data) || matchesKey(data, "k")) {
      this.moveCursor(-1);
    } else if (this.nav.down(data) || matchesKey(data, "j")) {
      this.moveCursor(1);
    } else if (matchesKey(data, "ctrl+up")) {
      this.switchSection(-1);
    } else if (matchesKey(data, "ctrl+down")) {
      this.switchSection(1);
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
    } else if (data === "m" && this.selected.node.item && this.actions) {
      this.mode = "move";
      this.error = null;
    }
  }

  // ---- queue reordering (m) ----

  private handleMoveInput(data: string): void {
    if (this.nav.cancel(data) || matchesKey(data, "enter") || matchesKey(data, "q")) {
      this.mode = "tree";
      return;
    }
    if (this.nav.up(data) || matchesKey(data, "k")) this.doMove(-1);
    else if (this.nav.down(data) || matchesKey(data, "j")) this.doMove(1);
  }

  /** The queue move a directional step performs for the selected task.
   * Hierarchical: a sub-task at the edge of its sibling group moves the
   * parent instead, so the whole block shifts (user request). */
  private moveStep(dir: -1 | 1): { id: string; rel: "before" | "after"; sibling: string } | null {
    let node = this.selected.node;
    for (;;) {
      const item = node.item;
      if (!item) return null;
      const parent = this.parentOf(node);
      const list = parent ? parent.children ?? [] : this.nodes;
      const idx = list.indexOf(node);
      if (idx < 0) return null;
      const sib = list[idx + dir];
      if (sib?.item) {
        return { id: item.id, rel: dir < 0 ? "before" : "after", sibling: sib.item.id };
      }
      // No neighbor at this level: climb (or stop at the top).
      if (!parent?.item) return null;
      node = parent;
    }
  }

  private parentOf(target: PanelNode): PanelNode | null {
    const stack: { node: PanelNode; parent: PanelNode | null }[] = this.nodes.map((n) => ({ node: n, parent: null }));
    while (stack.length) {
      const { node, parent } = stack.pop()!;
      if (node === target) return parent;
      for (const child of node.children ?? []) stack.push({ node: child, parent: node });
    }
    return null;
  }

  private doMove(dir: -1 | 1): void {
    if (this.moving || !this.actions) return;
    const step = this.moveStep(dir);
    if (!step) return;
    this.moving = true;
    void (async () => {
      try {
        await this.actions!.moveItem(step.id, step.rel, step.sibling);
        await this.refreshItems();
        this.error = null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
      this.moving = false;
    })();
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
    this.rows = flattenTree(this.activeSection?.children ?? []);
    const idx = this.rows.findIndex((r) => r.node.id === curId);
    this.cursor = idx >= 0 ? idx : Math.min(this.cursor, this.rows.length - 1);
    this.buildCorpus();
    this.followCursor();
  }

  /** Search is scoped to the active section (the top bar tab). */
  private scopedRoot(): string | null {
    return this.activeSection?.id ?? null;
  }

  /** Load a skill from a catalog search hit; the skills node then shows
   * it and it leaves the catalog. */
  private async loadSkill(id: string): Promise<void> {
    if (!this.skills) return;
    try {
      await this.skills.activate(id);
      await this.refreshSkills();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Rebuild the skills node from the loaded set after an activation. */
  private async refreshSkills(): Promise<void> {
    if (!this.skills) return;
    const context = this.nodes.find((n) => n.id === "context");
    const skillsNode = context?.children?.find((n) => n.id === "skills");
    if (skillsNode) skillsNode.children = skillsToNodes(this.skills.activated());
    this.buildCorpus();
    this.buildCatalog();
    if (this.mode === "search") this.runSearch();
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
    if (matchesKey(data, "tab")) {
      this.switchSection(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.switchSection(-1);
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
    if (!parsed.text && !parsed.statuses) {
      this.hits = [];
      return;
    }
    const root = this.scopedRoot();
    const scored: SearchHit[] = [];
    for (const entry of this.corpus) {
      // Scope restricts to one top-level section's subtree.
      if (root && entry.root !== root) continue;
      // Query tokens (is:open, is:active, status:X) restrict to matching tasks.
      if (parsed.statuses) {
        const item = entry.node.item;
        if (!item) continue;
        if (!matchesStatus(item.status, parsed.statuses)) continue;
      }
      const score = fuzzyScore(parsed.text, entry.text);
      if (score !== null) {
        scored.push({ node: entry.node, category: entry.category, score });
      }
    }
    // Skill catalog (context section only): findable and loadable.
    if (root === "context") {
      for (const entry of this.catalog) {
        const score = fuzzyScore(parsed.text, entry.text);
        if (score !== null) {
          scored.push({
            node: { id: entry.id, label: entry.entry.name },
            category: 1,
            score,
            skillId: entry.id,
          });
        }
      }
    }
    // Category dominates (tasks > skills > terms); fuzzy ranks within it.
    scored.sort((a, b) => hitRank(b) - hitRank(a));
    this.hits = scored.slice(0, 50);
  }

  /** Split query tokens: `is:open`/`is:closed`/`is:active`/`status:X` set a
   * status filter; the rest is the fuzzy text. */
  private parseQuery(): { text: string; statuses: string[] | null } {
    const tokens = this.query.trim().split(/\s+/).filter(Boolean);
    let text = "";
    let statuses: string[] | null = null;
    for (const token of tokens) {
      const sm = token.match(/^(?:is|status):(\w+)$/);
      if (sm) {
        statuses = statuses ?? [];
        statuses.push(sm[1]);
        continue;
      }
      text += (text ? " " : "") + token;
    }
    return { text, statuses };
  }

  private jumpToHit(): void {
    const hit = this.hits[this.sel];
    if (!hit) return;
    // Catalog hit: load the skill, then the tree picks it up.
    if (hit.skillId) {
      void this.loadSkill(hit.skillId);
      return;
    }
    const path = this.pathTo(hit.node);
    if (!path) return;
    for (const node of path.slice(0, -1)) node.expanded = true;
    this.rows = flattenTree(this.activeSection?.children ?? []);
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
  /** The contextual top bar: title + the three section tabs with counts.
   * The active tab is highlighted; the left tree navigates inside it. */
  private topBarLine(width: number): string {
    const t = this.theme;
    const sep = t.fg("borderMuted", " │ ");
    const tabs = this.nodes.map((section, i) => {
      const count = section.children?.length ?? 0;
      const label = `${section.label} ${count}`;
      return i === this.active ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
    });
    const line = `${t.fg("accent", t.bold("contexture"))}${sep}${tabs.join(sep)}`;
    if (this.presence) {
      const tag = t.fg("dim", ` ⟨ ${this.presence} ⟩`);
      return truncateToWidth(`${line}${tag}`, width);
    }
    return truncateToWidth(line, width);
  }

  private treeLines(width: number): string[] {
    const t = this.theme;
    const rows = this.rows.map((row, i) => {
      const indent = "  ".repeat(row.depth);
      const expandable = (row.node.children?.length ?? 0) > 0;
      const glyph = expandable ? (row.node.expanded ? "▾" : "▸") : "·";
      const text = `${indent}${glyph} ${row.node.label}`;
      const styled =
        i === this.cursor ? t.fg("accent", t.bold(text)) : row.depth === 0 ? t.bold(text) : text;
      return ` ${styled}`;
    });
    return rows;
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
      out.push(t.fg("dim", "(type to search — [skill+] hits load on enter)"));
      return out;
    }
    if (this.hits.length === 0) {
      out.push(t.fg("dim", "(no matches)"));
      return out;
    }
    const tags = ["task", "skill", "term"];
    this.hits.forEach((hit, i) => {
      const marker = i === this.sel ? t.fg("accent", "▸ ") : "  ";
      // Catalog skills aren't loaded yet: [skill+] means enter loads it.
      const tag = t.fg(hit.skillId ? "accent" : "dim", `[${tags[hit.category]}${hit.skillId ? "+" : ""}] `);
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

    const hints =
      this.mode === "search"
        ? `type to search (this section) · [skill+] enter loads · tab section · esc back`
        : this.mode === "actions"
          ? `↑↓ action · enter run · esc back`
          : this.mode === "note"
            ? `type note · enter save · esc cancel`
            : this.mode === "move"
              ? `↕ reorder · enter/esc done`
              : `/ search · tab/shift+tab section · ↑↓ move · e edit · m move · pgup/pgdn page · ` +
                `${keyHint(this.kb, "tui.select.cancel", "esc")}/ctrl+q close`;

    return boxFrame(width, [
      this.topBarLine(inner),
      t.fg("borderMuted", "─".repeat(inner)),
      ...body,
      t.fg("borderMuted", "─".repeat(inner)),
      scrollIndicator(this.contentWin, t) + t.fg("dim", hints),
    ], (s: string) => t.fg("borderMuted", s));
  }
}
