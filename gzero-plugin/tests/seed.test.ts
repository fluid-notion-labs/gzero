// Tests for seed.ts: span extraction from rendered rust output, tail
// capping on line boundaries, and the brief's required sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../router/config.ts";
import { OUTPUT_CAP, buildSeed, capTail, extractSpans, spanPaths } from "../router/seed.ts";

const rustOutput = `error[E0308]: mismatched types
  --> src/storage/lattice.rs:214:9
   |
214 |     let x: u32 = tree;
   |                  ^^^^ expected u32, found Tree

warning: unused variable: 'y'
  --> src/sync/hub.rs:88:5

error: could not compile \`gzero\` (bin "cx-mcp") due to 1 previous error`;

test("extractSpans finds rust --> spans with line and column, deduped in order", () => {
  const spans = extractSpans(rustOutput);
  assert.deepEqual(spans, [
    { path: "src/storage/lattice.rs", line: 214, column: 9 },
    { path: "src/sync/hub.rs", line: 88, column: 5 },
  ]);
});

test("extractSpans returns [] for output without spans", () => {
  assert.deepEqual(extractSpans("panic: something broke"), []);
});

test("spanPaths dedupes across repeated diagnostics", () => {
  const doubled = rustOutput + "\n  --> src/storage/lattice.rs:214:9";
  assert.deepEqual(spanPaths(extractSpans(doubled)), ["src/storage/lattice.rs", "src/sync/hub.rs"]);
});

test("capTail keeps the end and starts on a line boundary", () => {
  const text = "line1\nline2\nline3";
  assert.equal(capTail(text, 100), text);
  const capped = capTail(text, 10); // "line2\nline3" fits, "e2\nline3\n"? 10 chars = "line2\nline" -> boundary
  assert.equal(capped.startsWith("line"), true);
  assert.equal(capped.endsWith("line3"), true);
});

test("capTail under the cap is untouched", () => {
  assert.equal(capTail("short", OUTPUT_CAP), "short");
});

test("buildSeed contains role, work type, output block, referenced paths, rules", () => {
  const seed = buildSeed({
    workType: "fix-errors",
    recentOutput: rustOutput,
    cwd: "/repo",
    config: DEFAULT_CONFIG,
    taskStatement: "The build is broken after the lattice refactor.",
  });
  assert.match(seed, /Work type: fix-errors/);
  assert.match(seed, /Fix the errors shown below/);
  assert.match(seed, /The build is broken after the lattice refactor\./);
  assert.match(seed, /<output>/);
  assert.match(seed, /E0308/);
  assert.match(seed, /- src\/storage\/lattice\.rs/);
  assert.match(seed, /- src\/sync\/hub\.rs/);
  assert.match(seed, /read,grep,find,ls,edit,write/); // subagent tools from config
  assert.match(seed, /@cf\/qwen\/qwen3-30b-a3b-fp8/); // blessed model for fix-errors
  assert.match(seed, /structured summary/);
});

test("buildSeed omits the locations section when nothing parsed", () => {
  const seed = buildSeed({
    workType: "easy-codefix",
    recentOutput: "no diagnostics here",
    cwd: "/repo",
    config: DEFAULT_CONFIG,
  });
  assert.doesNotMatch(seed, /Locations referenced/);
  assert.match(seed, /Make the small, obvious change/);
});

test("buildSeed caps huge outputs to OUTPUT_CAP", () => {
  const huge = "z".repeat(OUTPUT_CAP * 2);
  const seed = buildSeed({ workType: "fix-errors", recentOutput: huge, cwd: "/repo", config: DEFAULT_CONFIG });
  const match = seed.match(/<output>\n([\s\S]*?)\n<\/output>/);
  assert.ok(match);
  assert.ok(match![1].length <= OUTPUT_CAP);
});
