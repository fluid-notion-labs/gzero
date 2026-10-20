# gzero-hub v0 — status & plan

*2026-10-19 update: "bags" renamed to **streams** across the hub and
core (item 7ace). Wire is now `/stream/{name}/…`, DO ids
`stream:<name>`; a `project/<scope>` stream is a project, `context`
and `comms` are system streams. Deployed with the change-log history
wiped and recreated from local replicas — the two-replica acceptance
and the comms epoch test both pass against the new wire. Docs below
keep their original dates but use the new names.*

*2026-10-18. Written for the start of hub work: v0 of `gzero-hub` (the
Cloudflare Worker + Durable Object that carries gzero state between
machines) and the mobile client. Status section reflects a fresh audit
of this checkout; plan section supersedes plan3's Track D sketch with
concrete v0 scope.*

## Status (audited 2026-10-18, this checkout)

**D1 shipped (2026-10-19, items 9a8f…23c0): the automerge doc is the
context store, synced through the hub's D1 change log.**

- gzero-hub v0 is deployed at `https://gzero-hub.nick-hems.workers.dev`
  (auth via `CX_TOKEN`; prod token in `~/.config/gzero/hub-token`).
- gzero: `sync_once` (pull-first) + `SyncCursor` sidecar; `migrate-db`
  imports SQLite atoms into the doc (idempotent, per-source
  provenance); atoms live in the same doc as sections/items; the MCP
  server and CLI default to the doc, opening it per call and syncing
  on every write; `CX_LEGACY_DB=1` is the SQLite rollback hatch.
- Acceptance: `scripts/mcp-convergence-test.sh` (two MCP processes
  converge through a local hub); production verified with two cold
  replicas on one stream. This machine migrated 976 atoms / 28 sources /
  90 tombstones and pushed them (stream `context`).
- Still open: second machine cutover (pull, cargo install,
  migrate-db, sync); legacy hub `/events`+`/snapshot` endpoints and
  `gzero pull`/`push` remain until it's done — see the
  `distributed-architecture-debt` ledger.

**Core (Rust, `src/`) — W0–W4 shipped, W5 in progress.**

- Automerge is the engine core: `src/automerge_store.rs` (589 lines)
  implements `Storage` on automerge 0.12, passing the same Storage
  contract tests as SQLite. **The client-side change-sync primitives
  already exist and are tested**: `apply_changes(Vec<Change>)` and
  `get_changes(have)` — a replica can diff and merge against any peer.
  This is the hard part of Track D1, already done.
- Workflow system: W1 sections-as-records, W2 work items (LWW fields,
  OR-set labels, typed edges, ready/blocked folds), W3 injection
  (`item_pin`, `plan_next`, the pi workflow pane), W4 ranking/gates
  (`item_rank`, WIP limit, gates — body of plan3 records it done; the
  plan3 TODO checkbox is stale, reconcile when W5 lands).
- W5 (doc-set migration into the stream) still open; independent of hub
  work.

**Sync today — atoms only, snapshot-based, hub source missing.**

- Atoms sync via snapshot JSON (`sync/atoms.json`, `cx absorb`) and,
  when configured, the deployed hub Worker (`CX_HUB_URL`/`CX_TOKEN` →
  `post_events`, `fetch_snapshot` in `src/hub.rs`). On this machine
  `CX_HUB_URL` is **unset** — hub sync is configured nowhere right now.
- Workflow docs (sections + items) do NOT sync: `context.ws` is copied
  between machines by hand (`sync/SETUP.md` step 4 warns to reconcile
  manually). This is Track D, deferred.
- ~~The deployed Worker's source is not in any known repo~~ **Resolved
  2026-10-18**: the source lives at `fluid-notion-labs/gzero-hub`
  (commit e0f48e9, "contexture-hub", pushed 2026-10-10). Whether the
  deployed Worker is still live and on which route remains an open
  question.

**Mobile client — design only.** `research/flutter-client.md` specifies
the plane stack (Surface / App state / Lattice / Local replica /
Transport / Hub+Sync DO) with a 3D diagram built in scene-mcp. No code.

## Decisions for v0

1. **`gzero-hub` is the existing repo.** *(Corrected 2026-10-18, after
   this section was written: the old Worker's source was found on
   GitHub — `fluid-notion-labs/gzero-hub` commit e0f48e9,
   "contexture-hub", pushed 2026-10-10 — resolving plan3 finding 8.
   v0 evolves that repo in place with history intact, not a new repo.
   The original text said the source was lost and called for a
   rewrite.)* **Superseded 2026-10-20 (repo unification):** the hub no
   longer evolves as a standalone repo — it was copied into the gzero
   monorepo at `systems/hub/` without history; the standalone
   `fluid-notion-labs/gzero-hub` stays on GitHub as archive/reference.
   The repo is TypeScript, Wrangler, Worker + Durable
   Object; its old server-side atom merge (`src/merge.ts`) is kept for
   the legacy `stream:legacy-global` path.
2. **The hub is a change log, not a merge engine (v0).** The DO stores
   an append-only log of automerge changes per stream + a bootstrap
   snapshot. Merge happens client-side (automerge is already
   convergence-guaranteed); the DO only needs ordering and fan-out.
   Clients send `get_changes(have)` output and apply `apply_changes`.
   Lattice/OR-set logic stays in clients — no server-side merge to get
   wrong.
3. **Snapshot endpoint stays.** v0 keeps `POST /events` /
   `GET /snapshot` working (compat with `src/hub.rs` as deployed) and
   adds the change endpoints. Old clients keep working during the D1
   migration.
4. **Streams are per-scope.** A stream = one repo scope (the existing
   `repo_identity` concept) + the global stream. The DO id derives from
   the stream name (`stream:<name>`), one DO instance per stream.

## gzero-hub v0 — scope

- **`POST /stream/{name}/changes`** — append a batch of automerge changes
  (binary chunks, base64 or raw body). Returns the new highest seq.
- **`GET /stream/{name}/changes?since=SEQ`** — changes after a cursor,
  chunked. Client loop: `get_changes(have)` → push; `since=last_seq`
  → pull → `apply_changes`.
- **`GET /stream/{name}/snapshot`** — full doc snapshot for bootstrap
  (fresh machine / first sync), built from the change log.
- **`POST /stream/{name}/snapshot`** — compaction: client uploads a
  collapsed snapshot; DO truncates the log up to the snapshot point.
  (v0 can stub this; log stays small for a long time.)
- **Auth:** existing `CX_TOKEN` bearer, per-stream write ACL v0 = single
  user (all machines are the user's). Machine registry: machines
  announce `{machine_id, last_seq}` on push (flutter-client.md's
  machine registry plane).
- **SSE** `/stream/{name}/events` — notify pullers a push happened (v0
  optional; polling `since=` is enough for v0, SSE is a v0.1 add).
- **Persistence:** DO storage (SQLite-backed) for the change log;
  changes are immutable so writes are append-only puts.

**Acceptance:** two Rust replicas (existing `AutomergeStore`) converge
through the hub — make a change on A, pull on B, see it; make a
conflicting edit on both, pull both ways, converge without loss. This
is the D1 acceptance, testable entirely on one machine against a
local `wrangler dev`.

## Mobile client v0 — scope

Per `research/flutter-client.md`, trimmed to the knowledge plane:

- Stream replica on-device: atoms + tombstones in SQLite keyed by atom
  text, OR-set union with tombstones on merge (the Lattice plane).
- Sync controller: pull → merge → push loop against hub v0 endpoints,
  offline queue with retry/backoff, `CX_TOKEN` device token.
- Surface: stream screen (atom list, tag chips), resolve preview, sync
  status card (last push/pull, pending count).
- **Out of scope for v0:** workflow docs (sections/items) — those ride
  D3 after D1 stabilizes; editing is limited to add/remove atoms.

**Acceptance:** phone and this machine converge an atom edit in under
a minute with the app foregrounded; airplane-mode edit lands on
reconnect.

## Sequencing

1. **gzero-hub v0** (new repo, `wrangler dev` locally, deploy to
   workers.dev when green).
2. **D1 in gzero:** point `AutomergeStore` sync at the change
   endpoints (new `hub.rs` path behind a flag), test two local
   replicas, then flip the default store + set `CX_HUB_URL` on both
   machines.
3. **Mobile client v0** (Flutter, per the plane-stack doc).
4. Later: SSE fan-out, snapshot compaction, workflow-doc sync (D3),
   multi-user ACL.

## Open questions

- Where was the old Worker deployed (account/subdomain)? If the
  deployed URL is still alive, capture its route before it rots — it
  is the only working reference for the snapshot protocol's edge
  cases.
- Change batching limits: DO storage value size (~128 KB/value) means
  large change batches must split — encode batches as one change per
  storage key, seq-ordered, rather than one giant value.
- Does `cx` CLI need `cx push --changes` / `cx pull --changes` verbs
  in D1, or does the MCP server own sync? (plan3: CLI has no ws verbs;
  sync lives in `cx sync`/`cx pull` today.)
