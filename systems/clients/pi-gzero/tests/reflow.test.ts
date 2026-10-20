// Tests for reflowMarkdown (reflow.ts): hard-wrapped markdown
// prose re-flows to the pane width; structural lines keep their shape.
// textDetail is the gzero panel's use of it (section/tier details).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reflowMarkdown } from "../reflow.ts";
import { textDetail } from "../gzero-panel.ts";
import { wrapPlain } from "../window.ts";

test("hard-wrapped prose joins into one paragraph and re-wraps", () => {
  const md = "The umbrella architecture: the whole\nsystem, of which gzero is\none subsystem.";
  const out = reflowMarkdown(md);
  assert.equal(out, "The umbrella architecture: the whole system, of which gzero is one subsystem.");
  // at width 40 it re-wraps to multiple lines
  assert.equal(wrapPlain(out, 40).length, 2);
});

test("headings, lists, and blank lines stay put", () => {
  const md = "## Status\n\n- item one\n- item two\n\nText continues\nacross lines.";
  assert.equal(
    reflowMarkdown(md),
    "## Status\n\n- item one\n- item two\n\nText continues across lines.",
  );
});

test("indented list continuations are not merged into prose", () => {
  const md = "- a list item\n  with a wrapped\n  continuation\nfollowed by prose\nthat reflows";
  assert.equal(
    reflowMarkdown(md),
    "- a list item\n  with a wrapped\n  continuation\nfollowed by prose that reflows",
  );
});

test("fenced code blocks pass through untouched", () => {
  const md = "intro text\nwrapped here\n```\nkeep   this\n  exactly\n```\nmore prose\nhere";
  assert.equal(
    reflowMarkdown(md),
    "intro text wrapped here\n```\nkeep   this\n  exactly\n```\nmore prose here",
  );
});

test("table rows are preserved for renderTables", () => {
  const md = "before\n| a | b |\n|---|---|\n| 1 | 2 |\nafter\nthe wrap";
  assert.ok(reflowMarkdown(md).includes("| a | b |"));
});

test("panel textDetail reflows a hard-wrapped body to full width", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const detail = textDetail("one two three four\nfive six seven");
  const lines = detail(60, theme as never);
  const body = lines.find((l) => l.includes("one two three four"));
  assert.ok(body!.includes("five six seven"), "paragraph reflowed onto one line");
});
