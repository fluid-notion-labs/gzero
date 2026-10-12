# Lockstep — jj as the work substrate, the store as the decision substrate

*The work-capture design: every agent edit recorded in jj as it arrives,
organized after the fact into named commit sets; decisions ride the context
store; the two advance together. DeltaDB analogy: they record CRDTs via
agent edit tools and export to git — we invert it: jj* is *the recording
substrate (git underneath, colocated), no CRDT layer for work state.
Companions: `deltadb.md` (their model), `history.md` (session timelines),
`distribution.md` / `data-shape.md` (the context store), `architecture.md`.*

## The write path (the blocking story)

The recording only works if **tools are the only write path** — Delta gets
this for free by owning the edit tools; we enforce it in three layers:

1. **Soft gate — context.** A workstyle directive: edits happen via the
   edit/write tools, never via bash redirection, `sed -i`, here-docs. Cheap,
   advisory, but agents follow context well, and it makes violations
   legible rather than surprising.
2. **Hard gate — tool surface.** A pi permission extension: remove `bash`
   from the active tool set (`pi.setActiveTools()`), or block every `bash`
   call in a `tool_call` handler returning `{block: true, reason}`. Writes
   reach the filesystem only through `edit`/`write` (and any sanctioned
   custom tools).
3. **Escape hatch — user grant.** Same extension, `ctx.ui.confirm` per
   call: the user grants bash (or a specific destructive tool) for one
   call/session. Fine-grained, auditable, recorded in the session log.

Provenance is the payoff: every filesystem change flows through a tool
call, so every change has *who, which session, which turn, what intent*.
Bash-removal is not strictly required for capture (jj snapshots would
catch bash-written edits anyway) — it's required for **attribution** and
for predictability.

Bash's real value — pipelining, filtering, composing — has a designed
replacement already: `research/mcp-pipelining-scripting/` (server-side
pipeline fragments + pi's codemode for client-side
filter/map/chain over tool output). Removing bash costs nothing that
codemode doesn't cover; the escape hatch stays for the long tail.

## Capture: fine-grained linear history, free

- Tool edit lands in the working copy → **jj auto-snapshots `@`** → the
  change advances. The snapshot chain *is* the fine-grained history:
  every edit captured as it arrives, no commits, no ceremony.
- The session event log (`history.md`) records
  `{seq, tool, patch, change_id}` per edit — the join key.
- Colocated git means the substrate is already git objects; "export to
  git" (Delta's land step) is unnecessary — push *is* publication.

## Organization after the fact: named sets of commits

Capture first, curate later — jj's native idiom, the opposite of git's
history-rewriting taboo:

- `jj split` / `jj describe` / `jj new` reshape the raw snapshot chain into
  coherent commits; bookmarks + revset aliases name the sets.
- Curation acts are session events (and, when they mean something, context
  facts: "landing `feat-x` embodies decisions A and B").
- Raw fine-grained history is **cache, not contract**: snapshotted ops can
  be GC'd once curated; the curated sets are the durable publication.
  (Same cache/contract line as `history.md`, now on the work side.)

## Lockstep with the context store

The two substrates advance together through shared reference fields:

- **Facts carry `work_ref`** — the jj change-id (or named set) at the
  moment of the decision: "we decided X while at change Y".
- **Curations emit facts** — merge-decision facts (verdicts, landings,
  renames of sets) are recorded in the store, the DeltaDB theft:
  *the merge event is data*.
- **Both directions queryable**: jj change → decisions made in its ancestry
  (`facts where work_ref ∈ ancestors(change)`); decision → the work state
  where it was made. The #35483 point-in-time question — "select a change,
  ask about the context around that moment" — resolves as a join over the
  jj op-log, the session log, and fact stamps.

Lockstep is a convention, not a protocol: nothing forces a fact to carry a
`work_ref`, and nothing blocks a commit set without a landing fact. Drift
is detectable (unreferenced changes, work_ref-less decisions) rather than
prevented — in keeping with facts-replicate, derived-doesn't.

## Why jj and not a CRDT worktree (i.e., not DeltaDB)

- **Single writer per machine** makes total order free — the McSherry
  condition holds; no merge machinery needed inside the capture path.
- **Conflicts stay conflicts.** CRDT merge silently unifies concurrent
  code; jj represents conflicts as first-class values for the agent to
  resolve explicitly. For code, silent convergence is a bug, not a
  feature.
- **After-the-fact organization** is native (operation log, mutable
  history), where DeltaDB must reconcile a CRDT timeline with git's
  immutable commits at export time.
- **Multi-machine** is push/pull, already the jjc workstyle directive.

## Two agents, one repo — the coordination story

The substrate makes the protocol cheap. jj 0.38 primitives, verified:

- **One workspace per agent session** (`jj workspace add`): each has its
  own working-copy commit, sparse patterns, and shows as `<name>@` in
  `jj log`. A second agent never interleaves snapshots into the human's
  working copy — attribution is structural (which workspace = which
  agent).
- **Nested bookmarks as the worktree tree**: `feat/distributed/lattice`,
  `feat/distributed/hub` — slashes are convention, but revset globs
  (`bookmarks(pattern:"feat/distributed/*")`) make the family queryable,
  so grouping is functional, not cosmetic. Families integrate
  children-first (deepest first), rebasing up the tree to `main`.
- **Conflicts are first-class values.** jj records conflicted merges as
  commits rather than failing; `jj log -r 'conflicts()'` selects them;
  `jj resolve --list` enumerates conflicted files. A conflicted commit is
  a legal state — resolution is a separate, schedulable step.

### Conflict detection — the implementable piece

The primitive is a **speculative test-merge**: in a throwaway workspace,
`jj new <head-A> <head-B>`, then read the conflict set
(`files(conflicts)` / `jj resolve --list`). Neither agent's working copy
is touched; jj *is* the conflict oracle — no merge machinery of ours.

It is also the expensive tier, so it sits at the end of a funnel.

### The detection funnel (cheap → expensive)

Contextual sits in the write path — every edit already flows through an
observed tool call, so per-session edited-file sets are a free byproduct
of capture, and contextual already holds the multi-view: which session,
which workspace, which files. The funnel runs on each edit event; each
tier is consulted only when the previous one says "maybe":

1. **File-set check** (free). Intersect the concurrent sessions' edited
   file sets. Empty intersection → merge-safe by construction; stop.
   This certifies merge safety only — disjoint files can still be
   semantically coupled (new module vs. `lib.rs` edits); that is
   review's problem, not the coordinator's.
2. **Range check** (cheap). For shared files, compare edit spans.
   Disjoint spans — with adjacency padding, since two insertions at
   the same point collide even though both spans are empty → probably
   clean. Spans come from the edit events themselves (edit's oldText
   locates the span; write is whole-file), and are only comparable
   against a common ancestor, so each carries its base commit.
3. **Collision check** (expensive). Overlapping spans → the speculative
   test-merge above, and only then. jj decides; tiers 1–2 exist to
   keep this rare.

A conflict from any tier → a **conflict fact** in the store, carrying
`work_ref`s for both sides. Physical conflicts become protocol events;
the other agent's session sees it on its next resolve/pull.

The funnel covers gated writes. Anything reaching the working copy
outside the write path (human edits, escape-hatch bash) is invisible to
tiers 1–2, so an op-log backstop remains: on each jj snapshot, run
tier 1 over the fresh diffs as a sweep.

### Integration policies (declared, not hardcoded)

Three viable postures — the choice is per-work, declared as facts; the
store is the coordination channel (agents read protocol from context,
write decision facts back), jj holds the conflict values:

1. **Pull-in (continuous)** — the waiter rebases onto the other's work as
   it lands. Finest granularity; rebase churn — poor for unrelated
   features.
2. **Wait-then-rebase (integration gate)** — one agent pauses writes; the
   other finishes; work lands on `main`; the waiter rebases once and
   continues. Coarser, cheap, the default posture.
3. **Merge-rebase-fix later (blind)** — both proceed; conflicts
   accumulate as first-class values in recorded merges; resolution is
   schedulable work, possibly a third agent's. jj makes this safe where
   git makes it forbidden.

Neither substrate does coordination logic beyond policy lookup: the store
holds the protocol and the events; jj holds the conflict values.

Tier 3's oracle is a jj shellout today, but the same query is a
tree-model backend operation in `../resident-mcp/architecture.md`
(jj/git is backend 1 there) — the funnel is contract-level, not
jj-bound.

## Perf shape

- One jj snapshot per tool call: milliseconds; volume bounded by edits,
  not keystrokes (Delta's character-level capture is the more expensive
  bet, right for their UX, unnecessary for ours).
- Op-log and raw snapshots grow without bound until curated — retention
  policy is a knob, not a correctness issue.
- The heavy query (point-in-time context across both substrates) is
  bounded by checkpoint density (`history.md`).

## Open questions

- Arbiter default when a conflict fact lands and no policy fact exists:
  oldest-session-waits? ask the user? — needs one chosen rule.
- Funnel placement: pi extension vs contextual core — and the op-log
  sweep cadence for writes that bypass the gate (human edits,
  escape-hatch bash).
- Where session logs live: blob facts in the store, per `history.md` —
  confirm wire format before capture starts producing volume.
- The permission extension's default posture: which tools count as
  "write" for gating (edit, write, and any tool with a filesystem side
  effect it declares).
