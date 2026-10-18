// Tests for filler.ts. The filtered examples are real prompts mined from
// this machine's pi sessions; the kept examples are real prompts that must
// stay visible despite looking similar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFiller } from "../history/filler.ts";

const FILTERED = [
  "continue",
  "yep",
  "yep! thanks",
  "yes plz",
  "yes  plz",
  "yes please",
  "OK, TRY NOW",
  "lets go",
  "lets go!",
  "ok lets go",
  "ok, lets go then",
  "ok, go",
  "go",
  "ok, continue plz",
  "ok, continue. it all looks good!",
  "ok, looks good. continue",
  "ok, looks good!. continue",
  "ok, lets do this",
  "ok, so done?",
  "so, is this done?",
  "try now",
  "hello",
  "hello?",
  "ooh, thats nice",
  "v nice btw. thank you",
  "purrfect",
  "sweet, thanks!",
  "lets continue with this plz",
  ":D",
];

const KEPT = [
  "ok, 9463", // digits carry content
  "ok, is there 2 now?", // a real question
  "ls", // a real command
  "push",
  "merge them plz?",
  "ok, can we fold into main and push?",
  "salad", // all letters live in mash-adjacent keys but no mash run
  "lets build it!",
  "lets implement the plan plz",
  "research plz",
  "nah, i do not like that....", // real feedback
  "woops, wrong session :D", // has content
  "yup, its the font.", // real answer
  "proud much?", // banter with content
  "test headless, continue", // real instruction
];

test("real filler prompts are filtered", () => {
  for (const p of FILTERED) assert.equal(isFiller(p), true, p);
});

test("real content prompts survive", () => {
  for (const p of KEPT) assert.equal(isFiller(p), false, p);
});

test("keyboard mash is filtered", () => {
  assert.equal(isFiller("asdf"), true);
  assert.equal(isFiller("asdfas"), true);
  assert.equal(isFiller("asdlfkjasdf"), true);
});

test("empty prompt counts as filler", () => {
  assert.equal(isFiller(""), true);
  assert.equal(isFiller("   "), true);
});
