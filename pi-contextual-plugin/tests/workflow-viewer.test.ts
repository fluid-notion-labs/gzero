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

// Zero-padded 3-digit names so `line-3` can't substring-match `line-30`
// (the same collision was fixed independently on another machine).
test("window centers on load; scrolling slides it; switching re-centers", () => {
  const body = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
  const v = new WorkflowViewer(
    [page("a", body), page("b", body.slice())],
    theme as never,
    () => {},
  );
  v.handleInput("\x1b[B"); // scrolled before first render...
  v.handleInput("\x1b[B");
  v.handleInput("\x1b[B");
  // ...but the first render still centers: window opens in the middle
  let out = plain(v.render(60)).join("\n");
  assert.ok(out.includes("line-050"), "window opens centered, not at the scrolled offset");
  v.handleInput("\x1b[B"); // after render, scrolling slides the window
  out = plain(v.render(60)).join("\n");
  assert.ok(out.includes("line-051"), "scrolling slides the window");
  v.handleInput("\t"); // switch: window re-centers on the new tab
  out = plain(v.render(60)).join("\n");
  assert.ok(out.includes("line-050"), "window re-centers on tab switch");
  assert.ok(!out.includes("line-003"), "not the previously scrolled position");
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

test("flat tabs: one tab per page, full strip when it fits", () => {
  const v = new WorkflowViewer(
    [page("todo", ["row-a"]), page("architecture", ["sec-a"]), page("now", ["sec-b"])],
    theme as never,
    () => {},
  );
  const out = plain(v.render(120)).join("\n");
  for (const label of ["todo", "architecture", "now"]) {
    assert.ok(out.includes(label), `label ${label} visible when strip fits`);
  }
});

test("strip window keeps the active tab visible with many long labels", () => {
  const labels = ["todo", "architecture", "distributed-architecture-debt", "user-stories", "vision", "now", "decisions"];
  const v = new WorkflowViewer(
    labels.map((l, i) => page(l, [`body-${i}`])),
    theme as never,
    () => {},
  );
  // Active tab in the middle: strip must still show it.
  v.handleInput("\t");
  v.handleInput("\t");
  v.handleInput("\t");
  const active = labels[3];
  // 60 cols: neither the todo tab nor the later tabs fit alongside the
  // center, so both chevrons must appear.
  const out = plain(v.render(60)).join("\n");
  assert.ok(out.includes(active), "active tab visible in narrow strip");
  assert.ok(out.includes("‹"), "left chevron when tabs hidden");
  assert.ok(out.includes("›"), "right chevron when tabs hidden");
  // Strip stays within the width.
  const strip = out.split("\n").find((l) => l.includes(active))!;
  assert.ok(strip.replace(/\x1b\[[0-9;]*m/g, "").length <= 60, "strip fits the width");
});
