// Tests for wrapPlain (window.ts): line wrapping must preserve the
// leading indentation of each line — task-list lines like `  - [ ] child`
// were losing their indent because wrapping split on /\s+/ and rejoined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LineWindow, scrollIndicator, wrapPlain } from "../window.ts";

test("basic wrapping", () => {
  assert.deepEqual(wrapPlain("one two three four five six seven", 9), [
    "one two",
    "three",
    "four five",
    "six seven",
  ]);
});

test("blank lines preserved", () => {
  assert.deepEqual(wrapPlain("a\n\nb", 20), ["a", "", "b"]);
});

test("leading indentation kept on task-list style lines", () => {
  assert.deepEqual(wrapPlain("- [ ] parent\n  - [ ] child one\n  - [ ] child two", 40), [
    "- [ ] parent",
    "  - [ ] child one",
    "  - [ ] child two",
  ]);
});

test("long indented line wraps with the indent preserved on continuation lines", () => {
  assert.deepEqual(wrapPlain("    alpha beta gamma", 10), [
    "    alpha",
    "    beta",
    "    gamma",
  ]);
});

test("overly long single word is not broken, keeps indent", () => {
  assert.deepEqual(wrapPlain("  supercalifragilistic", 8), [
    "  supercalifragilistic",
  ]);
});

test("wide characters wrap by display column, not string length", () => {
  // Each CJK char is 2 columns: "你好世界" is 8 columns wide, not 4 chars.
  // Words are not broken; 4-char words measure 8 columns so each wraps.
  assert.deepEqual(wrapPlain("你好 世界 深呼吸", 6), [
    "你好",
    "世界",
    "深呼吸",
  ]);
});

test("renderFixed pads short content to a constant viewport height", () => {
  const w = new LineWindow(5);
  w.setLines(["a", "b"]);
  const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  assert.deepEqual(w.renderFixed(10).map(plain), ["a", "b", "", "", ""]);

  // Scrollable content: padded rows carry the empty scrollbar track.
  const w2 = new LineWindow(3);
  w2.setLines(["a", "b", "c", "d", "e"]);
  const rows = w2.renderFixed(10);
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((r) => /[│▐]$/.test(r.replace(/\x1b\[[0-9;]*m/g, ""))),
    "scrollbar track or thumb on every row",
  );
});

test("scrollIndicator: ↓ only while content below, ↑ only when scrolled, fixed slot", () => {
  const theme = { fg: (_c: string, s: string) => s } as never;
  const w = new LineWindow(3);
  w.setLines(["a", "b", "c", "d", "e"]);
  assert.equal(scrollIndicator(w, theme), " ↓ "); // top: nothing above, more below
  w.scrollBy(1);
  assert.equal(scrollIndicator(w, theme), "↑↓ "); // middle: both
  w.scrollToEnd();
  assert.equal(scrollIndicator(w, theme), "↑  "); // end: nothing below

  // Short content: nothing to indicate, but the slot stays two cells.
  const w2 = new LineWindow(3);
  w2.setLines(["a", "b"]);
  assert.equal(scrollIndicator(w2, theme), "   ");
});
