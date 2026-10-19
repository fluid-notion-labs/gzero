import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Compat with gzero's src/hub.rs: POST /events takes a bare JSON array
// of {op: "put"|"remove", atom: {text, scope, node, tags}}; GET
// /snapshot returns {version: 1, atoms, tombstones}. These tests use
// payloads exactly as the Rust client sends them.

const auth = { authorization: "Bearer token" };
const atom = (text: string, tags: string[] = []) => ({
  text,
  scope: "global",
  node: "notes",
  tags,
});

async function postEvents(events: unknown[]) {
  return SELF.fetch("https://example.com/events", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(events),
  });
}

async function getSnapshot() {
  const res = await SELF.fetch("https://example.com/snapshot", {
    headers: auth,
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("legacy wire format", () => {
  it("put -> visible in snapshot", async () => {
    const res = await postEvents([{ op: "put", atom: atom("legacy atom") }]);
    expect(res.status).toBe(200);

    const { res: snapRes, body } = await getSnapshot();
    expect(snapRes.status).toBe(200);
    expect(body).toMatchObject({ version: 1 });
    expect((body.atoms as { text: string }[]).map((a) => a.text)).toContain(
      "legacy atom",
    );
  });

  it("remove -> tombstoned, put stays hidden (OR-set)", async () => {
    await postEvents([
      { op: "put", atom: atom("to kill") },
      { op: "remove", atom: atom("to kill") },
      { op: "put", atom: atom("to kill") }, // replayed concurrent add
    ]);
    const { body } = await getSnapshot();
    expect(body).toMatchObject({ version: 1 });
    // The global stream is shared across test files (no isolated
    // storage), so assert membership, not exact contents.
    expect((body.atoms as { text: string }[]).map((a) => a.text)).not.toContain(
      "to kill",
    );
    expect(
      (body.tombstones as { text: string }[]).map((a) => a.text),
    ).toContain("to kill");
  });

  it("rejects malformed ops", async () => {
    const res = await postEvents([{ op: "nope", atom: { text: "" } }]);
    expect(res.status).toBe(400);
  });

  it("absorbs a client snapshot via POST /snapshot", async () => {
    const res = await SELF.fetch("https://example.com/snapshot", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        atoms: [atom("from client snap")],
        tombstones: [atom("dead from client")],
      }),
    });
    expect(res.status).toBe(200);
    const { body } = await getSnapshot();
    expect((body.atoms as { text: string }[]).map((a) => a.text)).toContain(
      "from client snap",
    );
  });
});

describe("auth", () => {
  it("401 without a token", async () => {
    const res = await SELF.fetch("https://example.com/snapshot");
    expect(res.status).toBe(401);
  });

  it("401 with a wrong token", async () => {
    const res = await SELF.fetch("https://example.com/snapshot", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("401 on change endpoints too", async () => {
    const res = await SELF.fetch("https://example.com/stream/x/changes", {
      method: "POST",
      body: JSON.stringify({ changes: [btoa("c")] }),
    });
    expect(res.status).toBe(401);
  });
});
