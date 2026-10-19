// Tests for history.ts: extraction from a fixture session file, context
// stripping, filler removal, project-folder scope, newest-first ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractPrompts, loadHistory } from "../history/history.ts";

function session(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const file = join(dir, "2026-10-15T00-00-00Z_test.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function userMsg(text: string, ts = "2026-10-15T01:00:00Z"): Record<string, unknown> {
  return { type: "message", id: "x", timestamp: ts, message: { role: "user", content: text } };
}

test("extractPrompts: user text only, context stripped, filler dropped", () => {
  const file = session([
    { type: "session", id: "s" },
    userMsg("Fix the build warnings in src/foo.rs"),
    userMsg("continue"),
    userMsg("yep"),
    userMsg("What does the gate do?"),
    { type: "message", id: "y", timestamp: "t", message: { role: "assistant", content: "hi" } },
  ]);
  const prompts = extractPrompts(file);
  assert.deepEqual(prompts.map((p) => p.text), ["Fix the build warnings in src/foo.rs", "What does the gate do?"]);
  assert.equal(prompts[0].sessionId, "2026-10-15T00-00-00Z_test");
});

test("extractPrompts: injected <context> block is stripped from the prompt", () => {
  const file = session([userMsg("explain the ledger\n<context>\nstuff stuff stuff\n</context>")]);
  const prompts = extractPrompts(file);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, "explain the ledger");
});

test("extractPrompts: block-array content is handled", () => {
  const file = session([
    { type: "message", id: "x", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "check the" }, { type: "text", text: "build log" }] } },
  ]);
  assert.deepEqual(extractPrompts(file).map((p) => p.text), ["check the\nbuild log"]);
});

test("extractPrompts: malformed lines and missing files are tolerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const file = join(dir, "broken.jsonl");
  writeFileSync(file, "{not json\n" + JSON.stringify(userMsg("valid")) + "\n");
  assert.deepEqual(extractPrompts(file).map((p) => p.text), ["valid"]);
  assert.deepEqual(extractPrompts(join(dir, "missing.jsonl")), []);
});

test("loadHistory: project folder scope, chronological (oldest first), filler removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const otherDir = join(dir, "other-project");
  mkdirSync(otherDir);
  writeFileSync(
    join(dir, "a.jsonl"),
    [
      userMsg("older prompt", "2026-10-14T10:00:00Z"),
      userMsg("yep", "2026-10-14T10:01:00Z"),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  writeFileSync(
    join(dir, "b.jsonl"),
    [userMsg("newest prompt", "2026-10-15T09:00:00Z")].map((l) => JSON.stringify(l)).join("\n"),
  );
  writeFileSync(join(otherDir, "c.jsonl"), JSON.stringify(userMsg("other project")));

  const history = loadHistory(join(dir, "a.jsonl"));
  assert.deepEqual(history.map((p) => p.text), ["older prompt", "newest prompt"]);
  assert.equal(history.every((p) => p.sessionId !== "c"), true);
});

test("loadHistory: missing directory yields empty", () => {
  assert.deepEqual(loadHistory("/nonexistent/dir/session.jsonl"), []);
});

// --- dca8: the tree model -----------------------------------------------

import { activePath, listProjects, loadSessions, parseSession } from "../history/history.ts";

/** Write a session file; returns its path. */
function sessionFile(name: string, lines: Array<Record<string, unknown>>): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "tree-"));
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, file };
}

function entry(id: string, parentId: string | null, type = "message", extra: Record<string, unknown> = {}) {
  return { type, id, parentId, timestamp: "2026-10-19T00:00:00Z", ...extra };
}

test("parseSession: header, tree, labels, name, prompts", () => {
  const { file } = sessionFile("s1.jsonl", [
    { type: "session", id: "sess-1", cwd: "/repo", parentSession: "/repo/parent.jsonl" },
    entry("m1", null, "message", { message: { role: "user", content: "fix the bug" } }),
    entry("a1", "m1", "message", { message: { role: "assistant", content: "on it" } }),
    { type: "label", id: "l1", parentId: "a1", timestamp: "t", targetId: "m1", label: "the start" },
    { type: "session_info", id: "i1", parentId: "a1", timestamp: "t", name: "bug hunt" },
    entry("m2", "a1", "message", { message: { role: "user", content: "yep" } }), // filler: not a prompt
    entry("m3", "a1", "message", { message: { role: "user", content: "what changed?" } }),
  ]);
  const s = parseSession(file);
  assert.ok(s);
  assert.equal(s.id, "sess-1");
  assert.equal(s.cwd, "/repo");
  assert.equal(s.parentSessionPath, "/repo/parent.jsonl");
  assert.equal(s.name, "bug hunt");
  assert.equal(s.promptCount, 2);
  assert.equal(s.firstPrompt, "fix the bug");
  assert.equal(s.leafId, "m3");
  // tree shape: m3 hangs off a1, a1 off m1
  const m1 = s.roots[0];
  assert.equal(m1.children.length, 1);
  assert.equal(m1.children[0].id, "a1");
  assert.equal(m1.label, "the start");
  assert.equal(m1.children[0].children.length, 2); // filler still a node
});

test("parseSession: branch — two children of one node both appear", () => {
  const { file } = sessionFile("s2.jsonl", [
    { type: "session", id: "s", cwd: "/r" },
    entry("a", null, "message", { message: { role: "user", content: "root prompt" } }),
    entry("b1", "a", "message", { message: { role: "assistant", content: "old reply" } }),
    entry("b2", "a", "message", { message: { role: "assistant", content: "new reply" } }),
  ]);
  const s = parseSession(file);
  assert.equal(s?.roots[0].children.length, 2);
  assert.deepEqual(s?.roots[0].children.map((c) => c.id), ["b1", "b2"]);
});

test("parseSession: dangling parentId becomes a root; malformed tolerated; missing file null", () => {
  const { file } = sessionFile("s3.jsonl", [
    "not json",
    entry("orphan", "missing-parent", "message", { message: { role: "user", content: "hi" } }),
  ]);
  const s = parseSession(file);
  assert.equal(s?.roots.length, 1);
  assert.equal(s?.roots[0].id, "orphan");
  assert.equal(parseSession(join(dirname(file), "nope.jsonl")), null);
});

test("activePath: leaf ancestry, oldest first", () => {
  const { file } = sessionFile("s4.jsonl", [
    { type: "session", id: "s", cwd: "/r" },
    entry("a", null, "message", { message: { role: "user", content: "one" } }),
    entry("side", "a", "message", { message: { role: "assistant", content: "side branch" } }),
    entry("b", "a", "message", { message: { role: "assistant", content: "trunk" } }),
    entry("c", "b", "message", { message: { role: "user", content: "two" } }),
  ]);
  const s = parseSession(file);
  assert.deepEqual(activePath(s!).map((n) => n.id), ["a", "b", "c"]);
});

test("listProjects: folders sorted, current first; sessions newest first", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  for (const d of ["alpha", "beta", "current"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "current", "old.jsonl"), JSON.stringify(entry("x", null)) + "\n");
  const { file: newer } = sessionFile("new.jsonl", [
    { type: "session", id: "s", cwd: "/r" },
    entry("m", null, "message", { message: { role: "user", content: "newest" } }),
  ]);
  // nudge mtimes apart
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(root, "current", "old.jsonl"), old, old);

  const { projects, current } = listProjects(join(root, "current", "old.jsonl"));
  assert.deepEqual(projects, ["current", "alpha", "beta"]);
  assert.equal(current, "current");

  const sessions = loadSessions(dirname(newer));
  assert.ok(sessions.length >= 1);
  assert.equal(sessions[0].firstPrompt, "newest");
});
