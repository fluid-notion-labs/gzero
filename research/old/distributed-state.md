# Distributed state for the context bag — survey (Rust)

*Follow-up to `plan.md`'s "re-import discipline" problem: the bag is one
replica of facts whose authoring surface is markdown. Multiple replicas
(laptop, D1, other agents' machines) makes this a distributed-consistency
problem. Repos cloned under `vendor/`, inspected 2026-10-10.*

## TL;DR

- Our data model is already CRDT-shaped: atoms are a **set keyed by content**
  (text PK), tags are grow-only sets, count is a counter. What's missing for
  multi-replica is small: per-replica counters, tombstones for deletes,
  version vectors. A custom OR-set-ish merge is ~a few hundred lines — no
  framework needed.
- **cr-sqlite** does exactly "replicate SQLite tables as CRDTs" and is the
  only drop-in option; costs a C extension and a semi-dormant project.
- **Salsa** and **differential/timely** are the wrong dependencies but the
  right *ideas*: provenance + durability (salsa), bag-as-multiset-of-diffs
  (differential). Steal the concepts, not the crates.
- **Precedent worth copying**: beads solved the same problem with *state
  export to a git-tracked artifact* (SQLite ↔ JSONL). Git is the original
  distributed-state sync for text.

## The surveyed systems

| System | What it is | Core abstraction | Fit for us |
|---|---|---|---|
| **timely-data** | Data-parallel compute engine (Naiad); scales one program from thread to cluster | Cyclic dataflow + logical timestamps/epochs | No — we have no dataflow to schedule |
| **differential-data** | Incremental dataflow over timely | Collections as multisets of `(data, time, diff)`; operators propagate *changes*, not data | Conceptually: our bag *is* a differential collection (text, count). Computationally: massive overkill |
| **salsa** | Incremental recomputation (rust-analyzer's engine) | Queries over inputs; derived values cached with **provenance** and **durability** levels | Right model for markdown→bag as derived state; in-memory, single-process — not a fit as dependency |
| **hydroflow** | Hydro: distributed dataflow programming (successor research line to timely) | Dataflow with location/consistency-coordinate scheduling; plus the **`lattices`** crate of CRDT primitives | Engine: no. `lattices` crate: **yes** — `SetUnionWithTombstones` is exactly the OR-set merge proposed below |
| **noria** | Dataflow database for web backends (pdos) | Materialized views maintained incrementally as base writes flow through | Pattern only: "resolved context" = a materialized view; ours is a cheap SELECT |
| **dbsp/feldera** | Industrial incremental view maintenance engine |circuits Z-sets (multisets with weights) + differential circuits | Same as differential, productized. No |
| **automerge/yrs/loro** | CRDTs for collaborative documents | Op logs + sequence CRDTs (RGA/YATA), version vectors, merge to convergence | Heavy machinery for *sequences*. Our atoms are keyed by content — no position merging needed |
| **cr-sqlite** | SQLite extension making tables CRDTs ("crr") | Per-table/column version vectors; `changes` virtual table for sync; column-level last-write-wins | **Direct fit** for multi-machine bag sync. C extension, rusqlite can load it |

## What our problem actually is

Two consistency problems, different tools:

1. **Intra-machine: markdown ↔ bag.** Single writer, single machine. This is
   not distributed state — it's *derived state with provenance* (salsa's
   model: track which input produced which atom, recompute the diff, sweep
   orphans). Plain mark-and-sweep sync is correct here; anything heavier is
   ceremony.
2. **Inter-machine: bag ↔ bag (later, M4).** True distributed state. But our
   merge semantics fall out of the data model:
   - identity: text (content-addressed) → no positional conflicts
   - tags: union (grow-only) → trivially commutative
   - count: make it a *per-replica* counter; merge = elementwise sum
     (G-counter) — or drop counts from merge semantics entirely
   - deletes: tombstones (OR-set semantics); "removed from authoring file"
     = tombstone set at source, garbage-collected by age/compaction
   - scope/node/edits: last-writer-wins per field with (replica, clock)
     tiebreak — acceptable because atom edits are rare and text identity
     means an "edit" is really delete+insert of a new atom
   That's an OR-set + LWW map. No sequence CRDT, no op log, no framework.

## Decisions

0. **Wrapper built (since retrieved):** `bagflow` (`nursery/bagflow`,
   symlinked here, rename to `elastic` pending)
   implemented the
   bag as a DFIR dataflow — `SetUnionWithTombstones` accumulated with
   `lattice_fold::<'static>`, synchronous API (`put`/`remove`/`snapshot`/
   `resolve`), worker thread with explicit shutdown signal. Finding: DFIR
   graphs don't terminate on input close (persistent 'static fold), so
   `run()` abandonment via `tokio::select!` is required for clean Drop.
   Deletion semantics: OR-set — a tombstoned atom stays hidden on re-put.
   **Status (2026-10): lost from disk, recovered from GitHub**
   (`fluid-notion-labs/bagflow`); being renamed **elastic** and extended
   to all record types (plan2 L0–L2). Only the `lattices` crate is
   required for the merge; the DFIR wrapper is optional (incremental
   views only).
1. M2 stays as planned: provenance column + `cx sync` mark-and-sweep.
2. M4 multi-machine: build the bag's merge on hydroflow's **`lattices`**
   crate (`SetUnionWithTombstones` for atoms, `MapUnion` for tags) behind our
   `Storage` trait boundary — the OR-set + LWW design hand-rolled in ~a few
   hundred lines is already a tested crate. Evaluate cr-sqlite only if we
   want off-the-shelf tooling and accept the C extension.
   Automerge/yrs/loro are the wrong shape (documents, not sets).
3. If resolution ever becomes expensive over many collections, revisit
   differential/DBSP for incremental views — flagged, not acted on.
4. The beads precedent (SQLite ↔ git-tracked JSONL) remains the fallback
   sync transport: state export + git merge, human-resolvable, zero new
   infrastructure.

## Adjacent: the determinism route (McSherry), deliberately not taken

The other way to keep replicas identical: not commutative merge, but
**determinism over an ordered log**. McSherry's line over timely:
Materialize keeps replicas (hot standbys) identical by feeding every
replica the same totally-ordered durable source (persist / Kafka);
deterministic differential compute then yields bit-identical state, and
the frontier protocol gives consistent timestamped reads.

| | determinism route | lattice route (ours) |
|---|---|---|
| convergence by | ordered log + deterministic recompute | commutative merge |
| writers | serialized through the log | N concurrent, offline-capable |
| offline divergence | must not exist | merged on return |
| guarantee | strong reads, read-your-writes | eventual, by theorem |

We take the lattice bet for facts (machines write locally, go offline)
and the determinism bet one level up: derived views are pure folds over
facts. Where a genuine single-writer total order exists — session
timelines, jj-captured work (`history.md`, `lockstep.md`) — the log
route is the right one. Both routes appear in this folder by design.

## Key files

- `vendor/hydroflow/lattices/src/set_union_with_tombstones.rs`, `lattices/src/ght/` — the merge primitives; crate `lattices` on crates.io (0.8-alpha). **Note: no longer vendored** — depend on the crates.io `lattices` crate.
- `vendor/cr-sqlite/core/src/changes-vtab.c` — sync interface; `docs/` for CRR semantics
- `vendor/salsa/src/durability.rs`, `function/` — provenance/durability model
- `vendor/differential-dataflow/differential-dataflow/src/trace.rs` — multiset-with-diffs core
- `vendor/noria/server/src/controller/`, `vendor/dbsp/crates/dbsp/src/circuit.rs` — view-maintenance pattern references
