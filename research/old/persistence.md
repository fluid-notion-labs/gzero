# Persistence for the context bag

*Follow-up to `distributed.md`/`plan.md`: elastic's lattice lives in RAM.
This note picks the persistence design. Prototype: `elastic/src/persistence.rs` (formerly bagflow).*

## Requirements

- Bag is small (hundreds of atoms) — the whole state is one lattice value.
- Crash-safety: a killed process must not corrupt anything.
- The persisted artifact should double as the M4 merge/export unit.
- Inspectable by humans (the homoiconic spirit: one format, many readers).

## Options

| Approach | What it is | Verdict |
|---|---|---|
| **JSON snapshot** | whole lattice serialized as a versioned document | **Pick.** Trivial, inspectable, exactly the merge artifact |
| Bincode/postcard snapshot | same, binary | Faster/smaller; pointless at this size, loses inspectability |
| WAL of deltas | append log of Put/Remove, replay on load, periodic compaction | The "smarter" option — but replay + compaction complexity buys nothing until data grows or writes get slow (remote backends) |
| LSM of batches (mz-persist style) | what Materialize built for TB-scale | Way overkill |
| SQLite rows | what `cx` already does | Duplicates the store; loses the single-mergeable-value property |

## Decision

- **Format**: versioned JSON document — `{"version":1,"atoms":[…],"tombstones":[…]}`.
  The tombstones are included: the snapshot *is* the CRDT state, so copying
  it to another machine and merging is the whole M4 protocol.
- **Write policy**: persist on every applied update (worker thread, atomic
  tmp-file + rename), not a timer. At this data size the write is sub-
  millisecond and the loss window is zero. "Smarter" (debounce/WAL) becomes
  right when the backend is slow or remote — Cloudflare Durable Objects
  keep memory resident, so there a periodic/on-eviction flush suffices.
- **Load**: snapshot becomes the initial accumulator of the `lattice_fold`;
  no replay step.
- **Backend trait**: `SnapshotStore` (`load`/`save` bytes) — `JsonFile` now;
  Durable Object / KV / D1 blob later behind the same trait.

## Multi-machine (requirement, not someday)

The operator works across machines and the bag will be embedded in the
in-process harness (see `research/internal-harness/`: spine+fork, MCP
fabric, gpui UI). Architecture that follows:

- **Merge unit = the snapshot document.** Lattice merge is
  commutative/associative/idempotent, so ANY transport works: git-committed
  artifact (offline-first, the beads pattern), HTTP push/pull to a hub, or
  Durable Object storage. No coordination, no ordering, no clocks.
- **Embedding:** harness-rs holds the bag in-process (resident RAM,
  snapshot file on disk) and serves it over the harness MCP surface:
  tools `bag_resolve`/`bag_put`/`bag_activate`, resources for default and
  tagged slices. `cx` stays the CLI face on machines without the app.
- **Hub option (later):** a Durable Object holding the lattice; machines
  POST snapshots, DO merges, GET returns merged state. Only needed when
  git-artifact sync feels too manual.

## Dovetail with internal-harness

- The bag is a candidate for the harness's "relevance lookup" MCP role:
  forks pull context slices (`bag_resolve #tag`) instead of the spine
  shipping whole briefs.
- Deletion semantics must be settled before multi-machine: OR-set
  tombstones (elastic) vs source-resync (cx). For sync, tombstones win —
  they survive transport without source identity. cx's per-source rows
  remain the authoring-side ledger; a tombstone is the *published* fact.

## Upgrade path (when to revisit)

Data outgrows "one document" (thousands of atoms, many sources) → add a
delta log with snapshot compaction. Backend becomes remote/latency-bound →
debounce writes, or move to DO storage where the runtime owns durability.
