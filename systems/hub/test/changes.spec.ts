import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Each test uses its own stream name: tests share DO storage
// (isolatedStorage is off for SQLite-backed DOs).

const auth = { authorization: "Bearer token" };

function change(b64: string): string {
  return b64;
}

function b64(s: string): string {
  return btoa(s);
}

async function postChanges(stream: string, changes: string[], machineId?: string) {
  return SELF.fetch(`https://example.com/stream/${stream}/changes`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(machineId ? { changes, machine_id: machineId } : { changes }),
  });
}

async function getChanges(stream: string, query = "") {
  const res = await SELF.fetch(
    `https://example.com/stream/${stream}/changes${query}`,
    { headers: auth },
  );
  return { res, body: (await res.json()) as object };
}

describe("change log", () => {
  it("appends a batch and returns the new highest seq", async () => {
    const res = await postChanges("t1", [b64("c1"), b64("c2")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, last_seq: 2 });
  });

  it("continues seqs across batches", async () => {
    await postChanges("t2", [b64("a")]);
    const res = await postChanges("t2", [b64("b"), b64("c")]);
    expect(await res.json()).toMatchObject({ last_seq: 3 });
  });

  it("round-trips bytes exactly in seq order", async () => {
    const c1 = b64("first"), c2 = b64("second"), c3 = b64("third");
    await postChanges("t3", [c1, c2, c3]);
    const { res, body } = await getChanges("t3", "?since=0");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      changes: [c1, c2, c3],
      last_seq: 3,
    });
  });

  it("returns only changes after the cursor", async () => {
    const c1 = b64("one"), c2 = b64("two");
    await postChanges("t4", [c1]);
    await postChanges("t4", [c2]);
    const { body } = await getChanges("t4", "?since=1");
    expect(body).toMatchObject({ changes: [c2], last_seq: 2 });
  });

  it("pages with limit and reports the resume cursor", async () => {
    await postChanges("t5", [b64("1"), b64("2"), b64("3")]);
    const { body } = await getChanges("t5", "?since=0&limit=2");
    expect(body).toMatchObject({ changes: [b64("1"), b64("2")], next: 2 });
    const { body: rest } = await getChanges("t5", "?since=2");
    expect(rest).toMatchObject({ changes: [b64("3")], last_seq: 3 });
    expect("next" in rest).toBe(false);
  });

  it("empty result past the end", async () => {
    await postChanges("t6", [b64("x")]);
    const { body } = await getChanges("t6", "?since=1");
    expect(body).toMatchObject({ changes: [], last_seq: 1 });
  });

  it("rejects invalid bodies", async () => {
    const bad = await SELF.fetch("https://example.com/stream/t7/changes", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ changes: [] }),
    });
    expect(bad.status).toBe(400);

    const notB64 = await postChanges("t7", ["!!!not-base64!!!"]);
    expect(notB64.status).toBe(400);
  });

  it("isolates streams", async () => {
    await postChanges("t8-a", [b64("mine")]);
    const { body } = await getChanges("t8-b");
    expect(body).toMatchObject({ changes: [], last_seq: 0 });
  });

  it("records the machine registry on push", async () => {
    await postChanges("t9", [b64("data")], "laptop-a");
    // Registry is stored; its read path arrives with the snapshot
    // endpoints. Assert via the seq counter bump only.
    const res = await postChanges("t9", [b64("more")], "laptop-a");
    expect(await res.json()).toMatchObject({ last_seq: 2 });
  });
});
