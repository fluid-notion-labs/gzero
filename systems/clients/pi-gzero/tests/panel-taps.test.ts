// Tests for the backtick tap state machine (panel-taps.ts): trigger
// selection from the environment, the hold-and-flush sequences, and
// flush-on-other-key semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TapCounter, TAP_WINDOW_MS, tapTrigger } from "../panel-taps.ts";

test("tapTrigger: CX_PANEL_TAPS=2|3|0, default 2", () => {
  assert.equal(tapTrigger({}), 2);
  assert.equal(tapTrigger({ CX_PANEL_TAPS: "3" }), 3);
  assert.equal(tapTrigger({ CX_PANEL_TAPS: "0" }), 0);
  assert.equal(tapTrigger({ CX_PANEL_TAPS: "garbage" }), 2);
});

test("trigger 2: double tap opens immediately, backticks swallowed", () => {
  const c = new TapCounter(2);
  assert.equal(c.tap(), null); // first tap buffers
  assert.equal(c.tap(), "open"); // second tap opens
  assert.equal(c.pending, 0);
});

test("trigger 2: triple tap opens (the double already did, third is a no-op tap)", () => {
  const c = new TapCounter(2);
  c.tap();
  assert.equal(c.tap(), "open");
  // A fresh machine: 1, 2 → open; nothing pending afterwards.
  const c2 = new TapCounter(2);
  c2.tap();
  c2.tap();
  assert.equal(c2.pending, 0);
});

test("trigger 2: single tap flushes as a literal backtick on expiry", () => {
  const c = new TapCounter(2);
  c.tap();
  assert.deepEqual(c.flush(), { action: "insert", insert: 1 });
  assert.equal(c.pending, 0);
});

test("trigger 2: tap then other key — flush returns insert, order preserved by caller", () => {
  const c = new TapCounter(2);
  c.tap();
  assert.deepEqual(c.flush(), { action: "insert", insert: 1 });
});

test("trigger 3: double tap does NOT open; expiry inserts the code span", () => {
  const c = new TapCounter(3);
  assert.equal(c.tap(), null);
  assert.equal(c.tap(), null, "double stays buffered at trigger 3");
  assert.deepEqual(c.flush(), { action: "insert", insert: 2 });
});

test("trigger 3: genuine triple opens immediately", () => {
  const c = new TapCounter(3);
  assert.equal(c.tap(), null);
  assert.equal(c.tap(), null);
  assert.equal(c.tap(), "open");
  assert.equal(c.pending, 0);
});

test("trigger 3: double, then a late third tap after flush, is a fresh sequence", () => {
  const c = new TapCounter(3);
  c.tap();
  c.tap();
  c.flush(); // window expired → two literal backticks
  assert.equal(c.tap(), null); // new sequence starts at 1
  assert.deepEqual(c.flush(), { action: "insert", insert: 1 });
});

test("trigger 3: single tap flushes as a literal backtick", () => {
  const c = new TapCounter(3);
  c.tap();
  assert.deepEqual(c.flush(), { action: "insert", insert: 1 });
});

test("flush with nothing pending is a harmless no-op", () => {
  const c = new TapCounter(2);
  assert.deepEqual(c.flush(), { action: "insert", insert: 0 });
});

test("window: tight enough to feel like a tap sequence, loose enough to type", () => {
  assert.ok(TAP_WINDOW_MS >= 200 && TAP_WINDOW_MS <= 400);
});
