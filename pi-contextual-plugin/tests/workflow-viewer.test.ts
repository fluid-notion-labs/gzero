// Tests for the Ctrl+W tabbed viewer (workflow-viewer.ts): tab switching,
// per-tab scroll state, and both body builders (items tree, sections).
import { test } from "node:test";
import assert from "node:assert/strict";
const stripVTControlCodes = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
import {
  WorkflowViewer,
  buildItemBody,
  buildSectionBody,
  type WorkflowPage,
} from "../workflow-viewer.ts";
import type { FlatRow, RawItem } from "../items-tree.ts";

// Minimal stub theme: pass text through, enough for render().
const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

const item = (over: Partial<RawItem>): RawItem => ({
  id: "xxxx",
  title: "t",
  priority: 0,
  status: "open",
  assignee: "",
  labels: [],
  blocked_by: [],
  blocks: [],
  child_of: [],
  notes: {},
  created: 0,
  ...over,
});

const flat = (it: RawItem, depth: number): FlatRow => ({ item: it, depth });

const page = (label: string, body: string[]): WorkflowPage => ({
  label,
  build: () => body,
});

const plain = (lines: string[]): string[] =>
  lines.map((l) => stripVTControlCodes(l));

test("renders tabs along the top with the active one visible", () => {
  const v = new WorkflowViewer(
    [page("items", ["row-a"]), page("workflow", ["sec-a"])],
    theme as never,
    () => {},
  );
  const out = plain(v.render(60));
  assert.ok(out.some((l) => l.includes("items") && l.includes("workflow")));
});

test("tab / shift+tab switch tabs (forward and backward, wrapping)", () => {
  let tab = -1;
  const v = new WorkflowViewer(
    [page("items", ["row-a"]), page("workflow", ["sec-a"])],
    theme as never,
    () => {},
  );
  v.handleInput("\t"); // tab → next
  const out1 = plain(v.render(60)).join("\n");
  assert.ok(out1.includes("sec-a"));
  v.handleInput("\x1b[Z"); // shift+tab → previous (wraps to items)
  assert.ok(plain(v.render(60)).join("\n").includes("row-a"));
  v.handleInput("\x1b[Z"); // backward again wraps to last tab
  assert.ok(plain(v.render(60)).join("\n").includes("sec-a"));
  assert.notEqual(tab, 0);
});

test("left/right arrows also switch tabs", () => {
  const v = new WorkflowViewer(
    [page("items", ["row-a"]), page("workflow", ["sec-a"])],
    theme as never,
    () => {},
  );
  v.handleInput("\x1b[C"); // right
  assert.ok(plain(v.render(60)).join("\n").includes("sec-a"));
  v.handleInput("\x1b[D"); // left
  assert.ok(plain(v.render(60)).join("\n").includes("row-a"));
});

test("per-tab scroll resets on switch; window re-centers (sliding window)", () => {
  // Zero-padded 3-digit names: `line-3` is a substring of `line-30`,
  // which made these assertions collide with whatever else was on screen.
  // The body is long enough that the scrolled position and the re-centered
  // window don't overlap.
  const body = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
  const v = new WorkflowViewer(
    [page("a", body), page("b", body.slice())],
    theme as never,
    () => {},
  );
  v.render(60); // open: cache built, window centered
  for (let i = 0; i < 30; i++) v.handleInput("\x1b[B"); // slide well past center
  let out = plain(v.render(60)).join("\n");
  assert.ok(out.includes("line-070"));
  v.handleInput("\t"); // switch: window re-centers on the new tab
  out = plain(v.render(60)).join("\n");
  assert.ok(!out.includes("line-000"), "not pinned to the top");
  assert.ok(!out.includes("line-070"), "not the previously scrolled position");
  assert.ok(/line-\d+/.test(out), "window shows middle content");
});

test("done fires on escape and q", () => {
  let closed = 0;
  const v = new WorkflowViewer(
    [page("a", ["x"])],
    theme as never,
    () => {
      closed++;
    },
  );
  v.handleInput("q");
  v.handleInput("\x1b");
  assert.equal(closed, 2);
});

test("buildItemBody indents child rows two spaces per depth", () => {
  const rows = [
    flat(item({ id: "p1", title: "parent" }), 0),
    flat(item({ id: "c1", title: "child" }), 1),
    flat(item({ id: "g1", title: "grand" }), 2),
  ];
  const out = plain(buildItemBody(rows, 80, theme as never));
  // row format: <indent><glyph> <title> <id> <priority>
  assert.match(out[0], /○ parent p1/);
  assert.match(out[1], /  ○ child c1/);
  assert.match(out[2], /    ○ grand g1/);
});

test("buildItemBody marks blocked items with ⊘", () => {
  const rows = [flat(item({ id: "b1", title: "held", blocked_by: ["zz"] }), 0)];
  const out = plain(buildItemBody(rows, 80, theme as never));
  assert.match(out[0], /⊘/);
});

test("buildSectionBody lays out titled dividers and keeps body indentation", () => {
  const out = plain(
    buildSectionBody(
      [
        {
          nodes: [
            {
              label: "plan ☑",
              text: "Now\n- top\n  - nested\n  ☐ task",
            },
          ],
        },
      ],
      60,
      theme as never,
    ),
  );
  assert.ok(out.some((l) => l.includes("── plan ☑")));
  assert.ok(out.some((l) => l.includes("Now")));
  // one-space viewer gutter + wrapPlain's preserved two-space indent
  assert.ok(out.some((l) => l.includes("   - nested")));
  assert.ok(out.some((l) => l.includes("☐ task")));
});
