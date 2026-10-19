import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// SSE push triggers. Each test uses its own stream name: tests share DO
// storage (isolatedStorage is off for SQLite-backed DOs).
//
// Streams never end on their own, so tests read only a bounded number
// of chunks from the response body and rely on the reader being
// buffered enough to satisfy reads from already-enqueued bytes.

const auth = { authorization: "Bearer token" };

/** Read up to `n` data-carrying SSE chunks (skipping heartbeats won't
 * happen in tests — pushes and the hello event arrive immediately). */
async function readChunks(
  body: ReadableStream<Uint8Array>,
  n: number,
): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  reader.cancel().catch(() => {});
  return out;
}

describe("sse events", () => {
  it("requires auth", async () => {
    const res = await SELF.fetch("https://example.com/stream/sse-auth/events");
    expect(res.status).toBe(401);
  });

  it("sends a hello event with the current log end", async () => {
    const stream = `sse-hello-${Date.now()}`;
    await SELF.fetch(`https://example.com/stream/${stream}/changes`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ changes: [btoa("c1"), btoa("c2")] }),
    });
    const res = await SELF.fetch(`https://example.com/stream/${stream}/events`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const chunks = await readChunks(res.body as ReadableStream<Uint8Array>, 1);
    expect(chunks[0]).toContain("retry: 2000");
    expect(chunks[0]).toContain("event: hello");
    expect(chunks[0]).toContain('"last_seq":2');
  });

  it("emits a push event when changes arrive after subscribing", async () => {
    const stream = `sse-push-${Date.now()}`;
    const res = await SELF.fetch(`https://example.com/stream/${stream}/events`, {
      headers: auth,
    });
    const body = res.body as ReadableStream<Uint8Array>;
    const reader = body.getReader();

    // First chunk: hello. Then push a batch; the second chunk should
    // be the push trigger.
    await reader.read();
    const pushRes = await SELF.fetch(`https://example.com/stream/${stream}/changes`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ changes: [btoa("later")], machine_id: "tester" }),
    });
    expect(pushRes.status).toBe(200);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: push");
    expect(text).toContain('"last_seq":1');
    expect(text).toContain('"machine_id":"tester"');
    reader.cancel().catch(() => {});
  });
});
