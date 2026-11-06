import { Inbox } from "./inbox";
import { Stream } from "./stream";

// Wrangler resolves the Durable Object class from the main module.
export { Inbox, Stream };

export interface Env {
  STREAM: DurableObjectNamespace;
  INBOX: DurableObjectNamespace;
  TOKEN: string;
}

/**
 * gzero-hub: a change log, not a merge engine.
 *
 * Per-stream Durable Objects ("stream:<scope>") hold an append-only log of
 * automerge changes plus a bootstrap snapshot; convergence is
 * guaranteed client-side by gzero's AutomergeStore. The legacy
 * /events + /snapshot wire format (gzero's src/hub.rs) is served by
 * the "legacy-global" DO, which keeps the old server-side atom merge so
 * existing clients keep working during the D1 migration.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ status: "ok" });

    const denied = auth(req, env);
    if (denied) return denied;

    // Legacy wire format → global stream, path rewritten so the DO can
    // tell legacy /events + /snapshot apart from the per-stream endpoints
    // (which collide for the global stream).
    if (url.pathname === "/events" || url.pathname === "/snapshot") {
      const legacy = new Request(`https://do/legacy${url.pathname}`, req);
      return stubFor(env, "stream:legacy-global").fetch(legacy);
    }

    // Per-stream change-log endpoints: strip the /stream/{name} prefix; the
    // DO already knows its stream identity from its name. Preserve the
    // query string (cursors, limits) — a Request init doesn't carry it.
    const stream = streamFromPath(url.pathname);
    if (stream) {
      const kind = url.pathname.split("/").pop(); // changes | snapshot | events
      const internal = new Request(`https://do/${kind}${url.search}`, req);
      return stubFor(env, stream).fetch(internal);
    }

    // Comms transport B: addressed mailbox, broadcasts, presence — one
    // SQLite-backed DO, server-side dest filtering (gzero item 64cd).
    if (/^\/(inbox|broadcasts?|presence)/.test(url.pathname)) {
      const internal = new Request(`https://do${url.pathname}${url.search}`, req);
      return stubFor(env, "inbox:global").fetch(internal);
    }

    return json({ error: "not found" }, 404);
  },
};

/** Extract "stream:<name>" from /stream/{name}/... paths; null otherwise. */
export function streamFromPath(path: string): string | null {
  const m = /^\/stream\/([a-zA-Z0-9._-]+)\/(changes|snapshot|truncate|events)$/.exec(path);
  return m ? `stream:${m[1]}` : null;
}

function stubFor(env: Env, stream: string): DurableObjectStub {
  const ns = stream.startsWith("inbox:") ? env.INBOX : env.STREAM;
  return ns.get(ns.idFromName(stream));
}

function auth(req: Request, env: Env): Response | null {
  if (req.headers.get("authorization") !== `Bearer ${env.TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
