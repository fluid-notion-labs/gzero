// Tests for the tasks strip (items-pane.ts): timeline ordering, glyph
// states, spinner frames, and the terminal-height overflow cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ItemsPane,
  initialStripMode,
  stripBoxWidth,
  stripCurrent,
  stripGlyph,
  stripLabel,
  stripLines,
  stripOrder,
  taskRowCap,
  SPINNER_FRAMES,
  STRIP_LABEL_MAX,
  type ItemRow,
} from "../items-pane.ts";

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

test("strip cells: one glyph per task in timeline order, tagged with row ids", () => {
  const cells = stripLines(
    [row({ id: "a", status: "open", created: 2 }), row({ id: "b", status: "closed", created: 1 }), row({ id: "c", status: "in_progress" })],
    { frame: 0, cap: 10 },
  );
  assert.deepEqual(cells.map((c) => c.glyph), ["✓", SPINNER_FRAMES[0], "○"]);
  assert.deepEqual(cells.map((c) => c.color), ["dim", "accent", "muted"]);
  assert.deepEqual(cells.map((c) => c.id), ["b", "c", "a"]);
})

const overflowRows = Array.from({ length: 10 }, (_, i) =>
  row({ id: String(i), status: "open", created: i }),
);

test("overflow marker cell has no row id", () => {
  const cells = stripLines(overflowRows, { frame: 0, cap: 4 });
  assert.equal(cells[0].id, "");
  assert.deepEqual(cells.slice(1).map((c) => c.id), ["7", "8", "9"]);
})

test("strip label: first 3 words of the title, ellipsis when truncated, capped to max width", () => {
  assert.equal(stripLabel("short"), "short");
  assert.equal(stripLabel("one two three"), "one two three");
  assert.equal(stripLabel("one two three four five"), "one two three…");
  // A long third word is truncated to the reserved width, ellipsis kept.
  const long = stripLabel("one two supercalifragilisticexpialidocious");
  assert.ok(long.length <= STRIP_LABEL_MAX);
  assert.ok(long.endsWith("…"));
  assert.ok(long.startsWith("one two "));
  assert.equal(stripLabel("   "), "");
})

test("strip current: first in-progress in strip order; null when none", () => {
  const rows = [
    row({ id: "a", status: "open", created: 30 }),
    row({ id: "b", status: "in_progress", created: 20 }),
    row({ id: "c", status: "in_progress", created: 10 }),
  ];
  assert.equal(stripCurrent(rows)?.id, "c"); // oldest in-progress wins
  assert.equal(stripCurrent([row({ id: "x", status: "open" })]), null);
  assert.equal(stripCurrent([]), null);
  // A blocked in-progress item still counts as current.
  assert.equal(stripCurrent([row({ id: "z", status: "in_progress", blocked_by: ["1"] })])?.id, "z");
})

test("strip box width: 5 glyph-only, 23 with the label reserved", () => {
  assert.equal(stripBoxWidth(false), 5);
  assert.equal(stripBoxWidth(true), 3 + STRIP_LABEL_MAX + 2);
})

test("pane stripWidth follows the rows: wide with an in-progress item, 5 without", () => {
  const pane = new ItemsPane();
  pane.rows = [row({ id: "a", status: "open" })];
  assert.equal(pane.stripWidth(), 5);
  pane.rows = [row({ id: "a", status: "in_progress" })];
  assert.equal(pane.stripWidth(), stripBoxWidth(true));
  pane.rows = [];
  assert.equal(pane.stripWidth(), 5);
});

test("overflow drops from the top (past) and marks it with ⋮", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ id: String(i), status: "open", created: i }));
  const cells = stripLines(rows, { frame: 0, cap: 4 });
  assert.equal(cells.length, 4);
  assert.deepEqual(cells[0], { glyph: "⋮", color: "dim", id: "" });
  // Newest survive at the bottom: tasks 7..9.
  assert.deepEqual(cells.slice(1).map((c) => c.glyph), ["○", "○", "○"]);
  // Exact fit: no overflow marker.
  assert.equal(stripLines(rows, { frame: 0, cap: 10 }).length, 10);
  assert.deepEqual(stripLines(rows, { frame: 0, cap: 10 })[0], { glyph: "○", color: "muted", id: "0" });
});

test("strip renders the current item's label beside its glyph; glyph-only otherwise", () => {
  const pane = new ItemsPane();
  pane.mode = "strip";
  pane.rows = [row({ id: "a", status: "open" }), row({ id: "b", title: "fix the strip now", status: "in_progress" })];
  const theme = { fg: (_c: string, s: string) => s } as never;
  (pane as unknown as { theme: unknown }).theme = theme;
  const lines = pane.render(40);
  const label = stripLabel("fix the strip now"); // "fix the strip…"
  const inner = 3 + STRIP_LABEL_MAX;
  // Timeline order: in-progress above open; the label rides the spinner row.
  assert.deepEqual(lines, [
    "╭" + "─".repeat(inner) + "╮",
    "│ " + SPINNER_FRAMES[0] + " " + label + " ".repeat(STRIP_LABEL_MAX - label.length) + "│",
    // Slot right-padding (1) + label width fill (STRIP_LABEL_MAX).
    "│ ○" + " ".repeat(STRIP_LABEL_MAX + 1) + "│",
    "╰" + "─".repeat(inner) + "╯",
  ]);
  assert.ok(lines.every((l) => l.length === stripBoxWidth(true)));

  // No in-progress item: back to the skinny glyph-only rail.
  pane.rows = [row({ id: "a", status: "open" })];
  const skinny = pane.render(40);
  assert.deepEqual(skinny, ["╭───╮", "│ ○ │", "╰───╯"]);
  assert.ok(skinny.every((l) => l.length === 5));
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

test("empty strip stays visible: bordered rail with a quiet placeholder", () => {
  const pane = new ItemsPane();
  pane.mode = "strip";
  const theme = { fg: (_c: string, s: string) => s } as never;
  (pane as unknown as { theme: unknown }).theme = theme;
  const lines = pane.render(40);
  assert.deepEqual(lines, ["╭───╮", "│ · │", "╰───╯"]);
});

test("panel and strip cap task rows to leave 2+ lines of chat", () => {
  // taskRowCap: terminal rows minus headroom, floored at 1.
  assert.equal(taskRowCap(20), 14);
  assert.equal(taskRowCap(undefined), 34);
  assert.equal(taskRowCap(3), 1);

  // Panel render: many rows are cut to the cap, with a +N more line.
  const origRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
  try {
    const pane = new ItemsPane();
    pane.mode = "panel";
    pane.rows = Array.from({ length: 30 }, (_, i) =>
      row({ id: String(i), status: "open", created: i }),
    );
    const theme = { fg: (_c: string, s: string) => s } as never;
    (pane as unknown as { theme: unknown }).theme = theme;
    const lines = pane.render(60);
    const taskLines = lines.filter((l) => l.includes("○"));
    assert.equal(taskLines.length, 14);
    assert.ok(lines.some((l) => l.includes("+16 more")));

    // Strip on the same terminal: same row count as the panel's tasks.
    pane.mode = "strip";
    const strip = pane.render(40);
    assert.equal(strip.length, 14 + 2); // cells + borders
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true });
  }
});
