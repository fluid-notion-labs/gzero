// Tests for history/summary.ts: transcript extraction with stable queue
// indices, prompt building (full and incremental), the per-session cache,
// and the ephemeral pi invocation; plus the panel's summary block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryPanel } from "../history/panel.ts";
import {
  buildPrompt,
  extractTranscript,
  loadSummaryCache,
  requestSummary,
  saveSummaryCache,
  summaryCachePath,
  type TranscriptEntry,
} from "../history/summary.ts";

function session(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "summ-"));
  const file = join(dir, "2026-10-21T00-00-00Z_test.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function msg(role: "user" | "assistant", text: string, ts = "2026-10-21T01:00:00Z"): Record<string, unknown> {
  return { type: "message", id: "x", timestamp: ts, message: { role, content: text } };
}

const entry = (index: number, role: "user" | "assistant", text: string): TranscriptEntry => ({
  index,
  role,
  timestamp: "",
  text,
});

test("extractTranscript: user and agent turns, stable indices, filler and context dropped", () => {
  const file = session([
    { type: "session", id: "s" },
    msg("user", "Fix the build warnings\n<context>\ninjected stuff\n</context>"),
    msg("assistant", "On it — checking src/foo.rs now."),
    msg("user", "yep"),
    msg("user", "What about the gate?"),
    msg("assistant", ""),
  ]);
  const t = extractTranscript(file);
  assert.deepEqual(
    t.map((e) => [e.index, e.role, e.text]),
    [
      [1, "user", "Fix the build warnings"],
      [2, "assistant", "On it — checking src/foo.rs now."],
      [3, "user", "What about the gate?"],
    ],
  );
});

test("extractTranscript: array content blocks are joined; missing file yields []", () => {
  const file = session([msg("assistant", "first part")]);
  const t = extractTranscript(file);
  assert.equal(t.length, 1);
  assert.deepEqual(extractTranscript(join(tmpdir(), "nope-does-not-exist.jsonl")), []);
});

test("buildPrompt (full): numbered payload, citation instruction, long entries clipped", () => {
  const prompt = buildPrompt([entry(1, "user", "short"), entry(2, "assistant", "x".repeat(900))]);
  assert.ok(prompt.includes("[1] user: short"));
  assert.ok(prompt.includes("[2] agent: "));
  assert.ok(prompt.length < 2000); // the 900-char entry was clipped to ~800
  assert.ok(prompt.toLowerCase().includes("cite the relevant [index]"));
});

test("buildPrompt (incremental): previous summary plus only the newer entries", () => {
  const prompt = buildPrompt(
    [entry(1, "user", "old"), entry(2, "user", "new"), entry(3, "assistant", "newer")],
    { summary: "earlier work", covered: 1 },
  );
  assert.ok(prompt.includes("Current summary (covers entries [1..1]):"));
  assert.ok(prompt.includes("earlier work"));
  assert.ok(prompt.includes("[2] user: new"));
  assert.ok(prompt.includes("[3] agent: newer"));
  assert.ok(!prompt.includes("[1] user: old"));
});

test("summary cache: roundtrip and load of a missing/corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  const file = join(dir, "sess.jsonl");
  const path = summaryCachePath(file, dir);
  assert.equal(path, join(dir, "sess.json"));
  assert.equal(loadSummaryCache(file, dir), null);
  saveSummaryCache(file, { summary: "s", covered: 4, updatedAt: "now" }, dir);
  const c = loadSummaryCache(file, dir);
  assert.deepEqual(c, { summary: "s", covered: 4, updatedAt: "now" });
  // corrupt JSON is treated as no cache
  writeFileSync(path, "{not json");
  assert.equal(loadSummaryCache(file, dir), null);
  // nested base dir is created on save
  const nested = join(dir, "a", "b");
  saveSummaryCache(file, { summary: "s", covered: 1, updatedAt: "now" }, nested);
  assert.ok(readFileSync(join(nested, "sess.json"), "utf8").includes('"covered": 1'));
});

test("requestSummary: runs pi headless and surfaces failures", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const text = await requestSummary(
    (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve({ stdout: "  the summary \n", stderr: "", code: 0 });
    },
    "summarize this",
  );
  assert.equal(text, "the summary");
  assert.equal(calls[0].cmd, "pi");
  // ephemeral, extensionless, toolless: must not pollute sessions or recurse
  for (const flag of ["--no-session", "--no-extensions", "--no-mcp", "-nt", "-p"]) {
    assert.ok(calls[0].args.includes(flag), `missing ${flag}`);
  }

  await assert.rejects(
    requestSummary(() => Promise.resolve({ stdout: "", stderr: "boom", code: 1 }), "p"),
    /boom/,
  );
  await assert.rejects(
    requestSummary(() => Promise.resolve({ stdout: "  \n", stderr: "", code: 0 }), "p"),
    /empty summary/,
  );
});

// --- panel summary block ---

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as never;

function panelWith(entries: Array<{ text: string; timestamp: string; sessionId: string }>) {
  return new HistoryPanel(entries, theme, undefined, { onClose: () => {}, onPick: () => {} });
}

test("panel: summary block renders below the list, wrapped and budgeted", () => {
  const p = panelWith([
    { text: "do a thing", timestamp: "2026-10-21", sessionId: "s" },
    { text: "another thing", timestamp: "2026-10-22", sessionId: "s" },
  ]);
  p.setSummary({ status: "ready", text: "Worked on things. Fixed the widget [1][2]." });
  const lines = p.render(80);
  assert.ok(lines.some((l) => l.includes("├─ summary")));
  assert.ok(lines.some((l) => l.includes("Worked on things.")));
  assert.ok(lines.some((l) => l.includes("[1][2].")));
});

test("panel: pending shows a placeholder; error surfaces the message", () => {
  const p = panelWith([{ text: "t", timestamp: "", sessionId: "s" }]);
  p.setSummary({ status: "pending" });
  let lines = p.render(80);
  assert.ok(lines.some((l) => l.includes("summarizing…")));

  p.setSummary({ status: "error", text: "pi exited 1" });
  lines = p.render(80);
  assert.ok(lines.some((l) => l.includes("summary failed: pi exited 1")));
});

test("panel: idle adds nothing; block respects the 28-line overlay budget", () => {
  // long prompt list + long summary must still fit in 28 lines
  const p = panelWith(Array.from({ length: 40 }, (_, i) => ({ text: `prompt ${i}`, timestamp: "", sessionId: "s" })));
  p.setSummary({ status: "ready", text: "word ".repeat(200) });
  const lines = p.render(80);
  assert.ok(lines.length <= 28, `got ${lines.length} lines`);
  assert.ok(lines.some((l) => l.includes("├─ summary")));

  const q = panelWith([{ text: "t", timestamp: "", sessionId: "s" }]);
  const bare = q.render(80);
  assert.ok(!bare.some((l) => l.includes("summary")));
});
