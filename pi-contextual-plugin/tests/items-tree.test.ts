// Prove-it tests for the Ctrl+W work items viewer's tree logic
// (items-tree.ts, fed by `cx item list --json`).
//
// The reported bug: Ctrl+W froze/crashed pi. The viewer builds a
// parent/child tree from `child_of` edges with unchecked recursion, so a
// cycle in the edges (A child of B, B child of A, or an item parenting
// itself) recurses until the stack overflows. These tests pin the
// contract: every input terminates, every item appears exactly once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildItemTree, flattenTree, type RawItem } from "../items-tree.ts";

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

test("real bag data (16 items) flattens exactly once per item", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./fixtures/items-real.json", import.meta.url), "utf8"),
  ) as RawItem[];
  assert.ok(raw.length > 0, "fixture must not be empty");
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, raw.length, "one row per item");
  assert.equal(new Set(rows.map((r) => r.item.id)).size, raw.length, "no duplicates");
});

test("child_of cycle terminates (a child of b, b child of a)", () => {
  const raw = [
    item({ id: "aaaa", title: "a", child_of: ["bbbb"] }),
    item({ id: "bbbb", title: "b", child_of: ["aaaa"] }),
  ];
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.item.id)).size, 2);
});

test("self-parent terminates", () => {
  const raw = [item({ id: "aaaa", child_of: ["aaaa"] })];
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depth, 0);
});

test("longer cycle terminates: back-edge dropped, chain kept", () => {
  const raw = [
    item({ id: "aaaa", child_of: ["cccc"] }),
    item({ id: "bbbb", child_of: ["aaaa"] }),
    item({ id: "cccc", child_of: ["bbbb"] }),
  ];
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, 3, "all three visible");
  assert.equal(new Set(rows.map((r) => r.item.id)).size, 3, "each exactly once");
  // a→b→c are real edges; only a's cyclic back-edge into c is dropped, so
  // the chain renders as a proper hierarchy rooted at a.
  const byId = new Map(rows.map((r) => [r.item.id, r.depth]));
  assert.equal(byId.get("aaaa"), 0);
  assert.equal(byId.get("bbbb"), 1);
  assert.equal(byId.get("cccc"), 2);
});

test("dangling child_of (parent not in list) renders as root", () => {
  const raw = [item({ id: "aaaa", child_of: ["zzzz"] })];
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depth, 0);
});

test("diamond (two parents) renders the shared child exactly once", () => {
  const raw = [
    item({ id: "root", child_of: [] }),
    item({ id: "left", child_of: ["root"] }),
    item({ id: "right", child_of: ["root"] }),
    item({ id: "base", child_of: ["left", "right"] }),
  ];
  const rows = flattenTree(buildItemTree(raw));
  assert.equal(rows.length, 4, "no duplication");
  assert.equal(new Set(rows.map((r) => r.item.id)).size, 4);
});
