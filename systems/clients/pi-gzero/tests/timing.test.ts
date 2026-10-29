// timing.ts — nested span traces render as a table, merge repeats.
import test from "node:test";
import assert from "node:assert/strict";
import { startTrace, span, timingReport, clearTimingReport } from "../timing.ts";

test("nested spans render as an indented table", async () => {
  const t = startTrace("startup");
  await span("outer", async () => {
    span("inner", () => 1 + 1);
  });
  const out = t.finish();
  const lines = out.split("\n");
  assert.ok(lines[0].startsWith("startup [total"));
  assert.match(out, /└─ outer/);
  assert.match(out, /└─ inner/);
  // children indent one level under their parent
  const outer = lines.findIndex((l) => l.includes("outer"));
  const inner = lines.findIndex((l) => l.includes("inner"));
  assert.ok(inner > outer);
});

test("repeated sibling names merge into one row with a call count", () => {
  const t = startTrace("loop");
  for (let i = 0; i < 3; i++) span("page", () => i);
  const out = t.finish();
  assert.match(out, /×3/);
  assert.equal(out.split("\n").filter((l) => l.includes("page")).length, 1);
});

test("spans outside a trace are free", () => {
  assert.equal(span("nothing", () => 42), 42);
});

test("print below minMs stays silent", () => {
  const t = startTrace("quiet");
  span("fast", () => 0);
  // Below the threshold: the trace closes without entering the buffer
  // (the next startTrace sees no abandoned one).
  t.print("quiet", 60_000);
  const t2 = startTrace("after");
  assert.ok(t2.finish().startsWith("after"));
});

test("print records into the ring buffer; report shows the last N", () => {
  clearTimingReport();
  const t1 = startTrace("first");
  t1.print("first label");
  const t2 = startTrace("second");
  t2.print("second label");
  const report = timingReport(1);
  assert.match(report, /second label/);
  assert.doesNotMatch(report, /first label/);
  assert.match(timingReport(5), /first label/);
  clearTimingReport();
  assert.equal(timingReport(), "no timings recorded yet");
});

test("async spans measure to settlement", async () => {
  const t = startTrace("async");
  await t.span("sleep", async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
  const out = t.finish();
  assert.match(out, /sleep .*2[0-9]\.[0-9]ms/);
  // Sole child of the root: ~100% of the trace total, minus the
  // timer's own bookkeeping between spans.
  const pct = out.match(/(\d+)%/);
  assert.ok(pct && Number(pct[1]) >= 95, `share of parent: ${out}`);
});
