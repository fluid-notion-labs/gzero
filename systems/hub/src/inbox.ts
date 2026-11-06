/**
 * inbox.ts — comms transport B: an addressed mailbox, not a change log.
 *
 * The efficacy analysis (gzero item 6db2) measured the change-log
 * transport: conversation was 0.25% of stream bytes, presence machinery
 * 99.9%, and every client pulled the full stream to find its own inbox.
 * This DO is the fix's storage half: messages are addressed rows served
 * per-destination (the N^2→N flip happens server-side), presence is a
 * queryable row set instead of a write storm, and TTL expiry is a sweep
 * that actually deletes (no tombstones, no epoch rolls).
 *
 * Wire surface (all bearer-auth'd at the router):
 * - POST   /inbox/messages            {dest, sender, text} → {id, seq}
 * - GET    /inbox/<dest>/messages     ?since=<seq>&limit= → rows with
 *          read_at (the client filters unread; the bar shows both)
 * - POST   /inbox/<dest>/read         {ids: [...]} → {marked}
 * - POST   /inbox/sweep               {before: epoch-secs} → deletes
 *          messages, broadcasts and presence rows created before it
 * - POST   /broadcast                 {sender, text} → {id, seq}
 * - GET    /broadcasts                ?since=&limit=&session= → unseen
 *          broadcasts for that session (sender excluded server-side)
 * - POST   /broadcasts/seen           {session, ids} → {marked}
 * - PUT    /presence                  {session, machine, scope, cwd, pid,
 *          started_at, workspace, label} (last_seen = now)
 * - GET    /presence                  ?scope=&exclude=&ttl= → live rows
 *          in that scope; ?all=1 → every row (inspection)
 *
 * Storage layout (KV API over the SQLite-backed DO, matching Stream):
 * - mseq:<dest>          next seq counter for that destination
 * - m:<dest>:<paddedseq> message row (JSON)
 * - bseq                 broadcast counter; b:<paddedseq> row
 * - bseen:<session>:<id> per-session seen timestamp
 * - s:<session>          presence row (JSON)
 */

const PAD = 12; // padded seq width: lexicographic == numeric

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pad(seq: number): string {
  return String(seq).padStart(PAD, "0");
}

function unpad(key: string): number {
  return parseInt(key.slice(-PAD), 10);
}

/** Per-destination key prefix: dests are session ids / agent ids —
 * restricted to the URL-safe alphabet so they stay single segments. */
function destKey(dest: string): string | null {
  if (!dest || !/^[A-Za-z0-9._-]+$/.test(dest) || dest.length > 128) return null;
  return dest;
}

interface MessageRow {
  id: string;
  dest: string;
  sender: string;
  text: string;
  created: number;
  seq: number;
  read_at: number;
}

interface BroadcastRow {
  id: string;
  sender: string;
  text: string;
  created: number;
  seq: number;
}

interface PresenceRow {
  session_id: string;
  machine: string;
  scope: string;
  cwd: string;
  pid: number;
  started_at: number;
  last_seen: number;
  label: string;
  workspace: string;
}

/** Validate one string field; "" allowed only when optional. */
function str(v: unknown, required: boolean): string | null {
  if (typeof v !== "string") return null;
  if (required && v.trim().length === 0) return null;
  return v;
}

export class Inbox implements DurableObject {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["inbox", ...] | ["broadcasts"] | ["presence"]
    if (parts[0] === "inbox") {
      if (parts[1] === "messages" && req.method === "POST") {
        return this.postMessage(req);
      }
      if (parts[1] === "sweep" && req.method === "POST") {
        return this.postSweep(req);
      }
      // /inbox/<dest>/messages (GET) and /inbox/<dest>/read (POST)
      if (parts.length === 3 && req.method === "GET") {
        return this.getMessages(url, parts[1]);
      }
      if (parts.length === 3 && parts[2] === "read" && req.method === "POST") {
        return this.postRead(req, parts[1]);
      }
      return json({ error: "not found" }, 404);
    }
    // POST /broadcast (singular send) and GET /broadcasts (plural list)
    // are the same subsystem; normalize before dispatch.
    const bcast = parts[0] === "broadcast" ? "broadcasts" : parts[0];
    if (bcast === "broadcasts") {
      if (parts.length === 1 && req.method === "POST") return this.postBroadcast(req);
      if (parts.length === 1 && req.method === "GET") return this.getBroadcasts(url);
      if (parts.length === 2 && parts[1] === "seen" && req.method === "POST") {
        return this.postBroadcastsSeen(req);
      }
      return json({ error: "not found" }, 404);
    }
    if (parts[0] === "presence") {
      if (parts.length === 1 && req.method === "PUT") return this.putPresence(req);
      if (parts.length === 1 && req.method === "GET") return this.getPresence(url);
      return json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  }

  // --- messages -------------------------------------------------------------

  private async postMessage(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "invalid body" }, 400);
    const dest = str(body.dest, true);
    const sender = str(body.sender, true);
    const text = str(body.text, true);
    if (!dest || !sender || !text || !destKey(dest)) {
      return json({ error: "dest, sender and text are required" }, 400);
    }
    // Seq allocation and the row put happen with no interleaved writes
    // to this dest's keys (single DO, input gate serializes fetches).
    const seq = ((await this.storage.get<number>(`mseq:${dest}`)) ?? 0) + 1;
    const row: MessageRow = {
      id: crypto.randomUUID(),
      dest,
      sender,
      text,
      created: Math.floor(Date.now() / 1000),
      seq,
      read_at: 0,
    };
    await this.storage.put(`m:${dest}:${pad(seq)}`, row);
    await this.storage.put(`mseq:${dest}`, seq);
    return json({ id: row.id, seq });
  }

  /** GET /inbox/<dest>/messages?since=<seq>&limit= — rows addressed to
   * dest after the cursor, oldest first. Expired rows (created older
   * than the message TTL) are skipped lazily so unread-but-stale mail
   * never reappears after a sweep-less period. */
  private async getMessages(url: URL, dest: string): Promise<Response> {
    if (!destKey(dest)) return json({ error: "invalid dest" }, 400);
    const since = parseInt(url.searchParams.get("since") ?? "0", 10);
    if (!Number.isFinite(since) || since < 0) return json({ error: "invalid since" }, 400);
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

    const seq = (await this.storage.get<number>(`mseq:${dest}`)) ?? 0;
    if (since >= seq) return json({ messages: [], last_seq: seq });

    const ttlSecs = Number(url.searchParams.get("ttl") ?? "604800"); // 7d default
    const minCreated = Math.floor(Date.now() / 1000) - ttlSecs;

    const listed: MessageRow[] = [];
    let next: number | undefined;
    const map = await this.storage.list({
      start: `m:${dest}:${pad(since + 1)}`,
      end: `m:${dest}:${pad(seq + 1)}`,
      limit: limit + 1, // +1 to detect a partial page
    });
    for (const [key, value] of map) {
      const row = value as MessageRow;
      if (row.created < minCreated) continue; // expired: invisible, swept later
      listed.push(row);
      if (listed.length === limit) {
        next = unpad(key);
        break;
      }
    }
    return next === undefined
      ? json({ messages: listed, last_seq: seq })
      : json({ messages: listed, last_seq: seq, next });
  }

  private async postRead(req: Request, dest: string): Promise<Response> {
    if (!destKey(dest)) return json({ error: "invalid dest" }, 400);
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
    if (!body || !Array.isArray(body.ids)) return json({ error: "invalid ids" }, 400);
    const ids = new Set(body.ids.filter((i): i is string => typeof i === "string"));
    const readAt = Math.floor(Date.now() / 1000);
    let marked = 0;
    // read state lives on the row itself; rewrite each match
    const map = await this.storage.list({ start: `m:${dest}:`, end: `m:${dest}:\uffff` });
    for (const [key, value] of map) {
      const row = value as MessageRow;
      if (row.read_at === 0 && ids.has(row.id)) {
        row.read_at = readAt;
        await this.storage.put(key, row);
        marked++;
      }
    }
    return json({ marked });
  }

  // --- broadcasts -----------------------------------------------------------

  private async postBroadcast(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "invalid body" }, 400);
    const sender = str(body.sender, true);
    const text = str(body.text, true);
    if (!sender || !text) return json({ error: "sender and text are required" }, 400);
    const seq = ((await this.storage.get<number>("bseq")) ?? 0) + 1;
    const row: BroadcastRow = {
      id: crypto.randomUUID(),
      sender,
      text,
      created: Math.floor(Date.now() / 1000),
      seq,
    };
    await this.storage.put(`b:${pad(seq)}`, row);
    await this.storage.put("bseq", seq);
    return json({ id: row.id, seq });
  }

  /** GET /broadcasts?since=&limit=&session= — unseen broadcasts for the
   * session, oldest first; the sender never sees their own board. */
  private async getBroadcasts(url: URL): Promise<Response> {
    const since = parseInt(url.searchParams.get("since") ?? "0", 10);
    if (!Number.isFinite(since) || since < 0) return json({ error: "invalid since" }, 400);
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const session = url.searchParams.get("session") ?? "";
    if (!session) return json({ error: "session is required" }, 400);

    const seq = (await this.storage.get<number>("bseq")) ?? 0;
    if (since >= seq) return json({ broadcasts: [], last_seq: seq });

    const ttlSecs = Number(url.searchParams.get("ttl") ?? "604800");
    const minCreated = Math.floor(Date.now() / 1000) - ttlSecs;

    const out: Array<BroadcastRow & { seen_at: number }> = [];
    let next: number | undefined;
    const map = await this.storage.list({
      start: `b:${pad(since + 1)}`,
      end: `b:${pad(seq + 1)}`,
      limit: limit * 2 + 1,
    });
    for (const [key, value] of map) {
      const row = value as BroadcastRow;
      if (row.sender === session) continue;
      if (row.created < minCreated) continue;
      const seenAt =
        (await this.storage.get<number>(`bseen:${session}:${row.id}`)) ?? 0;
      if (seenAt > 0) continue; // already seen by this session
      out.push({ ...row, seen_at: 0 });
      if (out.length === limit) {
        next = unpad(key);
        break;
      }
    }
    return next === undefined
      ? json({ broadcasts: out, last_seq: seq })
      : json({ broadcasts: out, last_seq: seq, next });
  }

  private async postBroadcastsSeen(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as
      | { session?: unknown; ids?: unknown }
      | null;
    if (!body) return json({ error: "invalid body" }, 400);
    const session = str(body.session, true);
    if (!session || !Array.isArray(body.ids)) return json({ error: "invalid ids" }, 400);
    const now = Math.floor(Date.now() / 1000);
    let marked = 0;
    for (const id of body.ids) {
      if (typeof id === "string" && id) {
        await this.storage.put(`bseen:${session}:${id}`, now);
        marked++;
      }
    }
    return json({ marked });
  }

  // --- presence ---------------------------------------------------------------

  private async putPresence(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "invalid body" }, 400);
    const sessionId = str(body.session, true);
    if (!sessionId || sessionId.length > 128) return json({ error: "session is required" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const prev = await this.storage.get<PresenceRow>(`s:${sessionId}`);
    const row: PresenceRow = {
      session_id: sessionId,
      machine: str(body.machine, false) ?? "",
      scope: str(body.scope, false) ?? "",
      cwd: str(body.cwd, false) ?? "",
      pid: typeof body.pid === "number" ? body.pid : 0,
      // started_at survives updates (first-seen); last_seen always moves.
      started_at:
        typeof body.started_at === "number" && body.started_at > 0
          ? prev && prev.started_at > 0
            ? prev.started_at
            : body.started_at
          : (prev?.started_at ?? now),
      last_seen: now,
      label: str(body.label, false) ?? "",
      workspace: str(body.workspace, false) ?? "",
    };
    await this.storage.put(`s:${sessionId}`, row);
    return json({ ok: true });
  }

  /** GET /presence?scope=&exclude=&ttl= — live rows (last_seen within
   * ttl secs, default 300) in the scope; ?all=1 skips the filters. */
  private async getPresence(url: URL): Promise<Response> {
    const all = url.searchParams.get("all") === "1";
    const scope = url.searchParams.get("scope") ?? "";
    const exclude = url.searchParams.get("exclude") ?? "";
    const ttl = Number(url.searchParams.get("ttl") ?? "300");
    const minSeen = Math.floor(Date.now() / 1000) - (Number.isFinite(ttl) ? ttl : 300);
    const archiveCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

    const rows: PresenceRow[] = [];
    const stale: string[] = [];
    const map = await this.storage.list({ start: "s:", end: "s:\uffff" });
    for (const [key, value] of map) {
      const row = value as PresenceRow;
      if (row.last_seen < archiveCutoff) {
        stale.push(key); // 30d archive TTL: forget the dead
        continue;
      }
      if (all) {
        rows.push(row);
        continue;
      }
      if (row.scope !== scope || row.session_id === exclude) continue;
      if (row.last_seen < minSeen) continue;
      rows.push(row);
    }
    if (stale.length > 0) await this.storage.delete(stale);
    rows.sort((a, b) => a.last_seen - b.last_seen);
    return json({ sessions: rows });
  }

  // --- sweep (GC) --------------------------------------------------------------

  /** POST /inbox/sweep {before: epoch-secs} — delete messages,
   * broadcasts and read/seen rows created before the cutoff. Presence
   * rows expire via the archive TTL in getPresence. */
  private async postSweep(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { before?: unknown } | null;
    const before = typeof body?.before === "number" ? body.before : null;
    if (before === null) return json({ error: "before (epoch secs) is required" }, 400);

    let messages = 0;
    let broadcasts = 0;
    // Per-dest walk: dest keys are only enumerable via their rows.
    const doomed: string[] = [];
    const map = await this.storage.list({ start: "m:", end: "n:" });
    for (const [key, value] of map) {
      const row = value as MessageRow;
      if (row.created < before) doomed.push(key);
    }
    if (doomed.length > 0) {
      await this.storage.delete(doomed);
      messages = doomed.length;
    }
    const bDoomed: string[] = [];
    const bMap = await this.storage.list({ start: "b:", end: "c:" });
    for (const [key, value] of bMap) {
      const row = value as BroadcastRow;
      if (row.created < before) bDoomed.push(key);
    }
    if (bDoomed.length > 0) {
      await this.storage.delete(bDoomed);
      broadcasts = bDoomed.length;
    }
    // Seen-state rows for deleted broadcasts are garbage; the TTL'd
    // window makes them unreachable via GET. Sweep them by timestamp
    // pattern: they store an epoch, not a created — clean via before.
    const seenDoomed: string[] = [];
    const sMap = await this.storage.list({ start: "bseen:", end: "c:" });
    for (const [key, value] of sMap) {
      const seenAt = value as number;
      if (seenAt < before) seenDoomed.push(key);
    }
    if (seenDoomed.length > 0) await this.storage.delete(seenDoomed);

    return json({ messages_deleted: messages, broadcasts_deleted: broadcasts });
  }
}
