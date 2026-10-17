# Contextual — productization plan

## Status

Superseded by `plan3.md` (2026-10) — kept as reference for the engine
rationale, record-type schema, and the workflow-content rule. Original
greeting: productization thread: contextual grows
from "bag + CLI" into a fully specified product — doc set, user
stories, work-item/todo facet, native history — with automerge-rs as
the engine core behind contextual's `Storage` trait (**elastic** is the
deferred name for the typed layer once it's a crate). Sits beside
`plan.md` (memory-layer
buildout); plan.md's open M4 (contextual↔engine unification) is
absorbed here as milestone **L1**. Companions: `architecture.md`
(the contexture umbrella: planes, moving parts),
`lattice.md` (merge math), `findings.md` (concept grounding);
vendored comparisons: `vendor/beads` (Go), `vendor/beads-rs`
(delightful-ai), `vendor/beads_rust` (br).

## Goal

Everything a project needs to remember, in one substrate:

- **instructions** (atoms — live)
- **work items** (plan/todo/epics — the beads facet, new, hierarchical, nested)
- **decisions** (spec'd in `decision-memory-mcp` research)
- **annotations** (spec'd in resident-mcp research)
- **history** — changes over time, native, not reconstructed

Overarching ideas (seeds for `product.md`): identity by content; merge
by algebra; replicate via hub; agents *query* structured records,
humans *read* curated prose; state is a fold of an append-only log —
history is the data, not an afterthought.

## Engine packaging: automerge behind `Storage`; elastic deferred

`nursery/bagflow` (own repo, retrieved) stays an unrenamed reference
prototype — contextual has no code dependency on it, and nothing needs
a second crate yet:

- **Now:** the engine is **automerge-rs** behind contextual's `Storage`
  trait, inside contextual (`AutomergeStore`; see §Engine substrate).
  Record types, folds, policy, and the derived index start as modules
  there too — Rust makes later crate extraction cheap; premature
  extraction is just workspace friction.
- **elastic** is the name for the typed layer *if/when* it's extracted
  into its own crate — deferred until a second consumer appears (a
  non-contextual tool working on the same record types). "elastic": the
  lattice stretches to absorb concurrent replicas and always snaps back
  to one state.
- No rename todo remains: no `nursery/elastic`, no symlink, no
  component-table churn. `lattice.md` keeps pointing at bagflow as the
  DFIR reference prototype.

## The doc set

| doc | contents | status |
|---|---|---|
| `product.md` | what contextual/contexture does, for whom, overarching ideas, non-goals | to write — markdown now; migrates into the bag (this rule) |
| `architecture.md` | contexture umbrella (planes, moving parts) — promoted from `architecture2.md`, which is retired | exists — migrates into the bag (this rule) |
| `research/old/memory-plane.md` | bag components, resolution model, diagrams | exists (archived) — migrates (this rule) |
| `stories.md` | user stories / workflows — human and agent personas | to write — markdown now; migrates into the bag (this rule) |
| `plan2.md` | this | — |
| record-type specs | work-item schema, merge semantics, lifecycle | to write (can live in `stories.md` appendix or own doc) |

## Workflow content lives in the bag, not in files

("wsys" is just the author's shorthand for "workflow system" — an
earlier draft mistook it for a rule name; the idea below is what
matters.) Once the record types carry it (L2–L3), **none of the
workflow system's own content lives in repo `.md` files** — it all
lives in contextual's store, stored/synced via automerge:

- **prose documents** (product description, user stories, the
  architecture essays) → **section records** in the automerge store
  (W1): keyed documents with a type field. (The kv annex they were
  once slated for was removed — pre-generalization artifact.)
- **structured state** (todos → work items, decisions, annotations,
  everything with lifecycle and history) → **record types** (L2),
  `cx item` verbs + MCP tools (L3)
- **markdown stays the authoring format** — files are inputs, not the
  store: import (harvest pattern), then the file is a stub or deleted.
  The bag is the single home; `cx export`/section views regenerate the
  publishable prose on demand
- **files remain files** for: code, binaries and GLB (Derived plane),
  vendored material — the rule is about workflow content, not Content
- plan.md and plan2.md migrate the same way: `## TODO` sections become
  items at L3, their prose becomes section records

Interim: until section records land (W1), the docs keep their
markdown homes in `research/context/` — migration is a one-time import
per document (`cx harvest --take` shape).

## Work-item facet — decision: native, not adopted

**Do not adopt** beads (Go), beads-rs, or br as tools. Build the facet
as a contexture record type on elastic. Why: all three capture exactly
one facet of the goal; their storage/sync machinery (Dolt, SQLite+JSONL
export, CRDT-on-a-git-ref) duplicates what hub+elastic already provide;
and their history is either native-by-accident (Dolt) or bolted on
three ways (br). Ours is native by construction.

**Borrow the workflow wisdom:**

| from | idea | lands as |
|---|---|---|
| beads | ready / claim / close lifecycle, epics (parent/child), `discovered-from` links (never lose noticed work), priority, `bd remember` | item record type + lifecycle ops (remember = atoms, already live) |
| beads-rs | conflicts-impossible convergence, per-replica write stamps, tombstone TTLs, deterministic collision remap | elastic merge semantics (the algebra already ours) |
| br | capacity limits + admission policy (atomic), gates on items, scheduler ranking *with explainable evidence*, `--json` everywhere, doctor/repair | policy layer (local eval, never merged), gates → annotations, ranking at resolve time |
| all | `--json` / MCP surface over prose files | MCP tools from day one |

**Schema sketch** (record type `work_item`):

- LWW fields: `title`, `priority`, `status` (open → in_progress →
  closed), `assignee`
- OR-sets: `labels`, `notes` (append-only, id-keyed)
- typed edges (OR-set of links): `blocks`, `discovered_from`, `child_of`
- `acceptance_criteria`, `design` as LWW text fields (br/beads extended
  fields)
- identity: content-hash-free, short random id with collision remap
  (beads-rs §4.1.1) — work items are *named*, not content-keyed, unlike
  atoms
- history: the ledger itself — every mutation an op with actor,
  timestamp, write stamp; `ready`/`blocked`/`changelog` are folds

## Engine substrate — recommendation (revised)

**Don't reinvent the correctness core. Use `automerge-rs` (vendored:
`vendor/automerge-rs`, 0.12) as the state + history + sync core.**
The earlier hand-roll + `lattices` recommendation is withdrawn: the
risky part — clocks, causality, tombstones, concurrent-write
resolution — is exactly what a battle-tested CRDT core already solved.
Evidence it's the risky part: beads-rs's ongoing CRDT overhaul; br's
three bolted-on history mechanisms; contextual's own unproven
`absorb_snapshot`. We build only the domain layer nobody else has.

- **Why automerge over yrs (`vendor/y-crdt`, 0.28):** history is
  first-class — hash-linked change DAG, actor/timestamp/seq on every
  change (`get_changes`, `get_change_by_hash`); "history as changes
  over time" is native, citable, attributable. Built-in append-only
  persistence (`save`/`load`). yrs syncs more compactly (state
  vectors) but history/attribution are second-class, and storage
  would be ours to own.
- **Zed's CRDT (`vendor/zed`): prior art only, not a candidate.** A
  specialized text-sequence CRDT (`text` + `clock` + `sum_tree`):
  op-relay sync via `send_operation`, no deltas or state vectors
  anywhere, no map/record types, no citable history, no persistence,
  GPL/Apache dual-licensed. Model unchanged for over a year — recent
  work is maintenance and perf. Borrow ideas (SumTree for the derived
  index), not code.
- **Hub unification:** the hub's DO becomes an append-only log of
  changes — atoms, work items, decisions, annotations all arrive as
  attributed changes; machines and agents pull what they're missing.
  History and distribution are one mechanism; snapshot-merge
  machinery disappears.
- **Packaging (revised):** the typed layer over automerge — record
  types (LWW map fields, array notes, edge sets), lifecycle and query
  folds (ready/blocked/graph), capacity policy (local eval, never
  merged), a SQLite **derived index** for query/FTS (cache of doc
  state, never truth), MCP/CLI tools — starts as modules inside
  contextual. `elastic` names the extraction, if it ever happens.
  bagflow (DFIR) stays a reference prototype.
- **hydroflow/DFIR, timely:** no — wrong problem. **raft-rs/openraft:**
  no — reaffirms `resident-mcp/replication.md`; a CRDT core makes
  consensus moot for this plane. **`lattices`/`crdts` crates:**
  withdrawn with the hand-roll.
- **Open question kept:** atom back-compat — existing SQLite ledger
  atoms do a one-time import into an automerge doc at L2; the snapshot
  JSON contract is superseded by change blobs + a JSON view export.

Beads software stays left behind, for the same reason: with a
battle-tested core, what ours adds is the typed record layer + hub
log + MCP tools — work beads re-implements per tool. Vendor clones
(beads, beads-rs, beads_rust, y-crdt, automerge-rs, zed) stay as
reference reading only.

## Engine milestones (automerge behind `Storage`; elastic deferred)

- **L0 — substrate in place (done):** `nursery/bagflow` cloned as the
  reference prototype (own repo, `fluid-notion-labs/bagflow`;
  explorations ignores `nursery/`). Not renamed; no further L0 work.
- **L1 — automerge behind `Storage`** (= plan.md M4): `AutomergeStore`
  in contextual — ledger, fold, and absorb ported onto automerge
  change application; push/pull switch from snapshot JSON to change
  blobs; hub DO becomes an append-only log of changes. Snapshot JSON
  stays the contract until the L2 atom import. Design (done):
  per-source sync and tombstones mapped onto the automerge doc model —
  `contextual/research/memory-plane.md` §L1 design.
- **L2 — record types** (in contextual): typed records beyond atoms;
  per-field merge (LWW registers, OR-sets); tombstones with TTL; write
  stamps; one-time atom import into the automerge doc.
- **L3 — work items**: the record type above + `cx item` subcommands +
  MCP tools (ready/claim/close/graph), `--json` throughout.
- **L4 — policy & ranking**: capacity/admission (local, atomic,
  never merged), gates as annotations, evidence-ranked scheduler.
- **L5 — later**: item state distribution via hub alongside atoms;
  multi-repo scope; templates.
- **elastic (the crate)**: extracted only when a second consumer
  appears — until then the name denotes the typed layer, not a repo.

## Open questions

- **Todo lists "hanging off other things":** until L3, per-doc `## TODO`
  sections (this file's list below); after L3, todos *are* lightweight
  work items — every doc's todo section migrates into the record type
  with a `source` link back to the doc. Confirm or amend.
- **Write stamps:** per-replica monotonic counters (beads-rs dots) vs
  hub-sequenced. Hub-sequenced is simpler (single writer) but makes
  offline mutations stale-ordered; decide at L2.
- **Tool surface:** extend `cx` + `cx-mcp` with item verbs, or a
  separate `elastic-mcp`? Lean: extend cx (one MCP server, one tool
  vocabulary).
- **Doc placement:** resolved by the rule above — markdown homes in
  `research/context/` until L2, then everything migrates into the bag
  (prose → section records, todos → work items).

## TODO (the list, until it becomes items)

- [ ] write `product.md`
- [ ] write `stories.md`
- [x] refresh architecture docs (done: umbrella promoted to
      `architecture.md`; bag doc is `contextual/research/memory-plane.md`
      with elastic rows, L1 note; stale architecture2/plan references
      updated everywhere)
- [x] L1 (store): `AutomergeStore` behind `Storage` — done, tested
      (per-source replace, tombstone permanence, two-machine merge)
- [ ] L1 (transport): change-based push/pull; hub DO as change log;
      flip the default store
- [ ] L2: record types, per-field merge, tombstones, write stamps;
      atom import
- [ ] L3: work-item record type, `cx item`, MCP tools
- [ ] L4: capacity/policy, gates, scheduler ranking
- [ ] L5: hub distribution of item state
