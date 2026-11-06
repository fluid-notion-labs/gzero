import { test } from "node:test";
import assert from "node:assert/strict";
import { HubPoller, parseHubFeed, toSnapshot } from "../hub-client.ts";

test("parseHubFeed validates shape and extracts cursor", () => {
  const ok = parseHubFeed<{ id: string }>(
    { messages: [{ id: "a" }], last_seq: 42 },
    "messages",
  );
  assert.ok(ok);
  assert.equal(ok.last_seq, 42);
  assert.equal(ok.items.length, 1);
  assert.equal(parseHubFeed({}, "messages"), null);
  assert.equal(parseHubFeed({ messages: [] }, "messages"), null);
  assert.equal(parseHubFeed({ messages: [], last_seq: "x" }, "messages"), null);
  assert.equal(parseHubFeed(null, "messages"), null);
});

test("toSnapshot maps hub rows to the msg_inbox JSON shape", () => {
  const snap = toSnapshot(
    [
      { id: "m1", sender: "s", text: "hi", created: 1, seq: 5, read_at: 0 },
    ],
    [
      { id: "b1", sender: "s", text: "yo", created: 2, seq: 6, seen_at: 3 },
    ],
  );
  assert.deepEqual(snap.messages[0], {
    id: "m1",
    dest: "",
    sender: "s",
    text: "hi",
    created: 1,
    read_at: 0,
  });
  assert.deepEqual(snap.broadcasts[0], {
    id: "b1",
    sender: "s",
    text: "yo",
    created: 2,
    seen_at: 3,
  });
});

test("HubPoller.pull advances cursors and maps both feeds", async () => {
  const calls: string[] = [];
  const body = (path: string) => {
    calls.push(path);
    if (path.startsWith("/inbox/sess/messages")) {
      return {
        messages: [{ id: "m1", sender: "s", text: "t", created: 1, seq: 9, read_at: 0 }],
        last_seq: 9,
      };
    }
    return {
      broadcasts: [{ id: "b1", sender: "s", text: "x", created: 2, seq: 4, seen_at: 0 }],
      last_seq: 4,
    };
  };
  const p = new HubPoller("http://hub/", "tok", "sess");
  (p as unknown as { get: (path: string) => Promise<Response> }).get = (async (path: string) => {
    calls.push(path);
    return new Response(JSON.stringify(body(path)), { status: 200 });
  }) as unknown as (path: string) => Promise<Response>;

  const snap = await p.poll();
  assert.ok(snap);
  assert.equal(snap.messages[0].id, "m1");
  assert.equal(snap.broadcasts[0].id, "b1");
  // cursors advanced (second poll re-requests from the new seq)
  await p.poll();
  assert.ok(calls.some((c) => c.includes("since=9")));
  assert.ok(calls.some((c) => c.includes("since=4")));
});
