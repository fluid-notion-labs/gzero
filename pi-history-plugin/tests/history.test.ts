// Tests for history.ts: extraction from a fixture session file, context
// stripping, filler removal, project-folder scope, newest-first ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPrompts, loadHistory } from "../history.ts";

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
