# Data shape — what we have, what the semilattice covers

*Living document. Register of every datum in the context system: its shape,
whether the join-semilattice merge covers it, what is easy, what is hard.
Updated as the data model evolves. Companions: `distribution.md` (the
mechanism), `lattice.md` (the math), `distributed-state.md` (survey).*

## The test a datum must pass

A datum rides the lattice if all three hold:

1. **Representable as sets/maps** with a monotone merge (union, max,
   elementwise sum) — the merge only ever moves state "up".
2. **Identity derivable from content** — two machines asserting the same
   datum produce the same key, so union "just works". Mutable entities
   (todos, specs) instead carry a **stable logical id** (slug/uuid).
3. **Immutable as a fact, or mutable as a register** — an edit is tombstone
   + new fact; a genuinely mutable field rides as a **max-stamp register**
   (`Max<(counter, replica_id)> → value`), which is itself a semilattice.
   No wall clocks, no coordinators.

Fail all three, and the escapes are: **delegate** (hub-authoritative in
D1, no CRDT) or **don't replicate** (derived or per-machine state).
See `datastore-survey.md` for the register unlock and prior art.

## Register

| datum | shape | lattice? | verdict | status |
|---|---|---|---|---|
| instruction atoms (skillset) | `Set<Atom>`; identity = text | **yes** — OR-set | easy | shipped |
| atom tags | `Set<String>` per atom | **yes** — grow-only union | easy | shipped |
| atom scope/node | strings carried on the atom | quasi — carried, not merged semantically | easy now, hard if nodes ever "move" | shipped |
| tombstones | `Set<Id>` | **yes** — dominate adds | easy; GC is the hard part | shipped |
| atom counts | counter | no — a shared counter needs per-replica sums (G-counter), never a global value | mostly dropped; re-add only per-replica | dropped |
| markdown authoring files | prose, git-tracked | **no** — git is the CRDT for text | per-machine source of truth; bag derived from it via harvest + mark-and-sweep | shipped |
| kv annex values | `key → value`, dotted keys | **yes** — immutable document versions are OR-set facts (edit = tombstone + new fact); mutable fields are max-stamp LWW registers (`datastore-survey.md`); hot hub-authoritative state stays D1 | decided — documents ride the lattice; wire via elastic (plan2 L2) | decided, not yet wired |
| settings, tokens, per-machine config | mutable blobs | **no** | delegate (hub-authoritative) or keep local | planned (D1) |
| resolved views, indexes | derived | **no, by design** | never sync; recompute from facts | shipped |
| sessions, transient context | ephemeral | no | don't replicate | — |
| tree items (todo outlines) | node fact + parent/position registers | **yes** — registers for moves | cycle guard lives in the derived view | candidate |
| workflow specs / user stories | fact + status register | **yes** | statuses are max-stamp registers | candidate |
| reference edges | `(from, to, type)` facts | **yes** — pure facts | easy; high value | candidate |
| blobs | `{cid, metadata}` fact | **yes** — pointer only | bytes travel out-of-band (R2) | candidate |
| logical keys | slug/uuid in payload | carried metadata | needed for any mutable entity; retrofit is painful | decision pending |
| replica registry | machines, stamps | **yes** — facts | small; needed for GC later | candidate |

## What is easy

- **Grow-only sets.** Atoms, tags, tombstones: the whole shipped system is
  three unions. Content addressing (text = identity) is what makes adds
  conflict-free.
- **Deletes.** Tombstone-as-fact; dominates concurrent re-adds.
- **Edits — as long as they are re-materialised.** "Edit an atom" = new text
  = new identity = new fact + tombstone. No field-level merging needed.
- **Merging heterogeneous sources.** Same text from two machines: tags union,
  scope/node from first source — a deliberate, simple tiebreak.

## What is hard

- **Mutable fields — now mostly covered** (revised): a max-stamp register
  `Max<(counter, replica_id)> → value` is itself monotone-mergeable; the
  earlier "no clocks" objection targeted wall clocks and coordinators, not
  logical stamps. Remaining cost: per-register stamp bookkeeping, and
  concurrent writers lose silently unless losers are kept inspectable.
- **Counters.** A global "how many times" is still not covered (a shared
  counter needs per-replica sums — G-counters — which answer a different
  question).
- **Order and priority.** Total orders (rankings, sequences, "top N") are
  not monotone; they need the coordinator path (see the McSherry note in
  `distributed-state.md`) or must stay per-machine.
- **Garbage collection.** Tombstones are forever until version vectors are
  added (compatible, deferred — `distribution.md`).
- **Large or binary payloads.** Mergeable, but every sync moves full
  snapshots; heavy payloads make the O(total state) transport cost bite.
- **Read-your-writes across machines.** Not purchasable without the log +
  total order route; accepted loss.

## Open questions (data model in flux)

- Which future data types are actually wanted — and for each: fact or annex?
- ~~Does the kv annex need mutable values?~~ Answered: immutable
  document versions are facts (edit = tombstone + new fact); mutable
  fields are max-stamp registers (`datastore-survey.md`); only
  genuinely in-place hot state (tokens, settings, counters) is D1
  territory. The local-first `kv` table in `contextual` maps onto the
  kv record type; hub sync is the remaining work (plan2 L2).
- Does anything need "uniqueness across collections" or cross-fact
  references? References are fine (they're just identity strings); enforced
  uniqueness is not lattice-covered.
- Naming: the store currently called the "bag" — renaming is pending and
  touches every doc here.
