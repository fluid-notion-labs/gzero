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

## Out of scope (here)

iroh transport, mobile client, multi-user ACL, epoch-roll changes.
The comms bag gets live fan-out for free once the daemon syncs it too
(it already rides the same HubChanges transport under bag `comms`).

## Open questions

- Front-door vs silent-refresher (step 0) — decide first.
- Does the daemon also own session presence heartbeats (comms bag)?
  Natural fit if front-door; keep separate if refresher.
- SSE through Cloudflare workers: confirm no buffering surprises
  (workers can stream; verify with `wrangler dev` early).
