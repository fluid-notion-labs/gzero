// Tests for panel.ts: the bordered popup frame. The border rows and the
// body rows must all occupy exactly the same column count — a drifting
// corner is the bug this guards against.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HistoryPanel } from "../history/panel.ts";
import type { PromptEntry } from "../history/history.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI, "").length;

// The panel only calls theme.fg / theme.bg; a pass-through stub keeps the
// geometry assertions readable.
const theme = {
  fg: (_k: string, s: string) => s,
  bg: (_k: string, s: string) => s,
} as unknown as Theme;

function entries(n: number): PromptEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `prompt ${i + 1} of ${n}`,
    timestamp: `2026-10-15T${String(i % 24).padStart(2, "0")}:00:00Z`,
    sessionId: `s${i}`,
  }));
}

function panel(n: number): HistoryPanel {
  return new HistoryPanel(entries(n), theme, undefined, {
    onClose: () => {},
    onPick: () => {},
  });
}

function assertAligned(lines: string[]) {
  const widths = lines.map(visibleLen);
  assert.ok(widths.every((w) => w === widths[0]), `rows must share one width, got ${widths}`);
  assert.match(lines[0], /^┌─/);
  assert.match(lines[0], /┐$/);
  assert.match(lines[lines.length - 1], /^└─/);
  assert.match(lines[lines.length - 1], /┘$/);
  for (const line of lines.slice(1, -1)) {
    assert.match(line, /^│ /);
    assert.match(line, / │$/);
  }
}

test("border rows and body rows align at every width", () => {
  for (const width of [40, 80, 120]) {
    const lines = panel(5).render(width);
    assert.ok(lines.length >= 3, "at least top, one row, bottom");
    assertAligned(lines);
  }
});

test("one row per entry, selection marker on the newest", () => {
  const lines = panel(3).render(80);
  assert.equal(lines.length, 5); // top + 3 entries + bottom
  const newest = lines[3];
  assert.match(newest, /▸/);
  assert.match(newest, /prompt 3 of 3/);
  assert.doesNotMatch(lines[1], /▸/);
});

test("window caps visible rows; footer carries the scroll range", () => {
  const lines = panel(25).render(80);
  assert.equal(lines.length, 22); // top + 20-row window + bottom
  assert.match(lines[lines.length - 1], /6-25 of 25/);
  // newest is selected; the window scrolls so it is the last visible row
  const selected = lines.find((l) => l.includes("▸"));
  assert.ok(selected?.includes("prompt 25 of 25"));
});

test("empty history renders a framed empty state", () => {
  const lines = panel(0).render(80);
  assert.equal(lines.length, 3);
  assertAligned(lines);
  assert.match(lines[1], /no prompts yet/);
});

test("long entries clip inside the frame at narrow widths", () => {
  const long = new HistoryPanel(
    [{ text: "x".repeat(200), timestamp: "2026-10-15T00:00:00Z", sessionId: "s" }],
    theme,
    undefined,
    { onClose: () => {}, onPick: () => {} },
  );
  const lines = long.render(30);
  assertAligned(lines);
});
