// Tests for wrapPlain (window.ts): line wrapping must preserve the
// leading indentation of each line — task-list lines like `  - [ ] child`
// were losing their indent because wrapping split on /\s+/ and rejoined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapPlain } from "../window.ts";

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
