# Track S v1 — cross-machine messaging on its own automerge bag

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
  automerge change log of the ws doc, per **bag** (bag `context` in use).
  Change log in D1, merge engine client-side (automerge), per-bag endpoints
  already parameterized (`HubChanges::from_env(bag)`).
- No Track S plan exists in hub-v0 or plan3 — this document is it.
- Tested in-session: local delivery works (message between two sessions on
  one machine, seen unread in the store, delivered on next `resolve`).

## Decision: a second automerge bag, `comms`

Cross-machine messaging keeps the same architecture as the context store —
its **own** automerge doc, synced through the hub's existing change-log
endpoints under bag name `comms`.

Why not hub-native ephemeral rows (plain D1 + server TTL): messages would
need the machine online at send time, a second transport to build and
maintain, and the mobile client would need a second protocol. The automerge
path reuses `HubChanges`, cursors, the convergence tests, and gives
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
  truncate the bag's change log below the new epoch's base seq.
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

- Existing per-bag change endpoints: expected to work as-is for bag
  `comms` (verify; auth is the same `CX_TOKEN`).
- New endpoint: truncate/epoch — `POST /bags/{bag}/truncate {before_seq}`
  (or epoch-marker form). Deletes D1 change rows with `seq < before_seq`.
  Auth: same token. Safety: idempotent; truncating below a replica's pull
  cursor is that replica's problem to re-sync (documented behavior).
- Live push (DO websockets) stays a separate, later item — needed for
  real-time delivery under any storage choice. v1 delivery: push immediately
  after send (already the pattern), pull at `resolve` and on session start.

## Implementation (built)

- `comms.rs`: `CommsStore` — an `AutomergeStore` at its own path
  (`~/.pi/agent/comms.ws`, `CX_COMMS_DB` override) + `SyncCursor` sidecar,
  bag `comms` (`CX_COMMS_BAG` override for isolated test runs). The
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
- Epoch roll test: fill past threshold, roll, verify both replicas converge
  on the truncated log and expired messages disappear everywhere.
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
