import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { streamFromPath } from "../src/index";

// TOKEN comes from wrangler.jsonc vars ("token" in dev/test).
function authHeaders(): Record<string, string> {
  return { authorization: "Bearer token" };
}

describe("routing", () => {
  it("health is open", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
  });

  it("rejects missing auth", async () => {
    const res = await SELF.fetch("https://example.com/snapshot");
    expect(res.status).toBe(401);
  });

  it("legacy snapshot reaches the global stream DO", async () => {
    const res = await SELF.fetch("https://example.com/snapshot", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1 });
  });

  it("stream change POST reaches a Stream DO", async () => {
    const res = await SELF.fetch("https://example.com/stream/routing-x/changes", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ changes: [btoa("probe")] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, last_seq: 1 });
  });

  it("unknown paths 404", async () => {
    const res = await SELF.fetch("https://example.com/nope", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("epoch truncate drops only rows below `before`", async () => {
    const stream = `truncate-${Date.now()}`;
    const push = (n: number) =>
      SELF.fetch(`https://example.com/stream/${stream}/changes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          changes: Array.from({ length: n }, (_, i) => btoa(`c${i}`)),
        }),
      });
    await push(3); // seqs 1..3

    // Invalid body → 400.
    const bad = await SELF.fetch(`https://example.com/stream/${stream}/truncate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ before: 0 }),
    });
    expect(bad.status).toBe(400);

    // Truncate below seq 2: rows 1 die, 2..3 survive.
    const trunc = await SELF.fetch(`https://example.com/stream/${stream}/truncate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ before: 2 }),
    });
    expect(await trunc.json()).toMatchObject({ ok: true, deleted: 1 });

    // A reader from seq 0 now gets only the surviving changes.
    const read = await SELF.fetch(`https://example.com/stream/${stream}/changes?since=0`, {
      headers: authHeaders(),
    });
    const body = (await read.json()) as { changes: string[] };
    expect(body.changes.length).toBe(2); // seqs 2,3

    // Idempotent: re-truncating deletes nothing.
    const again = await SELF.fetch(`https://example.com/stream/${stream}/truncate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ before: 2 }),
    });
    expect(await again.json()).toMatchObject({ ok: true, deleted: 0 });

    // New pushes continue at the right seq.
    const more = await push(1);
    expect(await more.json()).toMatchObject({ ok: true, last_seq: 4 });
  });
});

describe("streamFromPath", () => {
  it("extracts stream ids", () => {
    expect(streamFromPath("/stream/repo-x/changes")).toBe("stream:repo-x");
    expect(streamFromPath("/stream/global/snapshot")).toBe("stream:global");
    expect(streamFromPath("/stream/bad path/changes")).toBeNull();
    expect(streamFromPath("/events")).toBeNull();
  });
});
