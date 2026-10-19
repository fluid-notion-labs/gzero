import { LegacyMerge, Op, Snapshot, validOps } from "./legacy-merge";

const PERSIST_DEBOUNCE_MS = 1_000;
const SNAPSHOT_KEY = "snapshot"; // legacy merged-atom state (stream:global)
const DOC_SNAPSHOT_KEY = "meta:snapshot"; // new-format doc snapshot
const DOC_SNAPSHOT_SEQ_KEY = "meta:snapshotSeq"; // seq the snapshot covers

/**
 * One Durable Object per stream.
 *
 * v0 carries two concerns:
 * - the change log (automerge changes appended by new clients,
 *   served back by cursor) — filled in by the change-endpoints work
 * - the legacy atom-merge state for "stream:global" so the old
 *   /events + /snapshot wire format keeps working unchanged
 */
export class Stream implements DurableObject {
  private readonly storage: DurableObjectStorage;
  private merge = new LegacyMerge();
  private loaded = false;
  private dirty = false;
  /** SSE subscribers (see /events); cleared if the DO restarts —
   * clients reconnect and re-pull, so losing them is only a latency
   * blip, never a correctness issue (SSE is a trigger, not data). */
  private listeners = new Set<(event: string) => void>();

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.get<string>(SNAPSHOT_KEY);
    if (raw) {
      try {
        this.merge.load(JSON.parse(raw) as Snapshot);
      } catch {
        // corrupt snapshot: start empty, next persist overwrites
      }
    }
    this.loaded = true;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/legacy/events" && req.method === "POST") {
      return this.postEvents(req);
    }
    if (path === "/legacy/snapshot" && req.method === "POST") {
      return this.postSnapshotUpload(req);
    }
    if (path === "/legacy/snapshot" && req.method === "GET") {
      return this.getSnapshot();
    }
    if (path === "/changes" && req.method === "POST") {
      return this.postChanges(req);
    }
    if (path === "/changes" && req.method === "GET") {
      return this.getChanges(url);
    }
    if (path === "/snapshot" && req.method === "GET") {
      return this.getDocSnapshot();
    }
    if (path === "/snapshot" && req.method === "POST") {
      return this.postDocSnapshot(req);
    }
    if (path === "/truncate" && req.method === "POST") {
      return this.postTruncate(req);
    }
    if (path === "/events" && req.method === "GET") {
      return this.getEvents(req);
    }
    return json({ error: "not found" }, 404);
  }

  // --- change log -----------------------------------------------------------

  /**
   * Append a batch of automerge changes.
   *
   * Body: `{ "changes": ["<base64>", ...], "machine_id": "..." }`.
   * One change per storage key (`chg:<seq>`), zero-padded so list()
   * yields lexicographic = numeric order; the DO value-size limit
   * (~128 KB) makes one-key-per-change the right granularity. Seqs are
   * dense and allocated under the DO's input gate (no await between
   * reading the counter and the atomic multi-key put), so appends are
   * race-free and reads are gapless.
   */
  private async postChanges(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as
      | { changes?: unknown; machine_id?: unknown }
      | null;
    if (
      !body ||
      !Array.isArray(body.changes) ||
      body.changes.length === 0 ||
      !body.changes.every((c) => typeof c === "string" && c.length > 0)
    ) {
      return json({ error: "invalid changes" }, 400);
    }
    const changes: Uint8Array[] = [];
    for (const c of body.changes as string[]) {
      const bytes = base64Decode(c);
      if (!bytes) return json({ error: "invalid base64 change" }, 400);
      changes.push(bytes);
    }

    const lastSeq = await this.appendChanges(changes);

    // Machine registry: announce {machine_id, last_seq} on push.
    if (typeof body.machine_id === "string" && body.machine_id.length > 0) {
      await this.storage.put(`machine:${body.machine_id}`, lastSeq);
    }

    // Wake SSE subscribers. The event is a trigger only — subscribers
    // pull /changes?since=<cursor> for the actual data, so payload
    // detail is deliberately minimal.
    this.notify(
      `event: push\ndata: ${JSON.stringify({
        last_seq: lastSeq,
        machine_id: body.machine_id ?? null,
      })}\n\n`,
    );

    return json({ ok: true, last_seq: lastSeq });
  }

  /**
   * Read changes after a cursor.
   *
   * Query: `?since=N&limit=K` (default since=0, limit=200). `since` is
   * the last seq the client already has; the response covers
   * (since, last_seq]. Response: `{ "changes": ["<base64>", ...],
   * "last_seq", "next" }` where `next` is the last returned seq — the
   * cursor to resume from (absent when the log is drained).
   */
  private async getChanges(url: URL): Promise<Response> {
    const since = parseCursor(url.searchParams.get("since"));
    if (since === null) return json({ error: "invalid since" }, 400);
    const limit = clampLimit(url.searchParams.get("limit"));

    const lastSeq = (await this.storage.get<number>("meta:nextSeq")) ?? 1;
    const lastStored = lastSeq - 1;
    if (since >= lastStored) {
      return json({ changes: [], last_seq: lastStored });
    }

    // Padded seqs keep lexicographic order equal to numeric order.
    // start is inclusive; end is treated as EXCLUSIVE (matches the
    // runtime's actual behavior — an inclusive end dropped the last
    // item in testing). The key after the last seq is safe under both
    // interpretations.
    const start = changeKey(since + 1);
    const end = changeKey(lastStored + 1);
    const listed: { seq: number; data: Uint8Array }[] = [];
    let next: number | undefined;
    const map = await this.storage.list({ start, end, limit });
    for (const [key, value] of map) {
      const seq = seqFromKey(key);
      listed.push({ seq, data: value as Uint8Array });
      if (listed.length === limit && seq < lastStored) {
        next = seq;
        break;
      }
    }

    const changes = listed.map((c) => base64Encode(c.data));
    return next === undefined
      ? json({ changes, last_seq: lastStored })
      : json({ changes, last_seq: lastStored, next });
  }

  // --- doc snapshot (bootstrap + compaction) -------------------------------

  /**
   * Bootstrap snapshot for fresh clients: `{ "snapshot": "<base64>",
   * "snapshot_seq": N }` where N is the seq up to which the snapshot
   * covers (changes after N are fetched via /changes?since=N). 404 when
   * no snapshot has been uploaded — clients then replay the full log.
   */
  private async getDocSnapshot(): Promise<Response> {
    const [snapshot, snapshotSeq] = await Promise.all([
      this.storage.get<Uint8Array>(DOC_SNAPSHOT_KEY),
      this.storage.get<number>(DOC_SNAPSHOT_SEQ_KEY),
    ]);
    if (!snapshot || snapshotSeq === undefined) {
      return json({ error: "no snapshot yet" }, 404);
    }
    return json({ snapshot: base64Encode(snapshot), snapshot_seq: snapshotSeq });
  }

  /**
   * Compaction upload: `{ "snapshot": "<base64>", "up_to": N }` — the
   * caller asserts the snapshot incorporates all changes up to seq N.
   * Stores the snapshot and truncates the log through N, so storage
   * stays proportional to recent activity. Order matters: snapshot is
   * written before the truncation, so a crash between the two leaves a
   * redundant (not missing) log tail.
   */
  private async postDocSnapshot(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as
      | { snapshot?: unknown; up_to?: unknown }
      | null;
    if (typeof body?.snapshot !== "string" || body.snapshot.length === 0) {
      return json({ error: "invalid snapshot" }, 400);
    }
    const bytes = base64Decode(body.snapshot);
    if (!bytes) return json({ error: "invalid base64 snapshot" }, 400);
    const upTo = body.up_to;
    if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0) {
      return json({ error: "invalid up_to" }, 400);
    }
    const lastStored = ((await this.storage.get<number>("meta:nextSeq")) ?? 1) - 1;
    if (upTo > lastStored) {
      return json({ error: `up_to ${upTo} exceeds last_seq ${lastStored}` }, 400);
    }

    await this.storage.put(DOC_SNAPSHOT_KEY, bytes);
    await this.storage.put(DOC_SNAPSHOT_SEQ_KEY, upTo);

    if (upTo > 0) {
      const doomed = await this.storage.list({
        start: changeKey(1),
        end: changeKey(upTo + 1),
      });
      if (doomed.size > 0) await this.storage.delete([...doomed.keys()]);
    }

    return json({ ok: true, snapshot_seq: upTo });
  }

  /** Allocate dense seqs and store one change per key, atomically. */
  private async appendChanges(changes: Uint8Array[]): Promise<number> {
    const nextSeq = (await this.storage.get<number>("meta:nextSeq")) ?? 1;
    const entries: Record<string, Uint8Array | number> = {};
    let seq = nextSeq;
    for (const data of changes) {
      entries[changeKey(seq)] = data;
      seq++;
    }
    entries["meta:nextSeq"] = seq;
    // One put = one transaction: counter and log move together. Safe
    // under input gates as long as no non-storage await separates the
    // read above from this put.
    await this.storage.put(entries);
    return seq - 1;
  }

  /**
   * Epoch GC: drop this stream's change rows with seq < `before`.
   *
   * Body: `{ "before": N, "machine_id": "..." }`. Idempotent.
   *
   * The change log is append-only by design; this is the one sanctioned
   * deletion, used by client-side epoch rolls (gzero research/comms.md)
   * to reclaim an abandoned epoch's rows. A replica that hadn't pulled
   * the truncated range loses it — that's intended: it re-syncs from
   * the new epoch's doc instead. `nextSeq` is untouched, so new pushes
   * keep their position; readers with cursors inside the deleted range
   * just get an empty response forward.
   */
  private async postTruncate(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as {
      before?: unknown;
      machine_id?: unknown;
    } | null;
    if (
      !body ||
      typeof body.before !== "number" ||
      !Number.isInteger(body.before) ||
      (body.before as number) < 1
    ) {
      return json({ error: "invalid before" }, 400);
    }
    const before = body.before as number;
    const nextSeq = (await this.storage.get<number>("meta:nextSeq")) ?? 1;
    const doomed: string[] = [];
    for (let seq = 1; seq < before && seq < nextSeq; seq++) {
      doomed.push(changeKey(seq));
    }
    // storage.delete reports how many keys actually existed, so the
    // count is truthful and re-truncation is a clean no-op.
    const deleted = doomed.length > 0 ? ((await this.storage.delete(doomed)) ?? 0) : 0;
    return json({ ok: true, deleted });
  }

  // --- SSE (live push trigger) -----------------------------------------------

  /** Fan an event string out to all current SSE subscribers. */
  private notify(event: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /**
   * `GET /events` — text/event-stream of push triggers.
   *
   * One event per successful POST /changes batch (`event: push`), plus
   * a comment heartbeat (~25s) to defeat idle timeouts. Data flows
   * only through /changes?since=; reconnecting clients re-pull from
   * their cursor, so dropped streams lose nothing. Subscribers live
   * in memory: a DO restart silently drops them and clients reconnect.
   */
  private getEvents(req: Request): Response {
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const listener = (event: string) => {
      controller?.enqueue(encoder.encode(event));
    };
    let controller: ReadableStreamDefaultController | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: async (ctl) => {
        controller = ctl;
        this.listeners.add(listener);
        // Hello event: confirms the stream is live and carries the
        // current log end, so a fresh subscriber can sync immediately.
        const lastSeq = ((await this.storage.get<number>("meta:nextSeq")) ?? 1) - 1;
        ctl.enqueue(
          encoder.encode(
            `retry: 2000\nevent: hello\ndata: ${JSON.stringify({ last_seq: lastSeq })}\n\n`,
          ),
        );
        heartbeat = setInterval(() => {
          try {
            ctl.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            // stream already closed; cleanup happens in cancel
          }
        }, 25_000);
      },
      cancel: () => {
        this.listeners.delete(listener);
        if (heartbeat !== undefined) clearInterval(heartbeat);
      },
    });

    // Client disconnects that don't surface as cancel() still end the
    // request — abort also cleans up.
    req.signal?.addEventListener("abort", () => {
      this.listeners.delete(listener);
      if (heartbeat !== undefined) clearInterval(heartbeat);
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  // --- legacy atom merge ----------------------------------------------------

  private async postEvents(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    if (!validOps(body)) return json({ error: "invalid ops" }, 400);
    await this.ensureLoaded();
    const changed = this.merge.apply(body as Op[]);
    if (changed) this.dirty = true;
    await this.schedulePersist();
    return json({ ok: true, changed });
  }

  private async postSnapshotUpload(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || (body as Snapshot).version !== 1)
      return json({ error: "invalid snapshot" }, 400);
    await this.ensureLoaded();
    const changed = this.merge.absorb(body as Snapshot);
    if (changed) this.dirty = true;
    await this.schedulePersist();
    return json({ ok: true, changed });
  }

  private async getSnapshot(): Promise<Response> {
    await this.ensureLoaded();
    return json(this.merge.snapshot());
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (this.dirty) {
      await this.storage.put(SNAPSHOT_KEY, JSON.stringify(this.merge.snapshot()));
      this.dirty = false;
    }
  }

  /** Persist ~1s after the last batch (re-scheduled on later batches). */
  private async schedulePersist(): Promise<void> {
    const current = await this.storage.getAlarm();
    const due = Date.now() + PERSIST_DEBOUNCE_MS;
    if (current === null || current > due) await this.storage.setAlarm(due);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- change-log helpers -----------------------------------------------------

const SEQ_PAD = 16;

/** `chg:<seq>` zero-padded to SEQ_PAD digits: list order == seq order. */
function changeKey(seq: number): string {
  return `chg:${String(seq).padStart(SEQ_PAD, "0")}`;
}

function seqFromKey(key: string): number {
  return Number(key.slice("chg:".length));
}

function parseCursor(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function clampLimit(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 200;
  return Math.min(Math.floor(n), 1000);
}

function base64Encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
