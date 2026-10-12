# History & scrubbing — time over the store

*Scrubbing back through states (the Zed follow-mode discussion #35483) as a
use case: what it needs from the datastore, what we already have, what's
missing, and the perf shape. Deferred — but two present-day decisions are
shaped by it. Companions: `data-shape.md`, `datastore-survey.md`,
`deltadb.md` (Zed shipped this — their model vs ours),
`lockstep.md` (jj as the work-recording substrate),
`distributed-state.md` (the log-vs-merge split).*

## The split that makes it tractable

Scrubbing is not a lattice problem. A session timeline is **single-writer**
(the agent/machine executing it), so a total order over its events is free
— append a log, number the entries. That is exactly the McSherry route
(log + total order + deterministic fold), and it's *correct* to use it here
because there is no multi-writer divergence to merge inside a session.

So the store has two time-bearing layers, different tools by design:

- **Shared facts** (the lattice): merge-order-free, eventual, scrubbing
  irrelevant. Facts are immutable and stamped, but their merge order is
  deliberately meaningless.
- **Session timelines** (per-machine event logs): total order, replayable,
  scrubbing native. The log *is* the history; state-at-t is a fold.

They compose: a timeline event references facts by id (put/remove/register
write). Scrubbing a session shows the store as that session saw it:
reconstruct = fold events up to t, or checkpoint + short replay. Sessions
replicate, if at all, as blob-pointer facts (`{cid, metadata}`), never as
mergeable state.

## What we already have, for free

- Facts immutable, tombstones forever → the *shared-store* history already
  exists (unordered, unlinked — `data-shape.md`).
- Register stamps `(counter, replica)` → per-value causality, reconstruct
  "who knew what when" locally.
- Snapshots as merge units → the same snapshot type doubles as a **history
  checkpoint**. No new artifact.
- jj precedent: operation log + `jj op log` is scrubbing for a repo; the
  model (log + checkpoints + deterministic replay) is identical.

## What's missing (the "later" work)

1. **Session event capture** — record agent actions (tool calls, reads,
   writes, prompts) into a per-session append-only log with `(session, seq)`
   stamps. Out-of-band of the lattice. Capture boundary is the open design
   question: at the harness/agent API (precise, like the Zed proposal), at
   the editor (Sobo's "observe the fs" fallback — tricky, as he says), or
   at the filesystem (ize's FUSE route — general, but sees everything and
   no semantics). `ize` (fluid-notion-systems/ize, shelved, research docs
   only) is prior art sitting in exactly this space.
2. **Checkpoint policy** — snapshot the folded state every N events; scrub
   cost becomes O(N) worst case, not O(session).
3. **Point-in-time query surface** — "select a symbol at t, ask about the
   context around that point": reconstruct state at t (checkpoint + replay)
   + the conversation slice around t. Redux devtools is the canonical toy
   version: state = fold over actions, scrub = re-fold.
4. **Linkage, again** — timeline events and store entities need the stable
   logical ids from `datastore-survey.md`. Third time this decision has
   surfaced; that's the signal it's real.

## The perf questions, answered now

- **Storage: record events, not states.** States are re-derivable; events
  are the irreducible record. Content-address any embedded state blobs
  (jj-style dedupe: identical states collapse to one cid).
- **Replay cost: bounded by checkpoint interval**, tunable per session type.
  In-memory caching of recent states makes back-and-forth scrubbing cheap
  (the common case is scrubbing near the end).
- **History is a cache, not a contract.** Unlike tombstones, session logs
  can be GC'd/compacted freely — correctness never depends on them. This
  is the difference between lattice-history (tombstones: keep, semantics)
  and timeline-history (logs: keep, convenience).

## Decisions today that this constrains

- Keep tombstones forever (already decided) — shared-store history rides on
  it.
- Adopt stable logical ids now — scrubbing needs entity linkage; retrofit
  is the irreversible mistake.
- Keep session data out of the lattice — blobs/pointers only.
