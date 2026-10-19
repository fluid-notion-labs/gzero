import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const auth = { authorization: "Bearer token" };

async function postChanges(stream: string, changes: string[]) {
  return SELF.fetch(`https://example.com/stream/${stream}/changes`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ changes }),
  });
}

async function getSnapshot(stream: string) {
  const res = await SELF.fetch(`https://example.com/stream/${stream}/snapshot`, {
    headers: auth,
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function postSnapshot(stream: string, snapshot: string, upTo: number) {
  return SELF.fetch(`https://example.com/stream/${stream}/snapshot`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ snapshot, up_to: upTo }),
  });
}

describe("doc snapshot", () => {
  it("404s before any snapshot is uploaded", async () => {
    const { res } = await getSnapshot("s1");
    expect(res.status).toBe(404);
  });

  it("round-trips the uploaded snapshot and covers the tail", async () => {
    await postChanges("s2", [btoa("c1"), btoa("c2"), btoa("c3"), btoa("c4")]);

    const bad = await postSnapshot("s2", "not-b64!!", 2);
    expect(bad.status).toBe(400);

    const tooFar = await postSnapshot("s2", btoa("snap"), 9);
    expect(tooFar.status).toBe(400);

    const ok = await postSnapshot("s2", btoa("SNAPSHOT-12"), 2);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, snapshot_seq: 2 });

    const { res, body } = await getSnapshot("s2");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ snapshot: btoa("SNAPSHOT-12"), snapshot_seq: 2 });

    // Truncation: the log now only holds the tail beyond seq 2.
    const tail = await SELF.fetch("https://example.com/stream/s2/changes?since=2", {
      headers: auth,
    });
    expect(await tail.json()).toMatchObject({
      changes: [btoa("c3"), btoa("c4")],
      last_seq: 4,
    });
    const full = await SELF.fetch("https://example.com/stream/s2/changes?since=0", {
      headers: auth,
    });
    expect(await full.json()).toMatchObject({ changes: [btoa("c3"), btoa("c4")] });
  });

  it("up_to=0 stores the snapshot without truncating", async () => {
    await postChanges("s3", [btoa("x")]);
    const ok = await postSnapshot("s3", btoa("SNAP"), 0);
    expect(ok.status).toBe(200);
    const { body } = await getSnapshot("s3");
    expect(body).toMatchObject({ snapshot: btoa("SNAP"), snapshot_seq: 0 });
    const log = await SELF.fetch("https://example.com/stream/s3/changes?since=0", {
      headers: auth,
    });
    expect(await log.json()).toMatchObject({ changes: [btoa("x")], last_seq: 1 });
  });
});
