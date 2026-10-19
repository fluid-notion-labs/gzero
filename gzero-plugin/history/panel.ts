// panel.ts — the history overlay: projects → sessions → the branch tree.
//
// Level 1 lists session folders (projects); level 2 lists one project's
// sessions newest-first (forks marked, prompt counts); level 3 renders the
// selected session's entry tree — prompts along the branches, branch points
// as ⑂ rows, foldable with left/right, active branch visible. Enter picks a
// prompt (inserted into the editor) exactly like the old flat panel.
//
// Prompt rows keep the chat styling (userMessageBg blue blocks); structural
// rows render dim. Filler is already removed at parse time.

import { matchesKey, type Keybinding, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HistNode, PromptEntry, SessionModel } from "./history.ts";

/** How many list lines render at once. */
const WINDOW = 20;

function id(binding: Keybinding, fallback: KeyId) {
  return (data: string, kb?: KeybindingsManager) => (kb ? kb.matches(data, binding) : matchesKey(data, fallback));
}

const CANCEL = id("tui.select.cancel", "escape");
const CONFIRM = id("tui.select.confirm", "return");
const UP = id("tui.select.up", "up");
const DOWN = id("tui.select.down", "down");
const PAGE_UP = id("tui.select.pageUp", "pageUp");
const PAGE_DOWN = id("tui.select.pageDown", "pageDown");

export interface HistoryPanelOptions {
  onClose: () => void;
  /** Enter: pick the prompt (the opener inserts it into the editor) and close. */
  onPick: (entry: PromptEntry) => void;
  /** Load one project's sessions when its row is confirmed (fs stays out of the panel). */
  loadSessions: (projectDir: string) => SessionModel[];
  /** Resolve a fork's parent display name (basename of parentSessionPath). */
  sessionDir: (project: string) => string;
}

type Level = "projects" | "sessions" | "history";

interface HistoryRow {
  node: HistNode;
  depth: number;
}

/** Depth-first flatten of the entry tree, skipping folded subtrees. */
export function flattenTree(roots: HistNode[], collapsed: Set<string>): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const walk = (node: HistNode, depth: number) => {
    rows.push({ node, depth });
    if (!collapsed.has(node.id)) node.children.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return rows;
}

export class HistoryPanel {
  private level: Level = "projects";
  private projects: string[];
  private readonly currentProject: string | null;
  private openProject: string | null = null;
  private sessions: SessionModel[] = [];
  private session: SessionModel | null = null;
  private rows: HistoryRow[] = [];
  private collapsed = new Set<string>();
  private active = new Set<string>();
  private selected = 0;
  private scroll = 0;
  private readonly theme: Theme;
  private readonly kb: KeybindingsManager | undefined;
  private readonly opts: HistoryPanelOptions;

  constructor(
    projects: string[],
    currentProject: string | null,
    theme: Theme,
    kb: KeybindingsManager | undefined,
    opts: HistoryPanelOptions,
  ) {
    this.projects = projects;
    this.currentProject = currentProject;
    this.theme = theme;
    this.kb = kb;
    this.opts = opts;
    this.selected = 0;
  }

  invalidate(): void {}

  private rowCount(): number {
    if (this.level === "projects") return this.projects.length;
    if (this.level === "sessions") return this.sessions.length;
    return this.rows.length;
  }

  private keepVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + WINDOW) this.scroll = this.selected - WINDOW + 1;
    if (this.scroll < 0) this.scroll = 0;
    const maxScroll = Math.max(0, this.rowCount() - WINDOW);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
  }

  private openSessions(project: string): void {
    this.openProject = project;
    this.sessions = this.opts.loadSessions(this.opts.sessionDir(project));
    this.level = "sessions";
    this.selected = 0;
    this.scroll = 0;
  }

  private openSession(session: SessionModel): void {
    this.session = session;
    this.collapsed = new Set();
    // active branch = leaf ancestry, for the ● marking
    this.active = new Set();
    let cur: HistNode | undefined = session.leafId ? findNode(session, session.leafId) : undefined;
    while (cur) {
      this.active.add(cur.id);
      cur = cur.parentId ? findNode(session, cur.parentId) : undefined;
    }
    this.rows = flattenTree(session.roots, this.collapsed);
    // start on the last prompt (bottom row, by the editor), like before
    let idx = this.rows.length - 1;
    while (idx > 0 && !this.rows[idx].node.text) idx--;
    this.level = "history";
    this.selected = Math.max(0, idx);
    this.scroll = 0;
  }

  handleInput(data: string): void {
    // F1 toggles: the same key that opened the panel closes it.
    if (CANCEL(data, this.kb) || data === "q" || matchesKey(data, "f1")) {
      if (this.level === "projects") {
        this.opts.onClose();
        return;
      }
      this.level = this.level === "history" ? "sessions" : "projects";
      this.selected = Math.min(this.selected, Math.max(0, this.rowCount() - 1));
      this.keepVisible();
      return;
    }
    if (CONFIRM(data, this.kb)) {
      if (this.level === "projects") {
        const project = this.projects[this.selected];
        if (project) this.openSessions(project);
      } else if (this.level === "sessions") {
        const session = this.sessions[this.selected];
        if (session) this.openSession(session);
      } else {
        const row = this.rows[this.selected];
        if (!row) return;
        if (row.node.text) {
          this.opts.onPick({
            text: row.node.text,
            timestamp: row.node.timestamp,
            sessionId: this.session?.id ?? "",
          });
        } else if (row.node.children.length > 0) {
          this.toggleFold(row.node);
        }
      }
      return;
    }
    const last = this.rowCount() - 1;
    if (UP(data, this.kb) || data === "k") {
      // up = older, like ctrl+up through chat history
      this.selected = Math.max(0, this.selected - 1);
    } else if (DOWN(data, this.kb) || data === "j") {
      this.selected = Math.min(last, this.selected + 1);
    } else if (PAGE_UP(data, this.kb) || data === "g") {
      this.selected = Math.max(0, this.selected - WINDOW);
    } else if (PAGE_DOWN(data, this.kb) || data === "G") {
      this.selected = Math.min(last, this.selected + WINDOW);
    } else if (this.level === "history" && (data === "h" || matchesKey(data, "left"))) {
      const row = this.rows[this.selected];
      if (row && row.node.children.length > 0 && !this.collapsed.has(row.node.id)) {
        this.toggleFold(row.node);
      }
    } else if (this.level === "history" && (data === "l" || matchesKey(data, "right"))) {
      const row = this.rows[this.selected];
      if (row && row.node.children.length > 0 && this.collapsed.has(row.node.id)) {
        this.collapsed.delete(row.node.id);
        this.rows = flattenTree(this.session?.roots ?? [], this.collapsed);
        this.selected = this.rows.findIndex((r) => r.node.id === row.node.id);
      }
    }
    this.keepVisible();
  }

  private toggleFold(node: HistNode): void {
    if (!this.session) return;
    if (this.collapsed.has(node.id)) this.collapsed.delete(node.id);
    else this.collapsed.add(node.id);
    const nodeId = node.id;
    this.rows = flattenTree(this.session.roots, this.collapsed);
    this.selected = Math.max(
      0,
      this.rows.findIndex((r) => r.node.id === nodeId),
    );
    this.keepVisible();
  }

  private sessionTitle(session: SessionModel): string {
    // date is enough for recall; time-of-day noise isn't worth the columns
    const date = session.modified ? session.modified.slice(0, 10) : "?";
    const title = session.name ?? session.firstPrompt ?? session.id;
    const fork = session.parentSessionPath ? " ↰ fork" : "";
    const count = ` · ${session.promptCount} prompt${session.promptCount === 1 ? "" : "s"}`;
    return `${date}  ${title}${count}${fork}`;
  }

  private renderProjects(content: number): string[] {
    const lines: string[] = [];
    const total = this.projects.length;
    if (total === 0) {
      lines.push(`│ ${this.theme.fg("dim", " no sessions yet".padEnd(content))} │`);
      return lines;
    }
    for (let i = this.scroll; i < Math.min(total, this.scroll + WINDOW); i++) {
      const project = this.projects[i];
      const isCurrent = project === this.currentProject;
      const marker = i === this.selected ? "▸ " : "  ";
      const tag = isCurrent ? " ·" : "";
      const body = ` ${marker}${truncate(`${project}${tag}`, content - 3)}`;
      lines.push(`│ ${this.theme.bg("userMessageBg", body.padEnd(content))} │`);
    }
    return lines;
  }

  private renderSessions(content: number): string[] {
    const lines: string[] = [];
    const total = this.sessions.length;
    if (total === 0) {
      lines.push(`│ ${this.theme.fg("dim", " no sessions in this project".padEnd(content))} │`);
      return lines;
    }
    for (let i = this.scroll; i < Math.min(total, this.scroll + WINDOW); i++) {
      const session = this.sessions[i];
      const marker = i === this.selected ? "▸ " : "  ";
      const body = ` ${marker}${truncate(this.sessionTitle(session), content - 3)}`;
      lines.push(`│ ${this.theme.bg("userMessageBg", body.padEnd(content))} │`);
    }
    return lines;
  }

  private renderHistory(content: number): string[] {
    const lines: string[] = [];
    const total = this.rows.length;
    if (total === 0) {
      lines.push(`│ ${this.theme.fg("dim", " empty session".padEnd(content))} │`);
      return lines;
    }
    for (let i = this.scroll; i < Math.min(total, this.scroll + WINDOW); i++) {
      const row = this.rows[i];
      const node = row.node;
      const isSelected = i === this.selected;
      const indent = "  ".repeat(row.depth);
      const folded = this.collapsed.has(node.id) && node.children.length > 0;
      const foldedTag = folded ? ` (+${node.children.length})` : "";
      const branchTag = node.children.length > 1 && !node.text ? ` ⑂ ${node.label ?? ""}`.trimEnd() : "";
      const activeMark = this.active.has(node.id) ? "●" : "○";
      if (node.text) {
        const body = ` ${isSelected ? "▸ " : "  "}${truncate(node.text, content - 5)}`;
        lines.push(`│ ${this.theme.bg("userMessageBg", body.padEnd(content))} │`);
      } else {
        const kind = node.type === "branch_summary" ? "branch" : node.type;
        const text = truncate(`${indent}${activeMark} ${kind}${branchTag}${foldedTag}`, content - 4);
        lines.push(`│ ${this.theme.fg("dim", ` ${text.padEnd(content - 1)}`)} │`);
      }
    }
    return lines;
  }

  render(width: number): string[] {
    const total = this.rowCount();
    this.keepVisible();

    // Box spans width-1 columns; the trailing column stays empty so no row
    // reaches the terminal's wrap column (the margin the unbordered panel
    // kept). Inside the frame, a one-space gutter separates the walls from
    // the content; title and footer hints sit in the top/bottom border.
    const outer = Math.max(9, width - 1);
    const content = outer - 4; // │ + gutter space on each side

    const session = this.session;
    const title =
      this.level === "projects"
        ? "history — projects"
        : this.level === "sessions"
          ? `history — ${this.openProject ?? this.currentProject ?? "?"}`
          : session
            ? `history — ${truncate(session.name ?? session.firstPrompt ?? session.id, 40)}${session.parentSessionPath ? " ↰" : ""}`
            : "history — session";
    const footers: Record<Level, string> = {
      projects: "enter open · esc/f1 close",
      sessions: "enter open · esc back",
      history: "↑↓ move · ← fold · → unfold · enter insert · esc back",
    };
    const footer =
      footers[this.level] +
      (total > WINDOW ? ` · ${this.scroll + 1}-${Math.min(total, this.scroll + WINDOW)} of ${total}` : "");

    // Border row: `${open}─ ${text} ${dashes}${close}`, sized so the total
    // is always exactly `outer` columns — text yields room to the fill.
    const edge = (open: string, close: string, text: string): string => {
      const vis = Math.min(visibleLen(text), outer - 5);
      const dashes = outer - 5 - vis;
      return (
        this.theme.fg("dim", `${open}─ ${clip(text, vis)} `) +
        this.theme.fg("dim", "─".repeat(dashes) + close)
      );
    };

    const lines: string[] = [];
    lines.push(edge("┌", "┐", title));
    if (this.level === "projects") lines.push(...this.renderProjects(content));
    else if (this.level === "sessions") lines.push(...this.renderSessions(content));
    else lines.push(...this.renderHistory(content));
    lines.push(edge("└", "┘", footer));
    return lines;
  }
}

function findNode(session: SessionModel, id: string): HistNode | undefined {
  let found: HistNode | undefined;
  const walk = (n: HistNode): boolean => {
    if (n.id === id) {
      found = n;
      return true;
    }
    return n.children.some(walk);
  };
  session.roots.some(walk);
  return found;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Rendered column count, ignoring SGR escapes. */
function visibleLen(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Hard-truncate plain text to `max` visible columns with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n+/g, " ↵ ");
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + "…";
}
