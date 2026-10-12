# Distribution — the exact mechanism

*How facts move and converge, end to end, with nothing left "TBD". Companions:
`lattice.md` (the merge math), `sync.md` (current transport, bag-shaped),
`data-shape.md` (what data rides this, what doesn't),
`distributed-state.md` (why this over timely/differential/cr-sqlite).
Direction note: multiple data types replicate; differential-style views stay
local (dfir_rs computes them).*

## The rule that scopes everything

**Facts replicate. Everything else doesn't.**

- A **fact** is an authored, content-addressed record. Immutable: an edit is
  tombstone + new fact, never a mutation. This is what makes merge a theorem.
- **Derived state** (resolved views, indexes, projections) is computed
  per-machine by the dataflow, never synced — recomputable from facts.
- **Hub-authoritative state** (tokens, settings, counters — anything
  genuinely mutated in place) lives in D1, written through the hub, no
  CRDT ceremony — the hub decides. Note the kv annex is NOT here: kv
  documents are facts (see the collection table).

If a datum can't be phrased as an immutable fact, it can still ride as a
**max-stamp register** (`Max<(counter, replica_id)> → value` merges by max
— a semilattice in its own right; see `datastore-survey.md`). Anything
neither facts nor registers — settings, authority — goes in the D1 annex.

## The replicated object

One global lattice value, a map of collections:

```
State = Map<collection → SetUnionWithTombstones<Set<Fact>, Set<Id>>>
```

- **Fact** = `{ collection, id, payload }`. **Id is derived deterministically
  from the payload** (content addressing), so two machines asserting the same
  fact produce the same id — union "just works".
- Per-collection policy is a small static table:

| collection | identity | payload | merge |
|---|---|---|---|
| skillset (atoms, today) | text | `{text, scope, node, tags}` | OR-set; same id unions tag sets |
| kv-facts (later) | logical key (slug); document versions content-addressed | `{key, value}` | immutable values = OR-set facts (edit = tombstone + new fact); mutable fields = max-stamp LWW registers (`datastore-survey.md`) — no MV read hack needed |

Adding a data type = adding a table row + a payload struct + registering the
collection in the snapshot codec. No change to the merge, transport, or hub.

- **Tombstones are by id**, carried per collection, and dominate concurrent
  adds (OR-set). Removal is itself a fact.

## The merge unit: per-machine snapshot

Each machine owns a **snapshot document**: its full local state, versioned
JSON — every collection, alive facts, tombstones. The snapshot is three
things at once:

1. the machine's durable persistence (atomic write on every update),
2. the sync payload (the only thing that ever crosses a wire or repo),
3. the format for bootstrapping a new machine.

Because merge is idempotent, commutative, associative: re-merging a snapshot
is a no-op, snapshots can arrive in any order, and snapshot-of-snapshots
(relay/gossip) is safe. Every transport decision below is trivial *because*
of this; none of them need acks, sequence numbers, or clocks for
correctness — only for freshness.

## Write path (exact)

1. **Local write.** `put(collection, payload)` → compute id → local lattice
   update (union into set, drop from tombstones absent a tombstone) →
   persist snapshot (tmp+rename). Durable before any network activity.
2. **Publish.** POST own snapshot (or the event) to the hub, fire-and-forget
   with retry/backoff. At-least-once, duplicate-tolerant — the hub's merge
   is idempotent, so a retry can never corrupt anything. Push failure is a
   freshness problem, never a correctness one.
3. **Pull.** On session start, on demand (MCP `resolve`), and periodically:
   GET merged snapshot from the hub → merge into local lattice → persist if
   changed. Pull failure changes nothing locally.
4. **Convergence.** Any machine that has seen the same set of snapshots holds
   the identical state. Order of arrival is irrelevant; that is the whole
   guarantee.

## Hub: a replica, not an authority

The hub (contexture Worker + DO) **is itself a replica** with a big merge
inbox: it accepts snapshots/events, merges into its own lattice, persists
(atomic write or DO storage, debounced alarm), and serves its merged value
as "the current snapshot".

- Clients never trust the hub for correctness: it may be stale, it may have
  missed a push, it may serve an older snapshot after a rollback. The client
  merge handles all of that for free — the hub only optimizes freshness.
- The hub stores per-machine snapshots too (audit/recovery), but the merged
  value it serves is derived, exactly like any local view.
- Auth: per-machine token; push and pull gated on it.
- Later: live push (DO websockets) so pulls aren't per-session; the merge
  code is untouched by this.

**Offline path, identical math:** `cx export` writes the snapshot to
`sync/<machine>.json` in a shared git repo; other machines `cx absorb`
every file they see. Merge code is the same as the hub path; git is just a
slower mailbox. Hub and git paths can run simultaneously.

## Deletion, honestly

Tombstones win over concurrent re-adds by construction. The cost: tombstones
are grow-only. **At context scale (hundreds of facts): keep them forever.**
The safe GC — drop a tombstone once every replica has observed it — requires
a replica registry plus version vectors in the snapshot (merge = per-replica
max; that extension is compatible with everything above). Flagged, deferred
until fact counts make it matter.

## Bootstrap and failure cases

- **New machine:** GET merged snapshot (or `cx absorb` the git dir) →
  persist → done. One pull is a complete bootstrap.
- **Machine offline for weeks:** stale, not wrong; one pull on return.
- **Hub down:** writes still land locally; sync waits. Git path unaffected.
- **Concurrent add of same fact:** same id, union, one fact.
- **Concurrent add + remove:** tombstone dominates; re-put stays hidden.
- **Same id, different payloads:** a content-addressing bug by definition —
  ids must be derived from payloads; if it happens, tags union (skillset
  policy) and the collision is logged, not resolved silently.

## What does not replicate

- Derived views (resolved skillset, indexes) — local, dfir_rs-maintained.
- Per-machine authoring ledgers (markdown sources, provenance, source rows).
- Hub-authoritative annex data (kv that the hub owns, tokens, settings).
- Tombstone GC decisions, machine registry — hub-local bookkeeping.

## Convergent threads (2026-10)

A parallel session surveyed the same problem from the code-store side
and landed on the identical layering — two independent derivations,
one answer, which is the strongest validation either has:

- `../resident-mcp/replication.md` — snapshot/Merkle vs consensus vs
  CRDT for a versioning-tree backend: *snapshots at rest, ops at the
  edges, consensus nowhere, CRDT only where concurrent writers are
  real.* It names our bag join (`lattice.md`) as the existing CvRDT in
  the stack. Every clause matches this document's bets: content
  identity converges, no coordinator for merge, commutative merge only
  where writers are actually concurrent.
- `../resident-mcp/architecture.md` — the daemon-as-single-writer claim
  ("the daemon is the leader because it's the only writer") is
  `lockstep.md`'s claim for sessions; one is the code store's tip, the
  other the fact store's log, and both get total order for free, no
  consensus.
- `../tree-models/index.md` — CAS + naming tree + mutable-root-pointer:
  the same substrate shape as this store (content-addressed immutable
  facts + registers + mutable pointers). Strategy implication: one
  CAS/DAG core, two schemas on top — not two stores. The bag is
  already specced as the cross-cutting annotations layer there.

Also closed: `../pijul-jj-backend/index.md` — Pijul as a jj backend is
not feasible (models misalign at the `Backend` trait), so tier 3 of the
conflict funnel keeps jj's first-class conflicts as the oracle.

## The one future fork

If snapshots grow past comfortable (per-sync O(total state)): switch the
transport payload from full snapshots to event logs with lattice
checkpoints, using a version vector per machine to decide what a peer
hasn't seen. Merge stays the same; only the *encoding* of "what I know"
changes. Do this when fact counts demand it, not before.
