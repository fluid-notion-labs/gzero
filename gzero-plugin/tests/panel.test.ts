// Tests for panel.ts: the bordered popup frame and the three-level
// navigation (projects → sessions → history tree, item dca8). The border
// rows and the body rows must all occupy exactly the same column count —
// a drifting corner is the bug this guards against.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HistoryPanel, flattenTree } from "../history/panel.ts";
import type { HistNode, SessionModel } from "../history/history.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI, "").length;

// The panel only calls theme.fg / theme.bg; a pass-through stub keeps the
// geometry assertions readable.
const theme = {
  fg: (_k: string, s: string) => s,
  bg: (_k: string, s: string) => s,
} as unknown as Theme;

interface PanelHooks {
  picks: string[];
  loads: string[];
}

function promptNode(id: string, text: string, children: HistNode[] = []): HistNode {
  return { id, parentId: null, type: "message", timestamp: "2026-10-19T01:00:00Z", text, children };
}

function sessionModel(id: string, roots: HistNode[], extra: Partial<SessionModel> = {}): SessionModel {
  const leafId = extra.leafId ?? lastId(roots);
  return {
    path: `/tmp/sessions/proj/${id}.jsonl`,
    id,
    cwd: "/repo",
    modified: "2026-10-19T01:00:00Z",
    promptCount: countPrompts(roots),
    firstPrompt: firstPrompt(roots),
    roots,
    leafId,
    ...extra,
  };
}

function lastId(roots: HistNode[]): string {
  let last = "";
  const walk = (n: HistNode) => {
    last = n.id;
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return last;
}

function countPrompts(roots: HistNode[]): number {
  let n = 0;
  const walk = (x: HistNode) => {
    if (x.text) n++;
    x.children.forEach(walk);
  };
  roots.forEach(walk);
  return n;
}

function firstPrompt(roots: HistNode[]): string | undefined {
  let first: string | undefined;
  const walk = (x: HistNode) => {
    if (!first && x.text) first = x.text;
    x.children.forEach(walk);
  };
  roots.forEach(walk);
  return first;
}

/** A panel on the projects level with one project whose sessions come from a loader. */
function panel(projects: string[], sessions: SessionModel[], hooks: PanelHooks): HistoryPanel {
  return new HistoryPanel(projects, projects[0] ?? null, theme, undefined, {
    onClose: () => {},
    onPick: (entry) => hooks.picks.push(entry.text),
    loadSessions: (dir) => {
      hooks.loads.push(dir);
      return sessions;
    },
    sessionDir: (project) => `/tmp/sessions/${project}`,
  });
}

/** Build the branch tree fixture:
 *  root prompt ── reply ─┬─ user "branch a"
 *                        └─ user "branch b" (leaf = active) */
function branching(): HistNode {
  const root = promptNode("root", "fix the login bug");
  const reply: HistNode = { ...promptNode("reply", ""), text: undefined, type: "message" };
  const a = promptNode("a", "branch a");
  const b = promptNode("b", "branch b");
  root.children = [reply];
  reply.children = [a, b];
  return root;
}

function assertAligned(lines: string[]) {
  const widths = lines.map(visibleLen);
  assert.ok(widths.every((w) => w === widths[0]), `rows must share one width, got ${widths}`);
  assert.match(lines[0], /^┌─/);
  assert.match(lines[0], /┐$/);
  assert.match(lines[lines.length - 1], /^└─/);
  assert.match(lines[lines.length - 1], /┘$/);
  for (const line of lines.slice(1, -1)) {
    assert.match(line, /^│ /);
    assert.match(line, / │$/);
  }
}

test("projects level: rows align, current project listed, loads on enter", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const p = panel(["proj", "other"], [], hooks);
  const lines = p.render(80);
  assertAligned(lines);
  assert.match(lines[0], /projects/);
  assert.match(lines[1], /proj/);

  p.handleInput("\r"); // enter on the first project
  assert.deepEqual(hooks.loads, ["/tmp/sessions/proj"]);
});

test("sessions level: newest first, fork marked, date shown", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const sessions = [
    sessionModel("new", [promptNode("n1", "newest work")], { modified: "2026-10-19T01:00:00Z", parentSessionPath: "/tmp/old.jsonl" }),
    sessionModel("old", [promptNode("o1", "older work")], { modified: "2026-10-15T01:00:00Z" }),
  ];
  const p = panel(["proj"], sessions, hooks);
  p.handleInput("\r");
  const lines = p.render(100);
  assertAligned(lines);
  assert.match(lines[1], /2026-10-19 +newest work/);
  assert.match(lines[1], /↰ fork/);
  assert.match(lines[2], /2026-10-15 +older work/);
  assert.doesNotMatch(lines[2], /↰/);
});

test("history level: prompts are rows, branch point renders as ⑂, enter picks prompt", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const p = panel(["proj"], [sessionModel("s1", [branching()])], hooks);
  p.handleInput("\r"); // project → sessions
  p.handleInput("\r"); // session → history
  const lines = p.render(100);
  assertAligned(lines);
  const body = lines.join("\n");
  assert.match(body, /fix the login bug/);
  assert.match(body, /branch a/);
  assert.match(body, /branch b/);
  assert.match(body, /⑂/);

  // selection starts on the last prompt; enter picks it
  p.handleInput("\r");
  assert.deepEqual(hooks.picks, ["branch b"]);
});

test("fold and unfold with left/right; selection stays on the node", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const p = panel(["proj"], [sessionModel("s1", [branching()])], hooks);
  p.handleInput("\r");
  p.handleInput("\r");
  // move up to the reply (branch point) and fold
  p.handleInput("k");
  p.handleInput("k");
  p.handleInput("h");
  let body = p.render(100).join("\n");
  assert.match(body, /\(\+2\)/);
  assert.doesNotMatch(body, /branch a/);
  // unfold again
  p.handleInput("l");
  body = p.render(100).join("\n");
  assert.match(body, /branch a/);
  assert.doesNotMatch(body, /\(\+2\)/);
});

test("esc backs a level: history → sessions → projects → close", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  let closed = 0;
  const p = new HistoryPanel(["proj"], "proj", theme, undefined, {
    onClose: () => closed++,
    onPick: () => {},
    loadSessions: () => [sessionModel("s1", [promptNode("x1", "only prompt")])],
    sessionDir: (d) => `/tmp/sessions/${d}`,
  });
  p.handleInput("\r"); // → sessions
  p.handleInput("\r"); // → history
  p.handleInput("\x1b"); // → sessions
  assert.match(p.render(80).join("\n"), /only prompt/);
  p.handleInput("\x1b"); // → projects
  assert.match(p.render(80).join("\n"), /projects/);
  p.handleInput("\x1b"); // close
  assert.equal(closed, 1);
});

test("empty project list renders a framed empty state", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const lines = panel([], [], hooks).render(80);
  assert.equal(lines.length, 3);
  assertAligned(lines);
  assert.match(lines[1], /no sessions yet/);
});

test("long entries clip inside the frame at narrow widths", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const long = promptNode("x", "y".repeat(200));
  const p = panel(["proj"], [sessionModel("s", [long])], hooks);
  p.handleInput("\r");
  p.handleInput("\r");
  const lines = p.render(30);
  assertAligned(lines);
});

test("flattenTree: depth-first order, folded subtrees hidden", () => {
  const tree = branching();
  const full = flattenTree([tree], new Set());
  assert.deepEqual(full.map((r) => r.node.id), ["root", "reply", "a", "b"]);
  assert.deepEqual(full.map((r) => r.depth), [0, 1, 2, 2]);

  const folded = flattenTree([tree], new Set(["reply"]));
  assert.deepEqual(folded.map((r) => r.node.id), ["root", "reply"]);
});

// --- presence badges (dca8 slice 2) --------------------------------------

test("sessions level: 'you' badge on the opening session, ● machine on live presence", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const current = sessionModel("sess-current", [promptNode("p1", "current session work")]);
  const other = sessionModel("sess-live", [promptNode("p2", "other machine work")]);
  const offline = sessionModel("sess-old", [promptNode("p3", "old work")]);
  const p = panel(["proj"], [current, other, offline], hooks);
  (p as unknown as { opts: { currentSessionFile: string; presence: Map<string, { machine: string; label: string }> } }).opts.currentSessionFile = current.path;
  (p as unknown as { opts: { currentSessionFile: string; presence: Map<string, { machine: string; label: string }> } }).opts.presence = new Map([
    ["sess-live", { machine: "aaaa-bbbb-cccc", label: "" }],
    ["sess-current", { machine: "local", label: "" }],
  ]);
  p.handleInput("\r"); // -> sessions
  const body = p.render(120).join("\n");
  assert.match(body, /current session work.*· you/s);
  assert.match(body, /other machine work.*● aaaa-bbb/s);
  assert.match(body, /old work/);
});

test("presence label wins over machine id when set", () => {
  const hooks: PanelHooks = { picks: [], loads: [] };
  const other = sessionModel("sess-labeled", [promptNode("p", "labeled work")]);
  const p = panel(["proj"], [other], hooks);
  (p as unknown as { opts: { presence: Map<string, { machine: string; label: string }> } }).opts.presence = new Map([
    ["sess-labeled", { machine: "zzzz", label: "laptop" }],
  ]);
  p.handleInput("\r");
  assert.match(p.render(120).join("\n"), /● laptop/);
});
