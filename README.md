# contextual (cx)

Context bag: a persisted multiset of terse, tagged instruction atoms.
The replacement for AGENTS.md-style files. Belongs to the `context` concept
in `~/projects/explorations/research/context/findings.md`; implementation
plan at `research/context/plan.md`.

## Idea

- Context = **bag** (multiset, hashtable keyed by atom text), persisted.
- Atoms are terse, one rule each, tagged with hashtags (`#rust`, `#style`).
- A default subset (untagged) is **always referenced by default**; tags pull
  the rest on demand — like Twitter hashtags referencing concepts.
- Authoring stays homoiconic markdown; the bag is SQLite (pluggable
  `Storage` trait so a Cloudflare D1 or JSON backend can replace it).

## Key–value annex

Beside the atom bag, the same SQLite file holds a key–value store: dotted
keys map to whole documents. It exists for agents (the `cx-mcp` tools) —
any document that doesn't fit the terse-atom rules: working data, long
notes, JSON blobs, decision records.

- Keys are dotted paths, non-empty segments, no spaces:
  `research.auth.decision`.
- `kv_put` stores/replaces a document; `kv_get` on a leaf returns the
  document verbatim, on a branch key returns the whole subtree below it as
  `# key` sections; `kv_list [prefix]` lists keys; `kv_delete` removes an
  exact leaf.
- The annex is independent of the bag: no tags, no tombstones, invisible
  to `resolve`. It never enters the context stream by itself.
- Local-first: lives in the same database file (`CX_DB`, default
  `~/.pi/agent/context.db`) but is not yet replicated. Planned: hub sync
  with automatic pickup of new document versions — part of the distributed
  story (see `research/context/plan.md`).

## Status

Live system: parser, resolve, SQLite ledger, hub sync, pi plugin,
harvest, kv annex. Architecture: `research/memory-plane.md`; whole
system: `research/context/architecture.md` (Contexture umbrella).
Forward plan: `research/context/plan2.md` (elastic engine, record
types, work items); memory-layer history and open items:
`research/context/plan.md`.
