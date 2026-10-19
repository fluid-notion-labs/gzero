import { Stream } from "./stream";

// Wrangler resolves the Durable Object class from the main module.
export { Stream } from "./stream";

export interface Env {
  STREAM: DurableObjectNamespace;
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

    return json({ error: "not found" }, 404);
  },
};

/** Extract "stream:<name>" from /stream/{name}/... paths; null otherwise. */
export function streamFromPath(path: string): string | null {
  const m = /^\/stream\/([a-zA-Z0-9._-]+)\/(changes|snapshot|truncate|events)$/.exec(path);
  return m ? `stream:${m[1]}` : null;
}

function stubFor(env: Env, stream: string): DurableObjectStub {
  return env.STREAM.get(env.STREAM.idFromName(stream));
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
