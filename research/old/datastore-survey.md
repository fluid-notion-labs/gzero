# The datastore — shapes, prior art, route

*What a distributed datastore for this system will need to hold, what exists
out there for each shape, and which route to build. Follows `data-shape.md`
(current register) and `distribution.md` (mechanism). Companion survey:
`distributed-state.md` (compute engines). Related: `deltadb.md` (Zed's
adjacent substrate), `history.md` + `lockstep.md` (time over the store).*

## The key unlock first: mutable fields are covered after all

A last-writer-wins **register** is a semilattice when the "clock" is a
max-mergeable stamp:

```
Register<T> = Max<(counter, replica_id)> → T
```

Merge = take the elementwise max of the stamp pair. Monotone, commutative,
associative, idempotent — no wall clock, no coordinator, no ordering
protocol. The "no clocks" rule was about *wall clocks and coordinators*, not
about max-stamps. This reclassifies most of `data-shape.md`'s "hard" list:
status flips, parent moves, priority bumps all ride the lattice as
`MapUnion<key, Max<stamp → value>>`.

Costs, honestly: writes need `(replica, counter)` bookkeeping per register,
and concurrent writes lose the loser silently (no conflict surface unless we
keep losers in an inspectable pile — the lattice keeps facts, so losers can
be retained and surfaced; decide policy per collection).

## The shapes needed (requested + additions)

| shape | example | lattice coverage | prior art |
|---|---|---|---|
| multiple kv | collections of dotted-key records | immutable values = facts (easy); mutable = registers | Riak/DVV, AntidoteDB, Ditto |
| tree store | hierarchical todo list | node = fact with stable logical id; `parent` + `position` = registers | Loro movable-tree, Kleppmann "Composing CRDTs", automerge/yrs nesting |
| architecture doc | prose, evolving | **don't put prose in the lattice** — pointer fact `{path, content_hash, commit}` + git holds the text | beads, git-is-the-CRDT-for-text |
| workflow spec / user stories | `{id, story, status}` | fact + status register | beads, issue trackers |
| references / edges | "spec X relates to component Y" | pure facts (both ends content-addressed) — easy, high value | graph CRDTs; memoryvault's typed edges (vendor/) |
| blobs / attachments | images, PDFs, exports | `{cid, metadata}` fact; bytes out-of-band (R2/hub) | IPLD, Ditto attachments, restic chunking |
| logical keys / version chains | stable slug per entity, edits chain | carried in payload — must decide **now**, retrofittable badly | Noms (nominal vs structural id lesson) |
| replica registry | machines, stamps baseline | facts themselves | any vv-based system |
| schema facts | collection registry, payload versions | facts; merge-everything, read-what-you-know | IPLD schemas, Noms type lattice |

**Referencing git/jj via content addressing: mostly irrelevant, as
suspected.** Content addressing is identity, not sync. It earns its keep in
two places only: blob facts (`cid` so a re-push is a no-op) and pointer facts
(`content_hash` so a machine can tell whether it has seen a document
version). Don't build the store on CID DAGs; Noms tried, died, and left the
lesson: structural versioning of data is heavier than the problem.

## Trees, concretely (the hard shape deserves the detail)

- Node: immutable payload fact keyed by **stable logical id** (uuid/slug —
  content addressing can't work here; a todo's identity isn't its text).
- `parent` and `position` per node: registers (max-stamp). A move = one
  register write.
- Concurrent moves: both survive; register picks the winner; the loser stays
  inspectable in the fact pile.
- **Cycles** (A moves X under Y while B moves Y under X): possible in the
  facts; resolved in the *derived view* (cycle guard drops illegal edges,
  deterministically). Merge stays a lattice; correctness of the rendered
  tree is a read-side choice. This is the "facts replicate, derived state
  doesn't" rule doing real work.
- At todo scale this is comfortably simple. If we ever need realtime
  collaborative trees, that's Loro's movable-tree container, wholesale.

## What is out there (verified current)

- **Loro** (Rust, 1.16, active): typed container battery — map, list, text,
  **movable tree**, counters — with version vectors, snapshot import/export,
  shallow snapshots for partial sync. The most complete embeddable state
  layer; adopting it = adopting its container semantics wholesale.
- **automerge** (0.12, Rust core): JSON-doc model, nested maps/lists/text;
  no first-class tree; storage + sync protocol designed.
- **yrs / yjs** (0.28, active): text-first, nested maps/lists; the realtime
  collab default; tree = nesting, no moves.
- **diamond-types** (2022, stalled): fastest text CRDT; sequence only.
- **cr-sqlite**: semi-dormant (previous survey's finding stands).
- **Dolt**: "git for SQL" — prolly trees, branches/merges over tables. The
  strongest precedent for *versioned structured data with human merge*, but
  heavyweight and server-shaped; pattern, not dependency.
- **Noms**: typed content-addressed DB with sync — dead project, prophetic
  design; the cautionary half of the content-addressing question.
- **Replicache/Zero, ElectricSQL, PowerSync, Evolu**: sync engines —
  client state + server authority, LWW per field, no peer merge. The
  opposite bet; the kv-annex/hub-authoritative data we already delegate is
  this pattern done small.
- **Ditto**: commercial edge CRDT platform — registers, maps, attachments
  with out-of-band blob sync. Closest product match to the full shape list;
  closed, so: prior art only.
- **AntidoteDB**: academic CRDT store with causal consistency + txns. The
  reference for "multiple kv with CRDT objects"; too heavy to adopt.

## The two routes

**Route A — one lattice state, typed collections, ours** (the elastic
line, formerly bagflow).
Facts for immutable data, max-stamp registers for mutable fields, pointers
for prose, git for text transport, R2 for blobs. Everything above fits; the
only genuinely new machinery is the stamp bookkeeping.

**Route B — embed Loro as the state layer.** All container types free,
battle-tested merges, vv sync built in. Cost: their semantics instead of
ours, a bigger dependency, and the hub/git transports must speak their
snapshot format. The atoms/skillset we already shipped don't need it; trees
and collaborative prose would.

**Recommendation: Route A, with Route B's *semantics* stolen** (their
tree/register designs inform ours). Swap wholesale to Loro only if/when we
want realtime collaborative editing of structured data — a different
product than a personal distributed architecture store.

## Decisions to make now, in order

1. Logical ids: adopt stable slugs/uuids in payloads for every mutable-ish
   entity (todos, specs, trees). Retrofitting identity is the one
   irreversible mistake available here.
2. Stamp format: `(u32 counter, u16 replica_id)`? Decide once, it's
   wire-format.
3. Which collections are facts-only vs register-bearing (per-collection
   policy row, as in `data-shape.md`).
4. Blob transport: R2 on the hub, `{cid, metadata}` facts — defer the bytes.
5. Keep prose in git; lattice gets pointers only. Revisit only if two
   machines must *concurrently* edit the same prose.
