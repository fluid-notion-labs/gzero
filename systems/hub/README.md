# gzero-hub

v0 of the gzero hub: the Cloudflare Worker + Durable Object that
carries gzero state between machines. Design and plan live in gzero's
`research/hub-v0.md` and the gzero work items (`b468` epic).

The hub is a change log, not a merge engine: each stream (one per doc,
plus `global`) is a Durable Object holding an append-only log of
automerge changes and a bootstrap snapshot. Convergence is guaranteed
by automerge on the clients; the hub only orders, stores, and serves.
The legacy `/events` + `/snapshot` wire format (gzero's `src/hub.rs`)
is served by the `stream:legacy-global` DO, which keeps the old server-side
atom merge so existing clients work unchanged during the D1 migration.

## Endpoints

- `GET /health`
- `POST /stream/{name}/changes` — append a batch of changes → `{last_seq}`
- `GET /stream/{name}/changes?since=N` — changes after a cursor
- `GET /stream/{name}/snapshot` — bootstrap snapshot
- `POST /stream/{name}/snapshot` — compaction upload (stubbed in v0)
- `POST /events`, `GET /snapshot` — legacy wire format (global legacy stream)

Auth: `Authorization: Bearer $TOKEN` on everything but `/health`
(set as a Wrangler secret in production; `vars.TOKEN` in dev/tests).

## History note

This repo began as `contexture-hub` (the deployed hub-in-server-mode
Worker whose source was believed lost — it wasn't; see plan3 finding
8). v0 rebuilds it as the change-log hub described above, keeping the
legacy protocol.

## Development

- `npm install`
- `npm run dev` — local wrangler dev server
- `npm test` — vitest against miniflare (`@cloudflare/vitest-pool-workers`)
- `npm run typecheck`
- `npm run deploy` — deploy to workers.dev

Auth: `.dev.vars` holds the fake dev token (`TOKEN=token`) used by
`npm run dev` and tests. Production sets a real secret:

```sh
wrangler secret put TOKEN
```

Clients authenticate with `Authorization: Bearer <TOKEN>`.

## Deployment

Live at `https://gzero-hub.nick-hems.workers.dev` (workers.dev).
Clients set `CX_HUB_URL` and `CX_TOKEN` to sync; the gzero D1 client
(`gzero` repo, `src/hub_changes.rs`) is exercised end-to-end by the
two-replica convergence test against this deployment.

Acceptance harness: `scripts/two-replica-test.sh` boots a local hub
and runs the Rust convergence test against it.
