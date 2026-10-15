// Tests for ledger.ts: JSONL append shape, usage mapping, disabled mode,
// and that write failures never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, toUsageRecord } from "../ledger.ts";

test("append writes one JSON object per line with a timestamp", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  const ledger = new Ledger(path);
  ledger.append({ kind: "route", workType: "plan" });
  ledger.append({ kind: "dispatch", ok: true });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(first.kind, "route");
  assert.equal(first.workType, "plan");
  assert.match(first.ts as string, /^\d{4}-\d{2}-\d{2}T/);
});

test("toUsageRecord maps the pi Usage shape", () => {
  const record = toUsageRecord({
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 3,
    reasoning: 7,
    totalTokens: 120,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
  } as never);
  assert.deepEqual(record, {
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 3,
    total: 120,
    reasoning: 7,
    costTotal: 3.3,
  });
  assert.equal(toUsageRecord(undefined), undefined);
});

test("null path disables writing", () => {
  const ledger = new Ledger(null);
  ledger.append({ kind: "route" }); // must not throw
});

test("write failures are swallowed", () => {
  const ledger = new Ledger("/proc/nonexistent-dir/ledger.jsonl");
  ledger.append({ kind: "route" }); // must not throw
});
