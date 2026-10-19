// history.ts — the session-history read side.
//
// Sessions live under ~/.pi/agent/sessions/<project-slug>/<session>.jsonl.
// The model is three levels (item dca8): projects → sessions → the
// in-session entry tree. pi's session format already records all of it:
// entries carry {id, parentId} (a branch tree), the session header carries
// parentSession (the fork DAG), labels arrive as separate label entries,
// session_info entries carry display names. This module parses that shape
// directly — same stance as before: no cross-package imports, node:fs only.
//
// User prompts remain the content: injected <context> blocks are stripped,
// pure filler ("yep", "ok, continue", ...) is dropped via filler.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isFiller } from "./filler.ts";

export interface PromptEntry {
  text: string;
  timestamp: string;
  sessionId: string;
}

/** One node of the in-session entry tree (pi entries are id/parentId trees). */
export interface HistNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  /** Cleaned user prompt text — set only for user message entries. */
  text?: string;
  /** Resolved bookmark label (label entries target other entries; last wins). */
  label?: string;
  children: HistNode[];
}

/** Parsed session file: header facts + the entry tree. */
export interface SessionModel {
  path: string;
  id: string;
  cwd: string;
  /** User-defined display name from session_info entries, if any. */
  name?: string;
  /** Path to the parent session (if this session was forked/resumed from). */
  parentSessionPath?: string;
  created: string;
  modified: string;
  promptCount: number;
  firstPrompt?: string;
  /** Entry trees (entries whose parentId is null or missing). */
  roots: HistNode[];
  /** Last entry in file order — the active branch's leaf. */
  leafId: string | null;
}

/** Strip injected blocks and trim; returns "" when nothing user-typed remains. */
function cleanPrompt(text: string): string {
  let t = text;
  const cut = t.indexOf("<context>");
  if (cut !== -1) t = t.slice(0, cut);
  return t.trim();
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join("\n");
  }
  return "";
}

/** Extract user prompts from one session file, oldest first. */
export function extractPrompts(sessionPath: string): PromptEntry[] {
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
  const entries: PromptEntry[] = [];
  let file: string;
  try {
    file = readFileSync(sessionPath, "utf8");
  } catch {
    return entries;
  }
  for (const line of file.split("\n")) {
    if (!line) continue;
    let e: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const clean = cleanPrompt(userText(e.message?.content));
    if (!clean || isFiller(clean)) continue;
    entries.push({ text: clean, timestamp: e.timestamp ?? "", sessionId });
  }
  return entries;
}

/**
 * Load the project's prompt history: every session in the same sessions
 * folder as `currentSessionFile` (or the folder itself), newest first.
 * Kept for the flat view; the tree API below is what the panel uses.
 */
export function loadHistory(currentSessionFile: string): PromptEntry[] {
  const dir = dirname(currentSessionFile);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const all: PromptEntry[] = [];
  for (const f of files) {
    all.push(...extractPrompts(join(dir, f)));
  }
  // chronological (oldest first): the panel reads like the chat, newest
  // at the bottom by the editor, time fading upwards
  return all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

/**
 * Parse one session file into the tree model. Tolerates malformed lines,
 * unknown entry types, and dangling parentIds (treated as roots).
 */
export function parseSession(sessionPath: string): SessionModel | null {
  let file: string;
  let stat: { birthtimeMs: number; mtimeMs: number };
  try {
    file = readFileSync(sessionPath, "utf8");
    stat = statSync(sessionPath);
  } catch {
    return null;
  }

  let id = basename(sessionPath).replace(/\.jsonl$/, "");
  let cwd = "";
  let parentSessionPath: string | undefined;
  let name: string | undefined;

  const byId = new Map<string, HistNode>();
  const labels = new Map<string, { label?: string; timestamp: string }>();
  let leafId: string | null = null;
  let promptCount = 0;
  let firstPrompt: string | undefined;

  for (const line of file.split("\n")) {
    if (!line) continue;
    let e: {
      type?: string;
      id?: string;
      parentId?: string | null;
      timestamp?: string;
      cwd?: string;
      parentSession?: string;
      name?: unknown;
      targetId?: string;
      label?: string | undefined;
      message?: { role?: string; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;

    if (e.type === "session") {
      // header
      if (typeof e.id === "string") id = e.id;
      if (typeof e.cwd === "string") cwd = e.cwd;
      if (typeof e.parentSession === "string") parentSessionPath = e.parentSession;
      continue;
    }
    if (e.type === "session_info" && typeof e.name === "string" && e.name) {
      name = e.name;
      continue;
    }
    if (e.type === "label" && typeof e.targetId === "string") {
      labels.set(e.targetId, { label: e.label, timestamp: e.timestamp ?? "" });
      continue;
    }
    if (!e.id) continue;

    const node: HistNode = {
      id: e.id,
      parentId: typeof e.parentId === "string" ? e.parentId : null,
      type: e.type ?? "unknown",
      timestamp: e.timestamp ?? "",
      children: [],
    };
    if (e.type === "message" && e.message?.role === "user") {
      const clean = cleanPrompt(userText(e.message.content));
      if (clean && !isFiller(clean)) {
        node.text = clean;
        promptCount++;
        if (!firstPrompt) firstPrompt = clean;
      }
    }
    byId.set(node.id, node);
    leafId = node.id;
  }

  // resolve labels onto their targets
  for (const [target, l] of labels) {
    const node = byId.get(target);
    if (node && l.label) node.label = l.label;
  }

  // attach children; entries whose parent is missing/dangling become roots
  const roots: HistNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return {
    path: sessionPath,
    id,
    cwd,
    name,
    parentSessionPath,
    created: new Date(stat.birthtimeMs).toISOString(),
    modified: new Date(stat.mtimeMs).toISOString(),
    promptCount,
    firstPrompt,
    roots,
    leafId,
  };
}

/**
 * The active branch: the path from a root to the last entry in file
 * order. pi sessions are append-only, so the newest entry is the leaf
 * the agent is on; its ancestry is the active branch.
 */
export function activePath(session: SessionModel): HistNode[] {
  const byId = new Map<string, HistNode>();
  const walk = (n: HistNode) => {
    byId.set(n.id, n);
    n.children.forEach(walk);
  };
  session.roots.forEach(walk);
  const path: HistNode[] = [];
  let cur = session.leafId ? byId.get(session.leafId) : undefined;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** One row of the comms presence roster (gzero-mcp `sessions` output). */
export interface PresenceRow {
  session_id: string;
  machine: string;
  label: string;
  last_seen: number;
}

export interface PresenceBadge {
  machine: string;
  label: string;
}

/**
 * Live presence rows only (300s TTL, mirrored from the Rust side's
 * PRESENCE_TTL_SECS), keyed by session id — which, since the plugin now
 * adopts pi's session id, is exactly the id in the session file header.
 */
export function livePresence(
  rows: PresenceRow[],
  now: number,
  ttlSecs = 300,
): Map<string, PresenceBadge> {
  const live = new Map<string, PresenceBadge>();
  for (const r of rows) {
    if (typeof r?.session_id !== "string" || !r.session_id) continue;
    if (typeof r.last_seen !== "number" || now - r.last_seen >= ttlSecs) continue;
    live.set(r.session_id, { machine: r.machine ?? "", label: r.label ?? "" });
  }
  return live;
}

/** The projects level: session folders under the sessions root. */
export function listProjects(sessionFile: string): { projects: string[]; current: string | null } {
  const root = dirname(dirname(sessionFile));
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { projects: [], current: null };
  }
  const current = basename(dirname(sessionFile));
  const projects = dirs.sort((a, b) => (a === current ? -1 : b === current ? 1 : a < b ? -1 : 1));
  return { projects, current };
}

/** The sessions level: one project's sessions, newest first. */
export function loadSessions(projectDir: string): SessionModel[] {
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const sessions = files
    .map((f) => parseSession(join(projectDir, f)))
    .filter((s): s is SessionModel => s !== null);
  return sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
}
