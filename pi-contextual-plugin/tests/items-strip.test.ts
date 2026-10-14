// Tests for the tasks strip (items-pane.ts): timeline ordering, glyph
// states, spinner frames, and the terminal-height overflow cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ItemsPane, initialStripMode, stripGlyph, stripLines, stripOrder, SPINNER_FRAMES, type ItemRow } from "../items-pane.ts";

const row = (over: Partial<ItemRow>): ItemRow => ({
  id: "0000",
  title: "t",
  priority: 0,
  status: "open",
  blocked_by: [],
  depth: 0,
  created: 0,
  ...over,
});

test("strip order: closed at top, then in-progress, then open; oldest first within groups", () => {
  const ordered = stripOrder([
    row({ id: "a", status: "open", created: 30 }),
    row({ id: "b", status: "closed", created: 20 }),
    row({ id: "c", status: "in_progress", created: 10 }),
    row({ id: "d", status: "open", created: 5 }),
    row({ id: "e", status: "closed", created: 1 }),
  ]);
  assert.deepEqual(ordered.map((r) => r.id), ["e", "b", "c", "d", "a"]);
});

test("glyphs: ✓ dim for closed, ○ muted for open, ⊘ warning when blocked, spinner for in-progress", () => {
  assert.deepEqual(stripGlyph(row({ status: "closed" }), 0), { glyph: "✓", color: "dim" });
  assert.deepEqual(stripGlyph(row({ status: "open" }), 0), { glyph: "○", color: "muted" });
  assert.deepEqual(stripGlyph(row({ status: "open", blocked_by: ["1"] }), 0), { glyph: "⊘", color: "warning" });
  const spin = stripGlyph(row({ status: "in_progress" }), 0);
  assert.equal(spin.color, "accent");
  assert.ok(SPINNER_FRAMES.includes(spin.glyph));
});

test("spinner cycles through frames and negative frames wrap", () => {
  assert.equal(stripGlyph(row({ status: "in_progress" }), 0).glyph, SPINNER_FRAMES[0]);
  assert.equal(stripGlyph(row({ status: "in_progress" }), 1).glyph, SPINNER_FRAMES[1]);
  assert.equal(stripGlyph(row({ status: "in_progress" }), SPINNER_FRAMES.length).glyph, SPINNER_FRAMES[0]);
  assert.equal(stripGlyph(row({ status: "in_progress" }), -1).glyph, SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
});

test("strip cells: one glyph per task in timeline order", () => {
  const cells = stripLines(
    [row({ id: "a", status: "open", created: 2 }), row({ id: "b", status: "closed", created: 1 }), row({ id: "c", status: "in_progress" })],
    { frame: 0, cap: 10 },
  );
  assert.deepEqual(cells.map((c) => c.glyph), ["✓", SPINNER_FRAMES[0], "○"]);
  assert.deepEqual(cells.map((c) => c.color), ["dim", "accent", "muted"]);
});

test("overflow drops from the top (past) and marks it with ⋮", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ id: String(i), status: "open", created: i }));
  const cells = stripLines(rows, { frame: 0, cap: 4 });
  assert.equal(cells.length, 4);
  assert.deepEqual(cells[0], { glyph: "⋮", color: "dim" });
  // Newest survive at the bottom: tasks 7..9.
  assert.deepEqual(cells.slice(1).map((c) => c.glyph), ["○", "○", "○"]);
  // Exact fit: no overflow marker.
  assert.equal(stripLines(rows, { frame: 0, cap: 10 }).length, 10);
  assert.deepEqual(stripLines(rows, { frame: 0, cap: 10 })[0], { glyph: "○", color: "muted" });
});

test("pane renders the strip one glyph per line, in strip mode only", () => {
  const pane = new ItemsPane();
  pane.mode = "strip";
  pane.rows = [row({ id: "a", status: "open" }), row({ id: "b", status: "in_progress" })];
  const theme = { fg: (_c: string, s: string) => s } as never;
  (pane as unknown as { theme: unknown }).theme = theme;
  const lines = pane.render(40);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length === 1));
  // Panel mode renders the framed sidebar, not glyphs.
  pane.mode = "panel";
  const panel = pane.render(60);
  assert.ok(panel.length > 2 && panel.some((l) => l.includes("tasks")));
});

test("CX_TASKS_STRIP=0 forces panel mode", () => {
  assert.equal(initialStripMode({}), "strip");
  assert.equal(initialStripMode({ CX_TASKS_STRIP: "0" }), "panel");
  assert.equal(initialStripMode({ CX_TASKS_STRIP: "1" }), "strip");
});

test("empty strip stays visible with a quiet placeholder", () => {
  const pane = new ItemsPane();
  pane.mode = "strip";
  const theme = { fg: (_c: string, s: string) => s } as never;
  (pane as unknown as { theme: unknown }).theme = theme;
  const lines = pane.render(40);
  assert.deepEqual(lines, ["·"]);
});
