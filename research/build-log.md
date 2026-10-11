# Contextual — build log

*The build as history, not plan: what was built, in what order, how long it
took, and what bit. The forward-looking work-list lives in
`plan.md` (M4); this records the finished part. Design docs:
`research/context/findings.md` (concept), `architecture.md` (system),
`pi-plugin.md` (pi side), `curation.md` (policy).*

## The one-day build (2026-10-10)

Concept (`findings.md`) to live system in one working session,
roughly 6–8 hours of actual build time. The research was written first —
concept, architecture, curation policy, plugin spec — so building was
mostly transcription of decided design. That pre-payment is the reason the
rate looks absurd; the design docs were the actual work.

Sequence, as it happened:

1. **M0 — parser + resolve.** Homoiconic markdown parser: H1 scope, H2 node
   + tags, `- atom` bullets, wrapped-line rejoin. Resolve = untagged ∪
   referenced tags, sorted, each fact once.
2. **M1 — storage + CLI.** `Storage` trait, `SqliteStore` (WAL), CLI `cx`
   with add/rm/tags/export/absorb. Global + explorations context imported.
3. **M2 — corpus.** Per-source sync discipline: a source owns its rows
   wholesale; re-import replaces in one transaction, idempotent.
4. **M3 — MCP + plugin.** `cx-mcp` (resolve/search/add/remove/tags, hermes
   curation policy embedded in the tool schemas, startup pull / write
   push); pi plugin (registerMcpServer, per-turn `<context>` injection,
   `/context` viewer).
5. **Distributed spine, in parallel.** bagflow (lattice over DFIR/hydro,
   versioned JSON snapshot, `bagflow-serve`), lattice/sync/persistence
   docs, contexture (Worker + DO, OR-set events, snapshot out).

## What bit (the fiddly edges)

The core bag ops were a couple of hours; the rest was edges:

- **One-shot MCP reader dropped coalesced stdout chunks** — `cx-mcp` replies
  were discarded → client timeout. Only found when running live against pi;
  unit roundtrip tests passed because they never coalesced.
- **schema-v1 migration** from the earlier count-column multiset layout to
  the per-source ledger `(text, source, scope, node, tags)` — auto-migrated
  in place, but it was the moment atom identity changed.
- **Garbage hashtags from scraped packs** — the four skills packs were
  mangled markdown (truncated bullets, `##`/`###` fragments as tags).
  Fixed by `cx rm-source` (tombstoned so hub pulls can't resurrect them)
  and hardening `hashtags()` to require a real hashtag after `#`.
- **P4 double-delivery guard** — thinning AGENTS.md/CONTEXT.md to pointer
  stubs required a zero-bullet guard so a re-import of a stub couldn't
  wipe the source's real rows. Pre-P4 file backed up
  (`AGENTS.md.pre-p4.bak`); repo copies survive in git history.
- **Dissolved packs** — packs were a parallel ingestion channel that lost
  to the tagged-atom model; removed rather than maintained.

## State at completion

- Bag live: 25 atoms — 15 default (3 project nodes, 6 global nodes),
  6 tagged `#rust`, 4 tagged `#npm`.
- Verified end to end in a real pi session: `<context>` injection visible
  to the model, defaults present without any tool call, `#rust`/`#npm`
  pulled on demand via resolve, harvest importable, writes batchable.
- AGENTS.md (global) and explorations CONTEXT.md are pointer stubs; the bag
  is the sole authority.
- Hub deployed; push of post-P4 atoms pending a production token. Other
  machines converge after that lands + plugin install.

## What the day actually bought

The system now compounds: every session starts already knowing what would
otherwise be re-explained, and every session can write back. The 6–8 hours
amortize over every future session across every machine — the cheapest
infrastructure this workspace has.

Open measurement: the injection's cache effect (does the per-turn
`<context>` block sit stably in the prefix?) — needs the usage ledger,
see `research/cache-aware-compaction/` and
`research/ai-harness-memory/index.md` §3.6.
