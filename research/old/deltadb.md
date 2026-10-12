# DeltaDB — Zed's Delta substrate (survey)

*What Zed shipped for the #35483 follow/scrub request, how its data model
works, and what to steal. Delta is in beta; source not public — this is from
the official docs (`delta.dev/docs`). Companions: `history.md` (our scrubbing
design), `datastore-survey.md` (routes), `distributed-state.md` (log vs
merge).*

## What DeltaDB is

The shared database behind every Delta thread. One substrate holds the
whole working state: thread messages, comments, **worktree file contents**,
and file edits — recorded continuously, "character by character", not at
commits. Key properties from the docs:

- **The unit is the delta** — a recorded change (file edit, tree change,
  message, comment) that records *who* made it and *where it belongs in the
  thread's history*. DeltaDB "combines changes from different participants
  and keeps every copy synchronized" — multi-writer replication, i.e. CRDTs
  ("crdts et al", as suspected).
- **Full replica per client**, synced between people, agents, and machines
  in real time.
- **Worktrees live in the database.** A "checkout" is a disposable mount of
  DB state onto the filesystem when filesystem tools need it — the directory
  is temporary, the worktree is not tied to it.
- **Revert rewinds everything together:** the conversation *and* the files,
  to any earlier point, no commit involved. History is first-class: the
  timeline query (#35483's "ask about the context at that moment") is a
  product feature, not an afterthought.
- **Git stays the publication layer.** Commits are still Git commits; DeltaDB
  adds fine-grained, replicated history *beneath* them, and even moves
  commits peer-to-peer between machines.
- **Review forks + verdict snapshots:** reviews run in forked worktrees; a
  verdict is a snapshot of the review's edits; pulling applies that
  snapshot; the merge is itself a recorded delta.

## Their model vs ours

DeltaDB and our design make **opposite granularity bets on the same
split**:

| | DeltaDB | ours |
|---|---|---|
| unit of record | the *change* (op/delta, ordered, causal) | the *fact* (state, order-free) + max-stamp registers |
| order | per-participant order, "where it belongs in history" | deliberately none on merge; `(session, seq)` only on session logs |
| history | one unified substrate timeline (messages + files) | two layers: unordered fact history; ordered per-session logs |
| state volume | whole codebases, continuous capture | personal store, events-not-states + checkpoints |
| prose | inside the DB (CRDT text), files are mounts | git; the lattice holds pointer facts only |
| engineering floor | columnar DB, full replica, real-time sync | SQLite/snapshots + hub |

Their integrated timeline is what buys "revert thread to an earlier point"
as one gesture. We deliberately can't do that across the store — our store
history is unordered by construction. For the *session* timeline (which is
where scrubbing actually happens — see `history.md`) our log layer gives
the same UX. The unified bet would force the whole codebase through
CRDT-text + columnar storage: the right call for a multiplayer editor
company, not for a personal architecture store.

## What to steal

1. **Deltas carry who + where-in-history.** Our facts already carry
   `(replica)`; our session events carry `(session, seq)`. The lesson:
   causal placement metadata is cheap at write time and priceless at query
   time. Keep both.
2. **Checkout-as-mount inversion.** State lives in the store; filesystem
   presence is a disposable materialization. For agent-authored/scratch
   data, this is the right default — don't mirror store data into
   hand-maintained files. For authored prose we keep the current inversion
   (markdown is source, bag derived) because the authoring surface is for
   humans first. Both inversions can coexist, keyed by data type.
3. **Continuous capture, commits unchanged.** Recording at keystroke
   granularity is what makes follow/scrub feel native. Our equivalent is
   capturing session events as they happen, not on request.
4. **Merge events are data.** "Pulled review verdict X" is a fact; merges
   of *state* are order-free for us, but *decisions about* merges
   (approvals, verdicts, landings) belong in the store as facts.
5. **Git as the publication layer, unchanged.** Confirms our layering: the
   fine-grained/mergeable layer sits beside Git; Git keeps its role
   (per `architecture.md`).

## Perf notes (their problem, ours smaller)

Full-replica + character-level capture + real-time sync is viable for them
because it's a funded DB project (columnar storage, cheap clones "with
tricks", lazy checkouts). For us: events-not-states, checkpointed folds,
sessions replicated as blob facts — same UX, several orders of magnitude
less machinery. The one perf lesson to keep: **mount/materialize lazily**
(checkouts die when unused; our derived views are the same idea).
