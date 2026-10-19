# sync-daemon — constant, live, fan-out sync

*2026-10-19. Handoff doc: this work is picked up on nick-MacPro5-1
(Al Grater). Written after assessing iroh 1.0 against the goal below —
full analysis in `iroh-assessment.md`; hub endpoints in `hub-v0.md`.*
*Companion: `comms.md` (the comms bag rides the same transport).*

## Goal

Each machine may or may not be on. Sync should be **constant** (no
lost updates, ever, regardless of uptime overlap), **live** (~seconds,
not "next time that machine writes"), **fan-out** (one write reaches
all peers). Machines today: MacBookAir (Air Apparent) + MacPro tower
(Al Grater); phone client planned.

## Decisions reached (do not re-litigate without a new fact)

1. **Keep automerge as the engine.** CRDT + change log + cursors +
   hub-as-durable-anchor already solves *constant*: offline writes
   queue in the doc, the hub holds every change, convergence is tested
   (`scripts/mcp-convergence-test.sh`). Swapping engines (iroh-docs)
   was evaluated and rejected — different merge semantics (wall-clock
   LWW), pre-1.0 crates, no store-and-forward without an anchor.
2. **The hub stays the anchor.** D1 change log = the offline queue.
   Live push is added *in front of* it, not instead of it.
3. **The daemon is the unlock, not the transport.** No gzero process
   listens between sessions — the MCP server opens the doc per call
   and dies with the session. Every path to "live" (hub SSE, iroh,
   anything) needs a resident per-machine process first.
4. **iroh is deferred, optional.** Revisit only as a direct-P2P fast
   path under the same engine (tower as seed for the phone). Not
   required for this goal. See `iroh-assessment.md`.
5. **Push trigger = hub SSE.** `hub-v0.md` already lists SSE
   `/bag/{bag}/events` as a v0.1 add. Cheapest correct trigger; no new
   dependency stack (plain HTTP streaming).

## Current state (audited 2026-10-19, MacBookAir checkout)

- Sync is **pull-on-write**: each MCP call pushes then pulls via
  `SyncCursor` (`src/hub_changes.rs`, `push`/`pull`). An idle machine
  never syncs — latency unbounded. This is the gap.
- Hub v0 deployed (D1 change log, per-bag). Endpoints: push changes,
  pull `?since=seq`, snapshot get/put. **No SSE endpoint yet.**
- Sync primitives tested: `apply_changes` / `get_changes(have)` /
  `changes_for` on `AutomergeStore`; two-replica convergence through a
  local hub passes.
- Both machines migrated to the automerge doc (bag `context`);
  comms bag live on this machine. Cursors persist in the sidecar next
  to the doc.
- No resident process exists anywhere in the stack.

## Step 0 — decided: silent refresher with central doc lock

*Decided 2026-10-19 (Al Grater box). Front-door is disproportionate:
it would move the whole mutation surface (~7k lines of atoms, workflow,
comms and session logic) behind IPC, for a problem that only exists on
the receiving side — sessions already push on every write. So:

- **Sessions keep writing the doc files directly.** `gzero-syncd` only
  pulls/applies; it never writes unless a pull brought changes.
- **The two-writer race is closed structurally, not by convention.**
  `AutomergeStore` holds a `<doc>.lock` flock file description and
  locks it around each flush and each sync transaction — never for a
  store's lifetime (the MCP comms store is long-lived; lock-at-open
  would starve the daemon). flock re-locks on the same fd instantly,
  so nested lock (sync → apply → flush) doesn't deadlock.
- **Merge-on-flush** is the core fix: before saving, `flush()` merges
  whatever is on disk into the in-memory doc (a stale session cannot
  clobber a daemon-applied pull) and writes via temp+rename so
  concurrent readers never see a torn document.
- **`hub_changes::sync_store`** is the one lock-cursor-sync-save
  transaction; sessions, the CLI and the daemon all go through it.
- Presence heartbeats stay with the sessions (the live things); the
  daemon does not do presence.

## Plan

### 0. First decision: single-writer

Sessions write the doc file directly today. A daemon writing the same
file concurrently risks file-level lost updates. Pick one:

- **Front door (recommended):** `gzero-syncd` becomes the doc's sole
  writer; MCP server / CLI read through it over local IPC (Unix
  socket; the automerge doc lives in the daemon, sessions get
  snapshots/read models). Cleanest, enables presence + push-to-session
  later, biggest change to call sites.
- **Silent refresher:** daemon only pulls/applies, sessions keep
  writing, an advisory file lock arbitrates (daemon takes the lock
  only to pull-apply-save; a session's write waits or the daemon
  retries). Minimal call-site change; keeps the two-writer race window
  smaller but not zero — audit `AutomergeStore::open` save paths.

Write the choice into this doc before step 2; it determines the IPC
surface.

### 1. Hub: SSE endpoint

- `GET /bag/{bag}/events` — stream `{last_seq, machine}` events on
  every push; bearer `CX_TOKEN`; heartbeat/comment lines for idle
  keepalive; reconnect handled client-side with `Last-Event-ID` or
  plain re-pull `since=` on connect (preferred: reconnect = normal
  pull, SSE is only a trigger, never a data channel).
- Small: the DO already sees every push; emit after append.

### 2. `gzero-syncd` (new bin)

- Owns the doc path + `SyncCursor` sidecar; loop: hold SSE stream →
  on event: `pull` → `apply` → save; also periodic pull (e.g. 60s
  jittered) as SSE-failure backstop; on any local change signal (if
  front-door model, the daemon sees writes itself) → `push`.
- Startup: on boot, one full push+pull (covers everything missed while
  offline — SSE is only the live accelerator; correctness never
  depends on it).
- LaunchAgent on both machines (`launchd`; both are macOS). Log to
  `~/Library/Logs/gzero-syncd.log`; crash-only design (cursors in
  sidecar = restart-safe).
- Config via existing env (`CX_HUB_URL`, `CX_TOKEN`, `CX_WS_DB`,
  `CX_COMMS_BAG`).

### 3. Acceptance

- Write on A → visible on B in ≤2s while both daemons run.
- A offline during B's writes → A's daemon catches up on boot within
  one cycle, no loss (overlap-independence = the constant guarantee).
- Kill -9 the daemon mid-apply → restart converges (cursor discipline).
- Existing `mcp-convergence-test.sh` still green.

## Daemon-owned GC (packing)

The daemon is the natural owner of doc compaction — the `packing`
design (`gzero ws show packing fluid-notion-labs/contextual`, sketched
2026-10) already covers it: fold the doc to its current view, write a
fresh doc (atoms + tombs + sections + items), atomic swap. The daemon
adds the hub half: `POST /bag/{bag}/snapshot` with the packed doc and
`up_to = last_seq` — the endpoint already truncates the change log
(gzero-hub `src/bag.ts`), no client calls it yet.

- **Epoch counter** in doc + snapshot (packing's key decision): after
  a pack, peers detect "no shared history" and re-bootstrap from the
  snapshot instead of change-syncing. The comms epoch roll is the
  working precedent.
- **Never pack away tombstones inside the TTL window** — early
  collection resurrects deletions on merge with a peer that hasn't
  seen them.
- **Trigger policy is a seam**: size > N MB or M changes since last
  pack is enough to start; change the strategy later without touching
  the mechanism.
- **Do not** build an SQLite incremental store for this: with
  load-once and packing bounding doc size, debounced whole-file saves
  are milliseconds; an append-log + replay path is a second storage
  format solving the cheap half of the problem.
- **Hard invariant from the rebuild (round 2):** at startup the daemon
  reloads state from disk/hub and never pushes from memory loaded
  before an external reset — an in-memory holder that wins the
  truth contest silently resurrects deleted data.

## Out of scope (here)

iroh transport, mobile client, multi-user ACL, epoch-roll changes.
The comms bag gets live fan-out for free once the daemon syncs it too
(it already rides the same HubChanges transport under bag `comms`).

## Status update (2026-10-19, built and tested on the Al Grater box)

- **Hub SSE shipped** (`gzero-hub` f0ad175): `GET /bag/{bag}/events`
  streams `hello` (carries current `last_seq`) on connect, one `push`
  event per successful `POST /changes` batch, comment heartbeat ~25s.
  Trigger only — subscribers pull `/changes?since=`; reconnect
  re-pulls, so a dropped stream or DO restart loses nothing.
- **`gzero-syncd` shipped** (`src/bin/gzero-syncd.rs`): boots with one
  full pull+push per bag (context @ CX_WS_DB, comms @ CX_COMMS_DB),
  then one SSE listener thread per bag waking an immediate sync on
  push, with a jittered-free 60s backstop (`CX_SYNCD_BACKSTOP_SECS`)
  as the SSE-failure path. SSE reconnect uses capped exponential
  backoff; a 90s read timeout (3 missed heartbeats) catches
  silently-stalled connections. No hub config → exit non-zero
  (the service supervisor retries).
- **Acceptance passed** (`scripts/syncd-convergence-test.sh`, local
  `wrangler dev` hub): A writes → B sees it within the 3s window with
  the backstop at 60s (so the arrival proves the SSE trigger, not the
  backstop); kill -9 the daemon mid-stream → restart converges with
  nothing lost. `mcp-convergence-test.sh` still green.
- **Service install shipped**: `install.sh` step 8 installs the
  LaunchAgent (`com.gzero.syncd`, KeepAlive, log at
  `~/Library/Logs/gzero-syncd.log`) on macOS and a systemd user unit
  on Linux; `--no-daemon` skips. The plist/unit embed the hub token
  and are chmod 600.
- Not yet done: run install.sh on the MacBook (Air Apparent) — the
  daemon, SSE endpoint and unit install are all done on the Al Grater
  box. Real-edge SSE verified (hello + push events through the
  production worker; daemon pulled a comms probe within seconds of a
  remote push).

## Open questions

- ~~Front-door vs silent-refresher (step 0)~~ — decided, see above.
- ~~Does the daemon also own session presence heartbeats (comms bag)?~~
  No — presence stays with sessions (they're the live things).
- ~~SSE through Cloudflare workers: buffering surprises~~ — verified
  with `wrangler dev`: the local acceptance sees sub-3s arrivals.
  Real-edge check remains with the production deploy.
