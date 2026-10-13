// Tests for renderTables (workflow-viewer.ts): markdown tables in
// section bodies render as aligned plain text instead of raw pipes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTables } from "../workflow-viewer.ts";

test("table becomes aligned columns with a rule under the header", () => {
  const out = renderTables(
    [
      "before",
      "",
      "| plane | scope |",
      "|---|---|",
      "| global | all projects |",
      "| local | this project |",
      "",
      "after",
    ].join("\n"),
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "before");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^plane {3,}scope/);
  assert.match(lines[3], /^─+ {2,}─+$/);
  assert.equal(lines[4], "global  all projects");
  assert.equal(lines[5], "local   this project");
  assert.equal(lines[6], "");
  assert.equal(lines[7], "after");
});

test("separator row with alignment markers is dropped", () => {
  const out = renderTables("| a | b |\n|:--|--:|\n| 1 | 2 |");
  assert.equal(out.split("\n").length, 3);
  assert.ok(!out.includes("---"));
});

test("non-table lines pass through unchanged", () => {
  const md = "## Heading\n- bullet one\n  - nested\n| not a table";
  assert.equal(renderTables(md), md); // unterminated row: left alone
});

test("cells are trimmed and ragged rows padded to the widest", () => {
  const out = renderTables("| longheader | x |\n|---|---|\n| short |  |");
  const [head, rule, row] = out.split("\n");
  assert.equal(head, "longheader  x");
  assert.equal(rule, "──────────  ─");
  assert.equal(row, "short");
});

test("empty table collapses to nothing", () => {
  const out = renderTables("text\n|---|---|\nmore");
  assert.equal(out, "text\nmore");
});
