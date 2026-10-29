// Tests for the traffic bar (inbox-bar.ts): inbox parsing, the read
// queue (unread → done transitions, cap 3), traffic windows with the
// fresh-arrival filter and the >1 msg/s warning, and the bar layout.
import { test } from "node:test";
import assert from "node:assert/strict";
const stripVTControlCodes = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

import {
  InboxModel,
  READ_QUEUE_MAX,
  barSegments,
  entryLabel,
  parseInbox,
  renderBar,
  trafficText,
  type BarEntry,
  type InboxSnapshot,
} from "../inbox-bar.ts";

const passThrough = { fg: (_c: string, s: string) => s } as never;

const msg = (id: string, over: Partial<InboxSnapshot["messages"][number]> = {}) => ({
  id,
  dest: "me",
  sender: "s-" + id,
  text: "note " + id,
  created: 1000,
  read_at: 0,
  ...over,
});

const bcast = (id: string, over: Partial<InboxSnapshot["broadcasts"][number]> = {}) => ({
  id,
  sender: "other",
  text: "board " + id,
  created: 1000,
  seen_at: 0,
  ...over,
});

const nowMs = 1_000_000_000; // 1000s epoch-ish; well past the fixtures' created=1000

function entry(id: string, over: Partial<BarEntry> = {}): BarEntry {
  return { id, sender: "s-" + id, text: "note " + id, created: 1000, ...over };
}

test("parseInbox: valid JSON round-trips, malformed input yields null", () => {
  const good = parseInbox(JSON.stringify({ messages: [msg("a")], broadcasts: [bcast("b")] }));
  assert.ok(good);
  assert.equal(good.messages[0].id, "a");
  assert.equal(good.broadcasts[0].seen_at, 0);
  // tolerant of wrong-typed fields
  const loose = parseInbox(JSON.stringify({ messages: [{ id: 1, read_at: "x" }], broadcasts: [] }));
  assert.ok(loose);
  assert.equal(loose.messages[0].id, "");
  assert.equal(loose.messages[0].read_at, 0);
  assert.equal(parseInbox("not json"), null);
  assert.equal(parseInbox("{}"), null);
  assert.equal(parseInbox("[]"), null);
});

test("model: first apply shows unread, and is not counted as traffic (backlog filter)", () => {
  const m = new InboxModel();
  // created is 60+ seconds stale relative to nowMs → not fresh
  const changed = m.apply({ messages: [msg("a"), msg("b")], broadcasts: [] }, nowMs);
  assert.ok(changed);
  assert.ok(m.seen);
  assert.deepEqual(m.unread.map((u) => u.id), ["a", "b"]);
  const t = m.traffic(nowMs);
  assert.deepEqual([t.perSec, t.per10s, t.perMin, t.warn], [0, 0, 0, false]);
});

test("model: unread → read transitions enqueue into the read queue, capped at 3", () => {
  const m = new InboxModel();
  m.apply({ messages: [msg("a"), msg("b"), msg("c"), msg("d")], broadcasts: [] }, nowMs);
  assert.ok(m.apply({ messages: [msg("a", { read_at: 5 }), msg("b"), msg("c"), msg("d")], broadcasts: [] }, nowMs));
  assert.equal(m.readQueue.length, 1);
  assert.equal(m.readQueue[0].id, "a");
  // b, c join; d read → a is evicted (only 3 stay)
  m.apply({ messages: [msg("a", { read_at: 5 }), msg("b", { read_at: 6 }), msg("c", { read_at: 7 }), msg("d", { read_at: 8 })], broadcasts: [] }, nowMs);
  assert.deepEqual(m.readQueue.map((r) => r.id), ["b", "c", "d"]);
  assert.equal(m.unread.length, 0);
  assert.equal(READ_QUEUE_MAX, 3);
});

test("model: re-read and unknown transitions do not duplicate queue entries", () => {
  const m = new InboxModel();
  m.apply({ messages: [msg("a")], broadcasts: [] }, nowMs);
  m.apply({ messages: [msg("a", { read_at: 5 })], broadcasts: [] }, nowMs);
  assert.equal(m.readQueue.length, 1);
  // already-read entry arriving again changes nothing in the queue
  m.apply({ messages: [msg("a", { read_at: 5 })], broadcasts: [] }, nowMs);
  assert.equal(m.readQueue.length, 1);
});

test("model: broadcast seen_at drives the same done transition", () => {
  const m = new InboxModel();
  m.apply({ messages: [], broadcasts: [bcast("x")] }, nowMs);
  assert.equal(m.unread.length, 1);
  m.apply({ messages: [], broadcasts: [bcast("x", { seen_at: 9 })] }, nowMs);
  assert.equal(m.unread.length, 0);
  assert.equal(m.readQueue[0].id, "x");
});

test("model: vanished entries drop out of tracking; read queue keeps its copies", () => {
  const m = new InboxModel();
  m.apply({ messages: [msg("a")], broadcasts: [] }, nowMs);
  m.apply({ messages: [msg("a", { read_at: 5 })], broadcasts: [] }, nowMs);
  // store TTL'd the entry away: not unread, still on the bar's queue
  assert.ok(m.apply({ messages: [], broadcasts: [] }, nowMs));
  assert.equal(m.unread.length, 0);
  assert.deepEqual(m.readQueue.map((r) => r.id), ["a"]);
  assert.equal(m.traffic(nowMs).perMin, 0);
});

test("model: fresh arrivals count toward traffic; stale ones do not", () => {
  const m = new InboxModel();
  const now = 5_000_000;
  m.apply(
    {
      messages: [msg("fresh", { created: Math.floor(now / 1000) - 3 }), msg("stale", { created: Math.floor(now / 1000) - 120 })],
      broadcasts: [],
    },
    now,
  );
  const t = m.traffic(now);
  assert.equal(t.perMin, 1); // only the fresh one
  assert.equal(t.per10s, 1);
  // windows slide: 20s later the 10s window is empty; the arrival
  // leaves the minute window at +61s
  const later = m.traffic(now + 20_000);
  assert.equal(later.per10s, 0);
  assert.equal(later.perMin, 1);
  assert.equal(m.traffic(now + 61_000).perMin, 0);
});

test("model: warn only when strictly above 1 msg/s over the 10s window", () => {
  const m = new InboxModel();
  const now = 5_000_000;
  const created = Math.floor(now / 1000);
  // 12 fresh arrivals in the last 10s → 1.2/s → warn
  const batch = Array.from({ length: 12 }, (_, i) => msg(`w${i}`, { created: created - i % 8 }));
  m.apply({ messages: batch, broadcasts: [] }, now);
  const t = m.traffic(now);
  assert.equal(t.per10s, 12);
  assert.ok(t.warn);
  // 8 arrivals → 0.8/s → no warn
  const m2 = new InboxModel();
  m2.apply({ messages: batch.slice(0, 8), broadcasts: [] }, now);
  assert.ok(!m2.traffic(now).warn);
});

test("model: apply reports changes only when visible state moves", () => {
  const m = new InboxModel();
  const snap: InboxSnapshot = { messages: [msg("a")], broadcasts: [bcast("x")] };
  assert.ok(m.apply(snap, nowMs));
  // same snapshot again: no visible change
  assert.ok(!m.apply(snap, nowMs + 1000));
  // a new broadcast is a visible change; then its seen-at is another
  assert.ok(m.apply({ messages: [msg("a")], broadcasts: [bcast("x"), bcast("y")] }, nowMs + 2000));
  assert.ok(m.apply({ messages: [msg("a")], broadcasts: [bcast("x"), bcast("y", { seen_at: 3 })] }, nowMs + 3000));
  // and the settle: nothing moves
  assert.ok(!m.apply({ messages: [msg("a")], broadcasts: [bcast("x"), bcast("y", { seen_at: 3 })] }, nowMs + 4000));
});

test("entryLabel truncates to sender + text within the cap", () => {
  const e = entry("abcdef12345678", { text: "x".repeat(60) });
  const label = entryLabel(e, 28);
  assert.ok(label.length <= 30);
  assert.ok(label.endsWith("…"));
  const short = entryLabel(entry("a", { text: "tiny" }), 28);
  assert.equal(short, "s-a: tiny");
});

test("barSegments: spinner + incoming while unread; ✓ entries for the read queue", () => {
  const state = { unread: [entry("a")], readQueue: [entry("z")] };
  const segs = barSegments(state, 0);
  // spinner frame, count, unread entry, read entry
  assert.equal(segs.length, 4);
  assert.ok(segs[2].text.includes("▸"));
  assert.ok(segs[3].text.includes("✓"));
  const empty = barSegments({ unread: [], readQueue: [] }, 0);
  assert.deepEqual(empty, []);
});

test("trafficText formats the three values and prefixes the warn state", () => {
  assert.equal(trafficText({ perSec: 0, per10s: 3, perMin: 8, warn: false }), "0.3/s · 3/10s · 8/min");
  assert.ok(trafficText({ perSec: 5, per10s: 20, perMin: 40, warn: true }).startsWith("⚠ "));
});

test("renderBar: traffic right-aligned, read entries yield before traffic is squeezed", () => {
  const state = { unread: [], readQueue: [entry("a"), entry("b"), entry("c")] };
  const traffic = { perSec: 0, per10s: 3, perMin: 8, warn: false };
  const line = stripVTControlCodes(renderBar(state, traffic, 0, passThrough, 120));
  assert.ok(line.includes("✓ s-a"));
  assert.ok(line.includes("0.3/s · 3/10s · 8/min"));
  // fits: padding pushes traffic to the right edge
  assert.equal(line.length, 120);
  // narrow: entries drop whole (never truncated mid-entry) — at 55
  // the two first read entries still fit, the third doesn't
  const narrow = stripVTControlCodes(renderBar(state, traffic, 0, passThrough, 55));
  assert.ok(narrow.includes("0.3/s · 3/10s · 8/min"));
  assert.ok(narrow.includes("s-a"));
  assert.ok(!narrow.includes("s-c"));
  // very narrow: only the traffic values
  const tiny = stripVTControlCodes(renderBar(state, traffic, 0, passThrough, 30));
  assert.ok(tiny.includes("0.3/s · 3/10s · 8/min"));
  assert.ok(!tiny.includes("s-a"));
});

test("renderBar: unread entries beat the read queue for space; warn color on traffic", () => {
  const state = { unread: [entry("a", { text: "urgent" })], readQueue: [entry("z")] };
  const warned = { perSec: 3, per10s: 40, perMin: 90, warn: true };
  const line = stripVTControlCodes(renderBar(state, warned, 0, passThrough, 100));
  assert.ok(line.includes("incoming"));
  assert.ok(line.includes("⚠"));
  assert.ok(line.includes("4.0/s · 40/10s · 90/min"));
});
