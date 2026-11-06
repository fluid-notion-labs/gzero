/**
 * hub-client.ts — comms transport B client (addressed pull).
 *
 * Reads the hub's inbox/broadcast endpoints directly (gzero item 64cd:
 * server-side dest filtering over the hub's SQLite-backed Inbox DO, so
 * each client pays only its own inbox — the change-log transport pulls
 * the full stream). Selected when CX_COMMS_TRANSPORT=inbox and the hub
 * answers; otherwise the MCP poller stays the data source, so during
 * the transition reads and writes always come from the same store.
 *
 * Cursors are in-memory last-seq per feed: the bar's model tracks known
 * entries itself, and a poller restart just re-reads recent history.
 */
import { INBOX_POLL_MS } from "./inbox-bar.ts";

/** A hub inbox page (GET /inbox/<dest>/messages?since=<seq>). */
export interface HubMessage {
  id: string;
  sender: string;
  text: string;
  created: number;
  seq: number;
  read_at: number;
}

export interface HubBroadcast {
  id: string;
  sender: string;
  text: string;
  created: number;
  seq: number;
  seen_at: number;
}

export interface HubFeed<T> {
  items: T[];
  last_seq: number;
}

/** Parse one hub feed response; null when malformed. */
export function parseHubFeed<T>(json: unknown, key: string): HubFeed<T> | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj[key]) || typeof obj.last_seq !== "number") return null;
  return { items: obj[key] as T[], last_seq: obj.last_seq };
}

/** Map hub rows to the bar's snapshot shape (mirrors msg_inbox JSON). */
export function toSnapshot(
  messages: HubMessage[],
  broadcasts: HubBroadcast[],
): {
  messages: Array<Record<string, unknown>>;
  broadcasts: Array<Record<string, unknown>>;
} {
  return {
    messages: messages.map((m) => ({
      id: m.id,
      dest: "",
      sender: m.sender,
      text: m.text,
      created: m.created,
      read_at: m.read_at,
    })),
    broadcasts: broadcasts.map((b) => ({
      id: b.id,
      sender: b.sender,
      text: b.text,
      created: b.created,
      seen_at: b.seen_at,
    })),
  };
}

/**
 * Addressed-pull poller: one HTTP GET per feed per poll — no MCP
 * spawn, no doc load, no pull-all. Server-side dest filtering means
 * the bytes are the session's own inbox, nothing else.
 */
export class HubPoller {
  private base: string;
  private token: string;
  private sessionId: string;
  private msgCursor = 0;
  private bcastCursor = 0;

  constructor(base: string, token: string, sessionId: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
    this.sessionId = sessionId;
  }

  /** Whether the hub speaks transport B (probe once, cheap). */
  async supported(): Promise<boolean> {
    try {
      const r = await this.get(`/inbox/${this.sessionId}/messages?since=0&limit=1`);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** One poll: pull both feeds past the cursors, return the snapshot
   * the bar model already understands. Null on transient failure. */
  async poll(): Promise<InboxSnapshotLike | null> {
    let mFeed: HubFeed<HubMessage> | null;
    let bFeed: HubFeed<HubBroadcast> | null;
    try {
      [mFeed, bFeed] = await Promise.all([
        this.pull<HubMessage>(
          `/inbox/${this.sessionId}/messages`,
          this.msgCursor,
          "messages",
        ),
        this.pull<HubBroadcast>("/broadcasts", this.bcastCursor, "broadcasts"),
      ]);
    } catch {
      return null;
    }
    if (!mFeed || !bFeed) return null;
    this.msgCursor = Math.max(this.msgCursor, mFeed.last_seq);
    this.bcastCursor = Math.max(this.bcastCursor, bFeed.last_seq);
    return toSnapshot(mFeed.items, bFeed.items);
  }

  private async pull<T>(
    path: string,
    since: number,
    key: string,
  ): Promise<HubFeed<T> | null> {
    const r = await this.get(`${path}?since=${since}&limit=200`);
    if (!r.ok) throw new Error(`hub ${path}: ${r.status}`);
    const body: unknown = await r.json();
    return parseHubFeed<T>(body, key);
  }

  private async get(path: string): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
}

/** Minimal structural view of the bar's InboxSnapshot (parseInbox owns
 * the strict shape; hub rows are pre-mapped to match it). */
export interface InboxSnapshotLike {
  messages: Array<Record<string, unknown>>;
  broadcasts: Array<Record<string, unknown>>;
}

export { INBOX_POLL_MS };
