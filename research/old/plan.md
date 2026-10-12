# Contextual — implementation plan

*Prototype at `nursery/contextual/` (symlinked here). Concept and style
grounding: `findings.md` in this directory. Companions: `plan2.md`
(productization: the elastic engine, record types, work items — the
forward plan), `architecture.md` (the Contexture umbrella),
`contextual/research/memory-plane.md` (the bag's architecture),
`pi-plugin.md` (pi side), `curation.md` (agent-facing curation policy),
`sync.md` (transport), `lattice.md` (merge math). Bag = multiset;
storage = SQLite now, pluggable backend trait throughout; distribution
= contexture, the hub (deployed).*

## Goal

A persisted bag of terse, tagged instruction atoms that agents load as
context. Default subset always active; hashtags (`#rust`, `#style`) reference
everything else, Twitter-style. Replaces AGENTS.md as the instruction
mechanism; AGENTS.md becomes a thin pointer.

## Architecture

```
markdown (authoring, homoiconic)      model writes (mcp__context__add)
      │  parse: H1 scope / H2 node+tags / bullet atom
      v                                     │
   bag ops ── Storage trait ── SqliteStore (ledger) ──► hub (events in,
      │                                     ▲            snapshot out)
      v                                     │            startup pull
   resolve: global ∪ project tiers          │            write push
      │      untagged (default) ∪ #tags    │
      v                                     │
   `cx` CLI  ── export/absorb (git path) ───┘─ push/pull
   `cx-mcp`  ── MCP: resolve/search/add/remove/tags ──► pi plugin (inject)
```

Decisions (current):

- **Bag = content-keyed set**: atom identity = text; tags merge on
  re-import. No count/multiplicity field (dropped in the schema-v1
  migration) — the per-source ledger replaces it.
- **Ledger schema**: `atoms (text, source, scope, node, tags)`,
  PK `(text, source)`; `tombstones` (full atoms). Per-source sync: a
  source owns its rows wholesale, re-import replaces them in one
  transaction (idempotent). WAL on.
- **`Storage` trait**: `sync_source`, `all`, `remove_matching`,
  `tombstones`, `tombstone`. SQLite is the first impl; snapshot JSON is
  the cross-implementation contract.
- **Crate `contextual`, binaries `cx` + `cx-mcp`.** DB path: `$CX_DB` or
  `~/.pi/agent/context.db`.
- **Hub, not D1-behind-trait**: cross-machine is the deployed
  contexture (Worker + DO, OR-set events, snapshot out); `cx-mcp`
  pulls at startup and pushes on write. Git `sync/` snapshots remain the
  offline fallback.

## Milestones

### M0 — parser + resolve (done)
- Homoiconic markdown parser: `# Context — <scope>`, `## slug #tags`,
  `- atom` bullets with inline hashtags, wrapped-line rejoin. Untagged
  node ⇒ default set.
- `resolve`: untagged ∪ referenced tags, sorted by (scope, node, text),
  each fact once.

### M1 — storage trait + SQLite backend (done)
- `Storage` trait + `SqliteStore` (WAL, `:memory:` for tests, schema-v1
  auto-migration from the old count-column layout).
- CLI: `cx` / `cx #tag...` / `cx add f.md...` / `cx rm <needle>` /
  `cx tags` / `cx export` / `cx absorb` / `cx push` / `cx pull` /
  `cx sources`.
- Bag live: project + global context imported.

### M2 — corpus + agent integration (done)
- Imported repo `CONTEXT.md` + global `~/.pi/agent/AGENTS.md`.
- Re-import discipline: per-source sync (above); deletions propagate,
  duplicates don't accumulate.
- Packs (`packs/*.md`) + `cx recommend` shipped — **since dissolved**
  (see work-list below): packs were a parallel file-based ingestion
  channel; tagged atoms + the pull-in workflow replace them.

### M3 — pi integration (done)
- Consumption path: **MCP + plugin** (`pi-plugin.md`).
- `cx-mcp`: `resolve/search/add/remove/tags`, tiered resolve with
  repo-URL project identity, startup pull / write push (5s cap),
  hermes curation policy in tool descriptions (`add` batch `operations`,
  self-healing `remove`).
- pi plugin P1: registerMcpServer, install detect/offer, per-turn
  `<context>` injection with curation preamble, offline degradation.
- pi plugin P2: `/context` viewer, `/context reload`, `/context add`,
  stale-binary check via `tools/list`.

### M4 — evolution (open)

Work-list, roughly in order:

- [x] **Code rejib — dissolve packs** (done 2026-10-10):
  - [x] skills packs were already in the bag; `rust.md` + `npm.md`
        seeded via `cx add` (+6 / +4);
  - [ ] `cx push` of the new atoms — pending hub token (production
        secret; not in any config file);
  - [x] `packs/` deleted; `recommend()` removed (kept a tombstone
        subcommand that explains and points at the tags); tests green,
        binaries reinstalled;
  - [x] global-AGENTS.md packs instruction rewritten to the pull-in
        form, source re-imported (sync propagated the deletion);
  - [x] project-relevance atoms added via `cx-mcp` (contextual → `#rust`,
        contexture → `#npm`), untagged in project scope so each
        repo's default context names its tags;
  - [x] corpus cleanup: the four skills packs were scraped dumps
        (mangled markdown fragments, truncated bullets, `##`/`###` garbage
        tags) — removed wholesale via the new `cx rm-source` (tombstoned,
        so hub pulls won't resurrect them); `hashtags()` now requires a
        real hashtag (alphanumeric after `#`, trailing punctuation
        trimmed);
  - [x] plugin installed into pi (`pi install`), verified live end to
        end: `<context>` injection seen by the model, MCP tools callable.
        Found + fixed a real bug: the one-shot MCP reader dropped
        coalesced stdout chunks (replies discarded → timeout).
- [x] **P4 migration (done)**: injection verified live, so
      `~/.pi/agent/AGENTS.md` and explorations `CONTEXT.md` are thinned
      to pointer stubs — the bag is the sole authority, no more double
      delivery. Bag rows keep their original file sources; stubs are
      bullet-free and warn against `cx add` (per-source sync would
      replace the atoms with the stub). Pre-P4 global file backed up at
      `~/.pi/agent/AGENTS.md.pre-p4.bak`; repo copies live in git
      history. Post-migration curation: duplicate `serve-directory`
      rule consolidated (project copy tombstoned).
      Caveat: other machines see the stubs only after `cx push` lands
      their atoms + tombstones on the hub (token pending) AND the
      plugin is installed there.
- [x] **Harvest (feature, done)**: `cx harvest [dir]` + the MCP `harvest`
      tool import agent-instruction files written for ANY agent into the
      bag as project context — candidates at the repo root (+cwd):
      `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`,
      `.windsurfrules`, `.github/copilot-instructions.md`. Scope forced
      to the repo identity; source = canonical file path (per-source
      sync → re-run after the file changes, edits and removals of lines
      propagate); scope+source shared in `harvest_dir` (lib), both
      surfaces are thin formatters. Guards: zero-bullet files are
      skipped (P4 pointer stubs are protected — a zero-atom sync would
      wipe the source's rows); the parser now accepts `*` bullets
      (wild CLAUDE.md/GEMINI.md files don't use `-`). Positioning:
      contextual becomes the cross-agent context layer — instructions
      authored for claude/cursor/copilot land in one store. Trust note:
      harvested files are repo-authored, the same trust level as pi
      auto-loading AGENTS.md; harvest moves the text, it does not add
      attack surface.
- [x] **Organic harvest** (done 2026-10-11): `reconcile_harvest()` runs
      at cx-mcp startup — stat/hash each candidate file (FNV-1a, stored
      per source in a `source_hashes` side table), re-import changed,
      retract deleted (source removed; texts asserted only by that
      source tombstoned, texts other sources still assert keep living
      there), skip unchanged. Content hash means `touch` never triggers.
      `cx harvest --check` is the manual trigger, `cx harvest --take`
      imports then deletes the file and clears the hash (bag = sole
      authority; deletion never reads as retraction). Stubs stay
      protected (zero bullets → never harvested, deletion not a
      retraction). Startup Puts/Removes go to the hub. Tests: edit /
      touch / delete / take / stub. First-run behavior: an unhashed
      existing source harvests once, then reconciles.
- [x] **Hub merge-by-text** (fixes the duplicate-source bug): hub pulls
      used to insert as a second source, duplicating file-source rows
      (identity = `(text, source)`). Changed: `absorb_snapshot` now
      merges by text — known texts (any source, or tombstoned) are never
      re-imported; genuinely new texts land under the pull's source as
      provenance; a source's existing rows are unioned, not replaced
      (a later snapshot missing an atom can't delete it). Tests: merge
      idempotence, tombstone non-resurrection. One-time cleanup applied:
      22 duplicate hub rows deleted (ledger at 438 atoms, zero duplicate
      texts). Binaries reinstalled. Note: the running cx-mcp holds the
      old binary until next session restart.
- [x] **Post-turn review hook** (`curation.md` item 5, done 2026-10-11):
      pi version of hermes' background review. Design: every turn is
      captured into a pending list; one forked model call reviews the
      batch when the list reaches `CX_REVIEW_BATCH` (default 5; 1 =
      per-turn review). Fire-and-forget at `turn_end` — network-bound,
      so it runs concurrently with the next prompt without touching the
      main conversation or prompt cache. Saves via the one-shot cx-mcp
      path; scope routing global (user/env) vs project (repo, the
      add-tool default); hashtags make task knowledge on-demand.
      "Nothing to save." is the expected no-op. Scope exclusions
      documented in curation.md (revisit after use).
      - [ ] **Review model setting** (later feature): pin the reviewer
            to a chosen model (env or setting) instead of the session
            model.
      - [ ] **Jev gate** (idea): use the jev classifier for a cheap
            "does this batch need review at all?" pre-check.
- [ ] **Hub live push** (DO websockets) so pulls aren't per-session;
      plugin `/context reload` then picks up mid-session writes.
- [ ] **Modal first-open lag** (pi plugin): measured 2026-11:
      `discoverSkills()` is 354ms cold / 213ms warm (997 SKILL.md,
      ~4 MB). Since the #skill work it runs on session start, so the
      remaining cost is a one-time ~350ms main-thread hitch after
      startup (plus sync fallback if the picker opens before it lands).
      `/context` is a non-issue (~5ms for cx-mcp spawn + full-bag
      resolve). Fix if it bothers: `pull.py` writes
      `packs/skills-index.json` (name, description, vendor, path) and
      the plugin reads that instead of scanning; scan stays as the
      fallback.
- [ ] **Memory trajectory**: decision records as a second record type
      beside atoms — lands as plan2 L2 record types; then chat history as
      source material (`pi-plugin.md` §Trajectory).
- [ ] **KV on the hub**: the key–value annex (`kv` table, dotted keys →
      documents, `kv_*` MCP tools) is local-first — in the same SQLite
      file as the bag but not replicated. Design (see `distribution.md` /
      `datastore-survey.md`): immutable document versions are facts
      (OR-set, edit = tombstone + new fact); mutable fields (status,
      pointers) are max-stamp LWW registers. Remaining work: add the
      kv collection to the elastic ledger/codec (plan2 L2) and route
      `kv_put`/`kv_delete` through the write path (local merge →
      persist → publish).
- [ ] **Chaos harness** (`distributed-chaos-plan.md`): N simulated
      machines, faults, convergence oracles.
- [ ] **Cloudflare Artifacts backend** (host-agnostic repo identity
      already keys on the remote URL — see
      `contextual/research/memory-plane.md`).
- [x] **Unification** — absorbed into `plan2.md` as milestone L1:
      substrate = **automerge-rs** behind the `Storage` trait, inside
      contextual — no separate engine crate for now (**elastic** is
      the name for the typed layer if/when it's extracted; bagflow
      stays an unrenamed reference prototype). The no-SQL endgame and
      the L1 doc design are recorded in
      `contextual/research/memory-plane.md` (§Engines, §L1 design).

## Test strategy

- Parser, resolve filtering/dedupe/ordering, SQLite roundtrip,
  wrapped-line rejoin: unit tests against `:memory:` (in place).
- `cx-mcp`: JSON-RPC roundtrip tests per tool — batch `operations`,
  replace pattern, tombstones, self-healing no-match, tiered resolve
  (in place).
- CLI: assert_cmd smoke tests for `cx` / `cx add` / `cx #tag` — **not
  yet implemented**; the binary is thin over tested lib code.

## Acceptance (current state)

From any directory: `cx` prints global + project defaults from the bag;
`cx #rust` pulls tagged atoms; `cx-mcp` serves the same to pi sessions,
where the plugin injects the default tiers every turn and the model
pulls tags on demand; writes push to the hub and other machines see them
at next session start; `cx export`/`absorb` covers the offline path.
