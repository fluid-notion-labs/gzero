# Contextual — plan3: the workflow system, local first

*Active plan (2026-10), written after a code audit. Supersedes
`plan2.md`'s build-order TODO; plan2 stays as reference for the engine
rationale, record-type schema, and the workflow-content rule (workflow
content lives in the bag, not in files). Ordering follows the
re-phased build order in `old/architecture.md`: the workflow system (WS)
built **locally**, then **distributed**; the resident track is far
later and not planned here.*

## Where the code is (audited 2026-10)

Everything lives in this repo (`nursery/gzero`), crate
`gzero`, binaries `cx` + `cx-mcp`, ~3.3k LOC:

| component | file | state |
|---|---|---|
| markdown parser, resolve, harvest, seeds, snapshot merge, repo identity | `src/lib.rs` (1179) | live, 22 tests |
| `Storage` trait + `SqliteStore` | `src/sqlite.rs` (305) | live, 4 tests; kv annex removed 2026-10 |
| snapshot JSON (atoms + tombstones), the merge unit | `src/snapshot.rs` (77) | live |
| hub client (`CX_HUB_URL`/`CX_TOKEN`: post_events, fetch_snapshot) | `src/hub.rs` (127) | live |
| CLI: add / rm / rm-source / harvest / tags / sync / pull | `src/main.rs` (431) | live; no ws verbs yet |
| MCP tools: resolve, search, add, remove, tags, harvest, ws_* | `src/bin/mcp.rs` | live, 15 tests |
| pi plugin: per-turn injection, `/context` tier browser, review hook, skills, workstyles | `pi-gzero-plugin/*.ts` | live; `EXPECTED_TOOLS` gate = resolve/search/add/remove/tags |
| global floor content, compiled in, reconciled at startup | `seeds/global.md` | live |
| hub (deployed Worker + DO) | **not in this repo** | source location unknown — find before D1 |
| bagflow (DFIR + lattices reference prototype) | `nursery/bagflow` | unrenamed, no code dependency |

## Audit findings — what needs to change

1. **L1 store is orphaned.** plan2 marks "L1 (store): AutomergeStore —
   done, tested", but that change (`yvqmtvystxuz`: 549-line
   `src/automerge_store.rs`, `automerge = "0.12"` dep, `Storage`
   wiring) sits on a branch diverging from `main` at `lzmoouuswlsv`;
   `yvqmtvystxuz::@` is empty — not in the current line. The current
   working copy has **no automerge at all**. Must be rebased onto the
   current tip and adopted (W0). Expected conflict: only
   `research/memory-plane.md`, which the restructure moved to
   `research/old/`.
2. ~~The kv annex is SQLite-only and outside the automerge doc~~
   **resolved 2026-10:** the annex was removed entirely — zero usage,
   a pre-generalization artifact (revert of `b6ef929`). Workflow
   content lives in the bag as record data (W1).
3. **Stale doc references**: `architecture.md` and `plan2.md` point at
   `gzero/research/memory-plane.md`, `research/context/…`, and
   `plan.md` — all now under `research/old/` after the restructure.
4. **plan2 TODO defects**: a duplicated L2 line; the "L1 store done"
   claim needs the orphan-branch correction.
5. **MCP surface gaps**: no `harvest` tool (the mcp.rs header comment
   says the model can call one); `EXPECTED_TOOLS` in the pi plugin
   must grow when item/ws tools land or stale installs won't warn.
6. ~~kv tools are MCP-only~~ — moot after the annex removal; the
   `cx` CLI has no ws verbs yet.
7. **The research restructure in `@` is uncommitted** — describe and
   land it before anything rebases onto it.
8. **Hub Worker source is not in this repo** — locate it before D1.

## Guiding decisions (carried in)

- **Local first**: all of Track W works offline, one machine. No sync
  concerns until Track D.
- **automerge is the engine core** behind `Storage`: per-field merge,
  native history (actor/timestamp/seq on every change), append-only
  persistence. SQLite is demoted to a derived index (query/FTS),
  never truth.
- **workflow content lives in the bag, not in files**: prose → section
  records; state (todos, decisions,
  annotations) → record types; markdown stays the authoring format;
  files are inputs, the bag is the store.
- **Work items are native** (not adopted): record type per plan2's
  schema; borrow the beads/beads-rs/br workflow wisdom.
- **One MCP server, one vocabulary**: extend `cx` + `cx-mcp`.

## Track W — the workflow system, local

### W0 — adopt the L1 store (unblocks everything)

- Describe and land the `@` research restructure (finding 7).
- Rebase `yvqmtvystxuz` (AutomergeStore) onto the new tip; resolve the
  `memory-plane.md` path conflict (its §L1 design prose follows the
  file into `research/old/` or gets pointed at from there).
- `cargo test` — the existing 43 tests are the conformance suite;
  AutomergeStore must pass the same Storage-contract tests.
- Verify `cx`/`cx-mcp` run against either store. **Do not flip the
  default store yet** — that belongs to D1 (single machine, no
  urgency).
- House rule: workspaces other than default exist (`cx-*`, all
  committed); confirm no live session before merging to `main`.
- *Acceptance:* green tests; add/resolve works on both stores;
  working copy clean.

### W1 — WS data model: sections as records

- Sections live directly in the automerge doc as record data
  (syncable later at D1). The kv annex they were once slated for was
  removed (2026-10, revert of `b6ef929`): never used, superseded by
  typed sections.
- **Section record**: `{ key (dotted, project-scoped), type (md |
  checklist), title, body (LWW text), order }`. Project scoping via
  `repo_identity_in` (already in lib.rs).
- Arbitrary sections per the spec: vision, synopsis, architecture,
  plan, checklists, user stories — any name, any number, typed.
- `cx ws` verbs (new / list / show / set / rm) + `ws_*` MCP tools;
  `--json` throughout.
- *Acceptance:* create/read/edit sections for a project; checklist
  sections render as checkboxes; survives restart; round-trips via
  export/import on one machine.

### W2 — work-item record type

- Schema per plan2: LWW `title`/`priority`/`status`
  (open → in_progress → closed)/`assignee`; OR-sets `labels`/`notes`;
  typed edges `blocks`/`discovered_from`/`child_of`;
  `acceptance_criteria`/`design` as LWW text; short random id with
  collision remap (items are named, not content-keyed); history = the
  ledger itself; `ready`/`blocked`/`changelog` are folds.
- `cx item` verbs: add / list / show / ready / claim / close / graph /
  blocks; `item_*` MCP tools (read: ready, next, graph; write: add,
  claim, close); `--json` everywhere.
- Update the pi plugin's `EXPECTED_TOOLS`.
- Write stamps: adopt automerge's own actor + seq — no separate
  stamp mechanism locally; revisit only if hub-sequencing proves
  necessary (D2).
- *Acceptance:* hierarchical epics; ready/blocked folds correct;
  every mutation replayable as attributed history.

### W3 — injection: plan tasks into context (the WS payoff)

- The spec's promise: tasks from the plan enter the agent context,
  prompted by the user — semi-automatic, never auto-flooded.
- `cx-mcp` gains a read path: `resolve` optionally appends a compact
  "current plan" block for the repo, or a dedicated `plan_next` tool
  returns the top ready items with evidence. Decide by trying both.
- pi plugin: `/context` gains a plan tab (read-only sections + ready
  items).
- Seeds: add the skill-activation workflow atom to `seeds/global.md`
  (spec: when the user wants something *new*, assess activating a
  skill, ask first).
- *Acceptance:* "what's next" surfaces top ready items; "put task X
  in my context" works and the injected block is compact and stable.

### W4 — policy & ranking

- Capacity limits + admission policy, local eval, atomic, never
  merged (br). Gates on items (→ annotations when the resident
  exists). Scheduler ranking with explainable evidence at resolve
  time.
- *Acceptance:* stable ranking; every ranked item carries a
  human-readable why in `--json`.
- *Done 2026-10:* `item_rank` — score = priority·1000 + unblocks·100
  + in_progress·50 + min(age_days, 30); `Ranked { item, score, why }`
  with one evidence phrase per factor; `cx item ready` and `plan_next`
  rank with score + why (both text and `--json`); WIP limit (3 in
  progress per scope, evaluated at claim time — a rule, never merged
  state); `gate`/`gate_met` LWW fields — closing is refused while a
  gate is set and unmet (`cx item gate <id> --met`); `item_gate` MCP
  tool; later the resident's annotations set `gate_met` automatically.

### W5 — doc-set migration (workflow-content rule complete)

- Import the research prose (`architecture.md`, `plan2.md`,
  `plan3.md`, later `product.md`/`stories.md`) into section records;
  `## TODO` sections become work items with `source` links back to
  the doc; files become stubs or are deleted; `cx export`/section views
  regenerate publishable prose on demand.
- Fix the stale references (finding 3) as part of this.
- *Acceptance:* the docs read back from the bag; repo `.md` files are
  stubs pointing at `cx ws show`.

## Track D — distribution (after W works locally)

- **D1 — change-based transport:** hub DO becomes an append-only log
  of automerge changes; push/pull switches from snapshot JSON to
  change blobs; one-time migration off snapshots; **flip the default
  store** to AutomergeStore. Prerequisite: locate the hub Worker
  source (finding 8).
- **D2 — multi-machine:** sync tests across two machines; tombstone
  TTL policy; confirm actor+seq write stamps hold at two writers.
- **D3 — everything rides the hub:** item state and WS sections sync
  alongside atoms; multi-repo scope; templates (plan2 L5).

## Later — not planned here

`old/architecture.md` build order 4–7: thin resident shim → cloudrust
artifact pull-back → in-memory tree → full resident daemon; ai-harness
session tree after that. The MCP surface stays stable throughout.

## Open questions

- ~~Tool naming~~ **resolved 2026-10:** the kv annex was removed;
  `ws_*` is the only document tool surface.
- Do checklist sections and work items share one representation (a
  checklist section is a saved query over items), or stay separate?
- Exact wording of the skill-activation workflow atom in the global
  seed.
- Where the hub Worker source lives (repo unknown from this checkout).

## TODO

- [x] land the `@` restructure (describe; housekeeping in plan2: duplicate L2 line, stale doc pointers, "L1 done" → "adopted in W0")
- [x] W0: adopt AutomergeStore (rebase orphan, tests green, both stores work; merged to main)
- [x] blat the kv annex (revert `b6ef929`; context atoms updated)
- [x] W1: sections as records (sections in the automerge doc; `cx ws`; `ws_*` tools)
      — done 2026-10: `sections.rs` record model (scope/name/kind/title/body/order),
      `cx ws list|show|set|rm|scopes` (metadata-only updates keep the body; stdin
      and --file/--body input; checklist render with ☐/☑ + count), four `ws_*`
      MCP tools (ws_get errors list available names), 11 new tests; doc file
      `CX_WS_DB` (default `~/.pi/agent/context.ws`), hashes sidecar alongside
- [x] W2: work items (schema; `cx item`; `item_*` tools; `EXPECTED_TOOLS`)
      — done 2026-10: `items.rs` — LWW fields (title/priority/status/assignee/
      design/acceptance), OR-set labels + append-only id-keyed notes, typed
      edges (blocks/child_of/discovered_from) with target validation, short
      random ids with prefix resolution and collision widening, legal
      transitions only (closed → in_progress rejected), ready = fold (open
      items with no open blockers, ranked; dangling blockers ignored), 10
      tests. `cx item` add/list/ready/show/edit/claim/close/reopen/note/
      label/edge/rm + `item_*` MCP tools (add/list/ready/get/edit/note/
      delete); `EXPECTED_TOOLS` grew item_add/item_ready. Write stamps:
      automerge actor+seq, as decided. Unimplemented from the schema:
      graph/tree view (child_of data exists; `cx item graph` deferred),
      priority-based `assignee` capacity policy (W4).
- [x] W3: plan-task injection + skill-activation seed atom + plan tab
      — the workflow pane shipped (`pi-gzero-plugin/items-pane.ts`):
      non-capturing top-right overlay, data via `cx item list --json`,
      glyphs ○/●/✓ plus ⊘ for blocked, refreshed on session start +
      agent_end + `/items refresh`; auto-hides when empty, terminal < 100
      cols, or cx is stale; `/items` toggles. Plus Ctrl+W full-screen
      sections viewer (TierViewer over `cx ws list/show --json`; the
      editor wrapper intercepts ctrl+w, deleteWordBackward moved to
      alt+backspace). Install switched to a symlink.
      — done 2026-10: `item_pin` (pinned set in the workflow doc, root map
      `pinned: Map<scope -> Map<id -> true>>`); open pinned items render
      into every `resolve` call (the user's "put task X in my context" —
      only explicit pins, never auto-flooding); `plan_next` MCP tool
      returns top ready items ranked, each with evidence (unblocked,
      priority, labels, notes, subtasks); `cx item pin|unpin`, list shows
      ★ for pinned; skill-activation seed atom added to `seeds/global.md`
      and the stale kv-annex seed line replaced by the workflow-system
      line (retract-on-reconcile handles the old text). The plan tab is
      superseded by the pane + Ctrl+W viewer. EXPECTED_TOOLS gained
      item_pin, plan_next.
- [ ] W4: capacity/policy, gates, evidence-ranked scheduler
- [ ] W5: doc migration into the bag; fix stale references
- [ ] locate hub Worker source
- [ ] later: ai-harness scratch tree (superseded by the doc-store; not this plan)
- [ ] D1: change-based push/pull; hub as change log; flip default store
- [ ] D2: multi-machine sync; tombstone TTL
- [ ] D3: item/section state via hub; multi-repo; templates
