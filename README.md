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

## Status

Parser, resolve, `Storage` trait, and SQLite backend done (M0–M2 of the
plan). Live: project + global context and two packs in the bag. Next:
re-import discipline after edits, pi integration (M3).
