# Runaway storms — distributed state hazards, case studies and rules

*2026-10-19. Written the morning of the first one. This system's
distributed layer is young; the failure modes below are the ones we've
already hit or narrowly missed. Each storm is cheap to prevent and
expensive to debug — the rules at the bottom are the distillation.
Companions: `context-rebuild.md` (the incident), `sync-daemon.md`
(the design that must absorb these rules).*

## Case study: the resurrection storm (2026-10-19, round 2)

Goal: wipe a poisoned context (bloated change log, dead-path sources)
across two machines and one hub, then re-import curated data.

Sequence of the storm:

1. Both machines' docs wiped (files moved to archive), hub change log
   truncated (3240 changes deleted). Verified: hub log empty.
2. Re-import ran on machine A (laptop): 31 curated files, sections,
   items. Verified: 678 atoms, exactly the curated set.
3. Old state silently reappeared on **both** machines — dead-path
   sources, old items with old ids — despite the hub log containing
   only post-truncate changes (verified by change inspection).
4. Root cause: a long-lived process on machine B (an in-development
   daemon, plus idle sessions) had loaded the **pre-wipe doc into
   memory** before the wipe. After the wipe it kept saving that
   in-memory state to disk (defeating B's wipe) and pushed the old
   doc's changes to the hub as *new* seqs (defeating the truncate).
   Machine A's pull-first sync then merged the resurrected state back
   in. The repair mechanism itself was the re-infection vector.

Detection was hard because: (a) the hub log *looked* clean — content
scans of automerge changes are unreliable (text is RLE-encoded, op
columns are deflate-compressed; a grep for titles finds nothing), and
(b) each individual observation was locally consistent.

## The hazard catalogue

- **Truth contest / holder inertia.** Any process holding state in
  memory outlives external resets and wins by persistence, not by
  correctness. On-disk wipes and hub truncates are invisible to it.
- **Truncate ≠ retract.** Deleting the hub log destroys evidence, not
  knowledge. Every replica that loaded the old changes still *has*
  them; a stale-memory push re-uploads them as new. A log reset only
  works if every holder either dies first or provably reloads.
- **Wipes are not atomic across machines.** Kill/wipe/truncate/reseed
  is a distributed protocol, not a cleanup script. Partial ordering
  (wipe A, truncate hub, wipe B — while B has a live holder) is the
  storm's birthplace.
- **Cursors are claims, not facts.** A SyncCursor asserts "the hub has
  everything up to here." After any external hub mutation (truncate,
  snapshot upload), old cursors describe a hub that no longer exists.
  Epoch counters make this detectable; without them it's silent.
- **Poison pages block progress.** `sync_once` pulls before pushing:
  one oversized/undecodable page in the log blocks *all* pushes behind
  it, on every replica, on every write. A log is a shared resource;
  one bad page is a fleet-wide stall.
- **Packing away tombstones too early resurrects deletions.** Tombstones
  are part of resolved state until every peer has passed the horizon
  (packing design's rule; item 0a0a). Same shape as the resurrection
  storm: the collection mechanism becomes the resurrection mechanism.
- **Byte-scans of automerge changes lie.** Change payloads encode text
  as RLE character runs and deflate-compressed columns. "I searched
  the log for the old content and found nothing" proves nothing.
- **Operational footguns multiply under stress.** `pkill -f gzero-mcp`
  matches your own ssh wrapper's command line and kills it
  (`pkill -x` is the fix). Every emergency procedure should be
  rehearsed calm, because it will be run frazzled.

## Rules (distillation)

1. **One writer per doc, always.** The resident daemon is the single
   writer; sessions read through it or lose the write race. (Debt
   ledger already says this; storms raise it from performance concern
   to correctness requirement.)
2. **Reload-before-push.** A holder must reload state from disk/hub at
   startup and must never push from memory loaded before an external
   reset. If you can't prove the memory is post-reset, don't push.
3. **Epochs make divergence normal.** Pack/truncate introduces
   "no shared history" as a *state*, not an error: epoch counter in
   doc + snapshot; peers detect the bump and re-bootstrap from
   snapshot. Change-sync stays an optimization, snapshot stays the
   floor. (Packing design + comms epoch roll are the precedents.)
4. **Resets are protocols.** A coordinated reset = quiesce all holders
   (kill or checkpoint+reload) → verify none hold pre-reset state →
   wipe/truncate → re-seed → verify via a *fresh client* pull. The
   fresh-client test (new doc, full pull, compare against the
   reference export) is the acceptance gate for any reset.
5. **Verify by materializing, never by scanning.** To check whether a
   log or doc carries state X, apply it to a scratch replica and read
   the resolved view — don't grep bytes.
6. **Compaction respects TTL horizons.** Nothing is packed away while
   any peer might not have seen it.
7. **Design the storm test with the feature.** For every new holder,
   reset, or compaction path: write the chaos test at the same time
   (kill mid-sync, wipe with live holders, truncate under load). A
   feature whose failure mode is "silently resurrects deleted data"
   does not get found by happy-path tests.

## Why this matters more as the daemon lands

The daemon concentrates all of the above: it is the long-lived holder
(paragraph 1), the packer (3, 6), the reset participant (2, 4), and the
thing that must survive its own crash mid-compaction (crash between
snapshot upload and local swap; comms' "snapshot written before
truncation, so a crash leaves a redundant, not missing, log tail" is
the ordering template). The storms get bigger as the holder gets more
authoritative — which is the argument for writing the rules into code
(invariants, assertions, the fresh-client test in CI) rather than into
prose alone.
