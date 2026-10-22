# Track S v1 — cross-machine messaging on its own automerge stream

*2026-10-19. Design for taking S1–S3b cross-machine. Written after a working
session that audited the messaging stack, tested local delivery, and chose
the transport. Item: cross-machine messaging (see the work item's design
link).*

## Status audit (2026-10-19)

- S1 presence, S2 handoff, S3 messages, S3b broadcasts: implemented, tested,
  **machine-local only**. Storage is `~/.pi/agent/context.db` — the legacy
  SQLite comms store (`CX_LEGACY_DB=1` rollback hatch, slated for removal).
  Nothing syncs those tables; they never enter snapshots.
- The hub (`gzero-hub` v0, deployed) transports exactly one thing: the
  automerge change log of the ws doc, per **stream** (stream `context` in use).
  Change log in D1, merge engine client-side (automerge), per-stream endpoints
  already parameterized (`StreamSync::from_env(stream)`).
- No Track S plan exists in hub-v0 or plan3 — this document is it.
- Tested in-session: local delivery works (message between two sessions on
  one machine, seen unread in the store, delivered on next `resolve`).

## Decision: a second automerge stream, `comms`

Cross-machine messaging keeps the same architecture as the context store —
its **own** automerge doc, synced through the hub's existing change-log
endpoints under stream name `comms`.

Why not hub-native ephemeral rows (plain D1 + server TTL): messages would
need the machine online at send time, a second transport to build and
maintain, and the mobile client would need a second protocol. The automerge
path reuses `StreamSync`, cursors, the convergence tests, and gives
offline-first sends for free (queue locally, sync when the hub is reachable).
Concurrent sends from two machines both survive — correct chat semantics.

Why not inside the `context` doc: chat is high-churn and ephemeral; it must
not slow `resolve`, bloat the durable store, or mix its tombstones into
context data. A separate doc isolates all of it.

## The ephemeral problem: epochs, not tombstones

Automerge cannot forget. A 7-day TTL enforced by deletion is impossible in
an append-only change log; naive tombstoning grows forever. Design:

- **TTL is client-side**: consumers ignore messages older than
  `MESSAGE_TTL_SECS` (7 days, unchanged). The doc may still hold them.
- **Epochs roll the doc**: when dead weight accumulates (heuristic: expired
  messages exceed a size/count threshold, or age > TTL), a replica mints a
  fresh epoch doc containing only live messages, records
  `epoch = {n, base_seq}` in the doc, and calls a new hub endpoint to
  truncate the stream's change log below the new epoch's base seq.
- Convergence holds because every replica pulls the same log from the same
  cursor domain; a replica with an older cursor simply re-syncs into the new
  epoch (its pre-epoch changes are rejected/no-op against the truncated log).
- Sweeping (`sweep_messages`) becomes the epoch-roll trigger instead of
  `DELETE`.

## Data model (in the comms doc)

Maps keyed by message id; messages are create-only (no edits), so the model
is trivially CRDT-friendly:

- `messages: Map<id -> {dest, sender, text, created}>` — inserts only.
- `reads: Map<id -> Map<session -> read_at>>` — LWW per (message, session);
  read receipts are the only mutable field.
- `broadcasts: Map<id -> {sender, text, created}>` — inserts only.
- `broadcast_reads: Map<broadcast -> Set<session>>` — OR-set, per-session
  drain.
- `epoch: {n, base_seq}` — GC bookkeeping.

No scope column: comms are machine-global, matching today's table shape.
`dest` is the **team member id** (see addressing below).

## Presence & addressing

- **[built]** Presence (S1) rides the **comms doc** (not the context doc as
  first drafted — same isolation argument as chat: presence churn shouldn't
  touch the durable store). Rows are the `sessions` map; staleness is
  client-side (`PRESENCE_TTL_SECS`), old rows drop at epoch roll
  (`PRESENCE_ARCHIVE_TTL_SECS`, 30 days). Heartbeat stays piggybacked on
  `resolve`; `sessions`/resolve read it — and because the doc syncs, the
  roster is now **cross-machine**.
- **[deferred]** Addressing by member id: v1 keeps **dest = session id**
  (already globally unique, and now visible cross-machine via the synced
  presence rows). Member-id addressing is a thin layer once a
  member → live-session mapping is needed; the teams scopes remain the
  long-term address book.

## Hub integration

- **[built]** Existing per-stream change endpoints work as-is for stream
  `comms`; auth is the same `CX_TOKEN`.
- **[built]** New endpoint: `POST /stream/{name}/truncate {"before": N}` in
  gzero-hub — deletes change rows with seq < `before`, count-truthful and
  idempotent, `nextSeq` untouched so pushes keep their position. The one
  sanctioned deletion in the append-only log.
- Live push (DO websockets) stays a separate, later item — needed for
  real-time delivery under any storage choice. v1 delivery: sync at
  session start and best-effort after every write, pull at `resolve`.

## Implementation (built)

- `comms.rs`: `CommsStore` — an `AutomergeStore` at its own path
  (`~/.pi/agent/comms.ws`, `CX_COMMS_DB` override) + `SyncCursor` sidecar,
  stream `comms` (`CX_COMMS_STREAM` override for isolated test runs). The
  `CommsLayer` trait abstracts the S1–S3b surface: `CommsStore` (doc) and
  `SqliteStore` (legacy tables) both implement it, so `CX_LEGACY_DB=1`
  stays the rollback hatch and in-memory tests can use either backend.
- `mcp.rs`: the App comms handle is a `CommsHandle` enum over both
  backends; same tool surface, no client-visible changes. Sync runs at
  session start and best-effort after every write — the sender's process
  may exit right after sending, so the write must reach the hub then;
  offline failures are ignored and queue locally.
- CLI: `gzero sessions` reads the doc store.
- Legacy comms tables: dropped with the rest of the SQLite path when
  `CX_LEGACY_DB=1` is removed. No migration — ephemeral data dies with it.

## Testing

- Extend the two-replica pattern of `scripts/mcp-convergence-test.sh`:
  two comms replicas converge through the local hub (send on one, read on
  the other; read receipts propagate back).
- **[built]** Live-delivery leg: recipient's gzero-syncd running (SSE path);
  the sender sends and the recipient's doc has the message within seconds.
  Recipient reads are one-shot/local so only the daemon can have delivered.
- **[built]** Offline leg: hub down at send time, the message queues
  locally and rides the next write's push after recovery; the reconnect
  compensating pull catches events missed while disconnected.
- Epoch roll test: fill past threshold, roll, verify both replicas converge
  on the truncated log and expired messages disappear everywhere. (Roll is
  unit-tested and the hub truncate endpoint has its own test; an end-to-end
  roll through the hub is still open.)
- Offline test: send with hub unreachable, come back, verify delivery.

## Open questions

- Message size cap (D1 row / DO value limits apply; ~128 KB is the known
  bound from hub-v0).
- Do broadcasts need a TTL distinct from messages? (Probably same 7 days.)
- Epoch roll contention: two machines rolling concurrently — likely fine
  (both docs converge; the higher epoch wins; loser's roll is absorbed).
  Needs a test, not a lock.
- Encryption at rest / per-recipient visibility? Out of scope for v1; the
  hub already sees context atoms in the clear.

## Gap found live (2026-10-22, pa-gpui session)

A user goodnight sent via msg_send from a gzero-repo session never
reached the pa-gpui-repo session: msg scope is per-repo, so cross-repo
conversation silently doesn't deliver (msg_read: "no unread"). Cross-
repo and cross-machine delivery are the open case this file's hub work
targets — treat tonight as the motivating bug report.

Related observations from the same session:

- Mid-session pickup is resolve-driven (pull, not poll). That is the
  right overload posture — no token cost until asked — but it depends
  on the agent calling resolve. Consider surfacing unread counts at
  natural pause points (idle, task end) rather than any polling loop.
- Medium discipline: msgs = conversation (ephemeral), broadcast board =
  state of the world ("information not demand"), atoms = durable memory.
  A first-time user broadcast a durable memory atom when the board was
  the right medium — worth a usage note in the tool descriptions.
- Discovery failure: the comms tool surface (msg_send/msg_read/
  broadcast) was invisible to a session that never searched for it.
  Consider mentioning comms in the injected context so sessions know
  the conversation layer exists.

## Cross-repo solution sketch (2026-10-22, from the pa-gpui session)

Constraint set: no polling (pull at resolve only), attribution must be
mechanical, deference/storm rules, ephemeral conversation, existing hub
(CF Worker + D1 change log) and comms.ws with SyncCursor.

**Proposal: agent-addressed inboxes at the hub.**

- **Address by agent, not by repo.** Sessions register presence
  globally (presence-heartbeat groundwork). `msg_send` gains targets:
  agent id | team | broadcast-board. Repo scope remains the default for
  in-repo chatter; crossing repos is a target choice, not an accident.
- **Delivery = the mailbox bag.** The hub holds per-agent inboxes (D1
  rows; the 7-day TTL and ~128KB caps already designed apply). Client
  pulls inbox at the sync moments that already exist (session start,
  best-effort after write) — zero new polling. Unread count rides the
  existing resolve surface; msg_read drains as today.
- **Attribution solved at the source:** the hub stamps author/machine/
  time on ingest (API key = machine identity). Messages get mechanical
  attribution even though atoms don't yet — the conversation layer can
  lead the memory layer out of the pantheon curse.
- **Overload posture:** delivery is silent (unread badge only, no
  injection into context until read); broadcast board stays read-once
  per session; deference etiquette (holdback on no-reply/stress) is a
  client-side habit until it can be a server-side rate.
- **Interim workaround (proven tonight):** scope-addressed durable
  atoms — add({scope: other-repo}) lands in the other repo's injection
  set. Works, but it's durable where conversation should be ephemeral;
  use only for hand-carried letters.

Sequencing: (1) hub inbox rows + pull-at-sync, (2) presence-addressed
targets, (3) hub-stamped attribution, (4) deference as server rate.

## Posture revision (2026-10-22, same night): compact vs resident

The inbox sketch above is the compact posture: no standing cost, but
delivery is batchy — messages wait for sync moments. With cheap
hardware (the user's point: RunPod), the target posture is a
**resident**: an always-on process holding the live connection to the
hub (the DO websocket path already deferred as "later"), receiving
pushes the moment they are sent.

- The resident buffers, filters, and knocks properly: deference rules
  enforced server-side, unread surfaced at natural pauses, wake only
  when something is actually waiting. The agent's context stays clean;
  the resident stands in the rain.
- This is the contexture resident daemon with a mail slot — same
  animal, existing concept, now affordable to run 24/7.
- Dual track: compact inbox = v0 bootstrap (zero-indexed; buildable from existing
  parts tonight); resident push = target posture (hardware-cheap).
  Compact remains the fallback and spillover path when no resident
  is running (laptops, offline).
