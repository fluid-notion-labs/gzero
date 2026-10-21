// Tests for history/summary.ts: transcript extraction with stable queue
// indices, prompt building (full and incremental), the per-session cache,
// and the ephemeral pi invocation; plus the panel's summary block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SUMMARY_TIMEOUT_MS } from "../history/summary.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryPanel } from "../history/panel.ts";
import { SPINNER_FRAMES } from "../items-pane.ts";
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

test("requestSummary: attaches the transcript file, caps runtime, cleans up", async () => {
  const calls: Array<{ cmd: string; args: string[]; opts?: { timeout?: number } }> = [];
  let fileArg = "";
  let sawFileDuringCall = false;
  const text = await requestSummary(
    (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      fileArg = args.find((a) => a.startsWith("@")) ?? "";
      sawFileDuringCall = readFileSync(fileArg.slice(1), "utf8").includes("summarize this");
      return Promise.resolve({ stdout: "  the summary \n", stderr: "", code: 0, killed: false });
    },
    "summarize this",
  );
  assert.equal(text, "the summary");
  assert.equal(calls[0].cmd, "pi");
  // ephemeral, extensionless, toolless: must not pollute sessions or recurse
  for (const flag of ["--no-session", "--no-extensions", "--no-mcp", "-nt", "-p"]) {
    assert.ok(calls[0].args.includes(flag), `missing ${flag}`);
  }
  // transcript travels via a temp file attachment, not as a giant argv
  assert.ok(fileArg.startsWith("@"), "prompt must be passed as @file");
  assert.ok(sawFileDuringCall, "file content must hold the prompt");
  assert.equal(calls[0].opts?.timeout, SUMMARY_TIMEOUT_MS);
  // temp dir is removed afterwards
  assert.throws(() => readFileSync(fileArg.slice(1), "utf8"));

  await assert.rejects(
    requestSummary(() => Promise.resolve({ stdout: "", stderr: "boom", code: 1, killed: false }), "p"),
    /boom/,
  );
  await assert.rejects(
    requestSummary(() => Promise.resolve({ stdout: "  \n", stderr: "", code: 0, killed: false }), "p"),
    /empty summary/,
  );
  await assert.rejects(
    requestSummary(() => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: true }), "p"),
    /timed out/,
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

test("panel: newlines in the summary become separate paragraph rows", () => {
  const p = panelWith([{ text: "t", timestamp: "", sessionId: "s" }]);
  p.setSummary({ status: "ready", text: "First section line here.\n  nested sub-point under it\nSecond section line." });
  const lines = p.render(80);
  assert.ok(lines.some((l) => l.includes("First section line here.")));
  assert.ok(lines.some((l) => l.includes("nested sub-point under it")));
  assert.ok(lines.some((l) => l.includes("Second section line.")));
  // three rows plus no blank-line padding: one line in, one row out
  const textLines = lines.filter((l) => l.includes("section line"));
  assert.equal(textLines.length, 2);
});

test("panel: a long summary list yields list rows but keeps the list floor", () => {
  const p = panelWith(Array.from({ length: 40 }, (_, i) => ({ text: `prompt ${i}`, timestamp: "", sessionId: "s" })));
  // 14 section lines: the list shrinks below WINDOW but not below the floor
  const summaryText = Array.from({ length: 14 }, (_, i) => `section ${i}: did some things [${i}]`).join("\n");
  p.setSummary({ status: "ready", text: summaryText });
  const lines = p.render(80);
  assert.ok(lines.length <= 28, `total ${lines.length} exceeds overlay budget`);
  const listRows = lines.filter((l) => l.includes("userMessageBg") || /prompt \d+/.test(l));
  assert.ok(listRows.length >= 10, `list shrank to ${listRows.length} rows`);
  // summary is cut at the cap, not the whole panel truncated
  assert.ok(lines.some((l) => l.includes("├─ summary")));
  assert.ok(lines.some((l) => l.includes("section 0:")));
});

test("panel: pending shows one animated spinner row; error surfaces the message", () => {
  const p = panelWith([{ text: "t", timestamp: "", sessionId: "s" }]);
  p.setSummary({ status: "pending" });
  let lines = p.render(80);
  const spinners = lines.filter((l) => SPINNER_FRAMES.some((f) => l.includes(` ${f}`)));
  assert.equal(spinners.length, 1);
  assert.ok(spinners[0].includes("summarizing…"));

  // Settling to ready stops the spinner (no spinner row, no timer).
  p.setSummary({ status: "ready", text: "done" });
  lines = p.render(80);
  assert.ok(!lines.some((l) => SPINNER_FRAMES.some((f) => l.includes(` ${f}`))));

  p.setSummary({ status: "error", text: "pi exited 1" });
  lines = p.render(80);
  assert.ok(lines.some((l) => l.includes("summary failed: pi exited 1")));
});

test("panel: spinner timer runs only while pending/stale, cleared on dispose", () => {
  const p = panelWith([{ text: "t", timestamp: "", sessionId: "s" }]);
  const s = p as unknown as { spinnerTimer: unknown; syncSpinner: () => void };
  p.setSummary({ status: "pending" });
  p.syncSpinner(); // no tui yet: no timer
  assert.equal(s.spinnerTimer, null);
  p.attach({ requestRender: () => {} } as never);
  p.syncSpinner();
  assert.notEqual(s.spinnerTimer, null);
  p.setSummary({ status: "ready", text: "x" });
  assert.equal(s.spinnerTimer, null);
  p.setSummary({ status: "stale", text: "old" });
  assert.notEqual(s.spinnerTimer, null);
  p.dispose();
  assert.equal(s.spinnerTimer, null);
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
