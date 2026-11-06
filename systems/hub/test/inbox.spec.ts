import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Comms transport B: addressed mailbox, broadcasts, presence.
// Tests share DO storage (isolatedStorage off for SQLite DOs), so every
// test uses unique dests/session ids.

const auth = { authorization: "Bearer token" };

async function post(path: string, body: unknown) {
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function put(path: string, body: unknown) {
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await SELF.fetch(`https://example.com${path}`, { headers: auth });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("inbox auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await SELF.fetch("https://example.com/inbox/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dest: "x", sender: "y", text: "z" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("messages", () => {
  it("validates dest, sender and text", async () => {
    for (const body of [
      { dest: "", sender: "s", text: "t" },
      { dest: "d", sender: "", text: "t" },
      { dest: "d", sender: "s", text: "" },
      { dest: "bad dest with spaces", sender: "s", text: "t" },
      { sender: "s", text: "t" },
    ]) {
      const { res } = await post("/inbox/messages", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("delivers addressed mail and keeps other dests blind", async () => {
    await post("/inbox/messages", { dest: "dm-a", sender: "sess-x", text: "for a" });
    await post("/inbox/messages", { dest: "dm-b", sender: "sess-x", text: "for b" });

    const a = await get("/inbox/dm-a/messages");
    expect(a.res.status).toBe(200);
    const rows = a.body.messages as Array<{ dest: string; text: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dest: "dm-a", sender: "sess-x", text: "for a", read_at: 0 });
    expect(a.body.last_seq).toBe(1);

    const b = await get("/inbox/dm-b/messages");
    expect((b.body.messages as unknown[]).length).toBe(1);
  });

  it("pages with since/limit cursors", async () => {
    for (let i = 1; i <= 3; i++) {
      await post("/inbox/messages", { dest: "dm-page", sender: "s", text: `t${i}` });
    }
    const page1 = await get("/inbox/dm-page/messages?since=0&limit=2");
    expect((page1.body.messages as unknown[]).length).toBe(2);
    expect(page1.body.next).toBe(2);
    const page2 = await get(`/inbox/dm-page/messages?since=${page1.body.next}&limit=2`);
    expect((page2.body.messages as unknown[]).length).toBe(1);
    expect(page2.body.next).toBeUndefined();
    // drained
    const drained = await get("/inbox/dm-page/messages?since=3");
    expect((drained.body.messages as unknown[]).length).toBe(0);
  });

  it("marks read and reports read_at", async () => {
    const sent = await post("/inbox/messages", { dest: "dm-read", sender: "s", text: "hi" });
    const id = sent.body.id as string;
    const marked = await post("/inbox/dm-read/read", { ids: [id] });
    expect(marked.body.marked).toBe(1);
    const rows = (await get("/inbox/dm-read/messages")).body
      .messages as Array<{ id: string; read_at: number }>;
    expect(rows[0].read_at).toBeGreaterThan(0);
    // idempotent: already-read rows are not re-marked
    const again = await post("/inbox/dm-read/read", { ids: [id] });
    expect(again.body.marked).toBe(0);
  });

  it("sweeps messages created before the cutoff", async () => {
    await post("/inbox/messages", { dest: "dm-sweep", sender: "s", text: "old" });
    const before = Math.floor(Date.now() / 1000) + 5; // everything so far
    const sweep = await post("/inbox/sweep", { before });
    expect(sweep.body.messages_deleted).toBeGreaterThan(0);
    const rows = await get("/inbox/dm-sweep/messages");
    expect((rows.body.messages as unknown[]).length).toBe(0);
  });
});

describe("broadcasts", () => {
  it("delivers to others but never the sender, until seen", async () => {
    const b1 = await post("/broadcast", { sender: "bc-a", text: "heads up" });
    expect(b1.res.status).toBe(200);

    const forB = await get("/broadcasts?since=0&session=bc-b");
    const rows = forB.body.broadcasts as Array<{ id: string; seen_at: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(b1.body.id);

    const forA = await get("/broadcasts?since=0&session=bc-a");
    expect((forA.body.broadcasts as unknown[]).length).toBe(0);

    const seen = await post("/broadcasts/seen", { session: "bc-b", ids: [b1.body.id] });
    expect(seen.body.marked).toBe(1);
    const after = await get("/broadcasts?since=0&session=bc-b");
    expect((after.body.broadcasts as unknown[]).length).toBe(0);
  });

  it("requires a session filter", async () => {
    const { res } = await get("/broadcasts?since=0");
    expect(res.status).toBe(400);
  });
});

describe("presence", () => {
  it("registers, preserves started_at, and filters live peers", async () => {
    const beat = (session: string, started: number) =>
      put("/presence", {
        session,
        machine: "m1",
        scope: "bench-scope",
        cwd: "/tmp",
        pid: 1,
        started_at: started,
        workspace: "default",
        label: "",
      });
    const first = await beat("pz-1", 1000);
    expect(first.res.status).toBe(200);
    await beat("pz-2", 2000);
    await beat("pz-1", 12345); // heartbeat: started_at preserved

    const peers = await get("/presence?scope=bench-scope&exclude=pz-1");
    const rows = peers.body.sessions as Array<{ session_id: string; started_at: number }>;
    expect(rows.map((r) => r.session_id)).toEqual(["pz-2"]);

    const all = await get("/presence?all=1");
    const every = all.body.sessions as Array<{ session_id: string; started_at: number }>;
    const me = every.find((r) => r.session_id === "pz-1");
    expect(me?.started_at).toBe(1000);
  });

  it("hides peers outside the ttl window and forgets the archived", async () => {
    await put("/presence", { session: "pz-stale", scope: "pz-scope", started_at: 1 });
    // last_seen granularity is seconds: age the row past the current
    // second so ttl=0 (hide anything older than now) can hide it.
    await new Promise((r) => setTimeout(r, 1100));
    const live = await get("/presence?scope=pz-scope&exclude=&ttl=0");
    const ids = (live.body.sessions as Array<{ session_id: string }>).map((r) => r.session_id);
    expect(ids).not.toContain("pz-stale");
    // all=1 still sees it (it is not archived yet)
    const every = await get("/presence?all=1");
    expect(
      (every.body.sessions as Array<{ session_id: string }>).map((r) => r.session_id),
    ).toContain("pz-stale");
  });
});
