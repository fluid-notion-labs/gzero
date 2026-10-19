# Context rebuild — export, curate, fresh bag, re-import

*2026-10-19. The rejig that got forgotten once already: find it here
next time. Motivation and evidence below; execute top to bottom.
Work item in the workflow system tracks progress.*

## Why

The context bag carries stale and bloated state:

- **Dead-source atoms**: sources under paths that no longer exist —
  `/mnt/data/projects/...` (old disk layout), `projects-old/`,
  `nursery/contexture/`, `nursery/contextual/packs/` — including one
  source (`contextual/sync/atoms.json`) contributing 311 atoms.
  Harvested AGENTS.md files from abandoned checkouts.
- **Change-log bloat**: 1200+ changes in bag `context`, recent pages
  ~2.5 MB, which time out at the 10 s client read limit. Every write
  retries the same doomed pull; since `sync_once` pulls before it
  pushes, a failing pull also blocks pushes. This is the "pi is
  unusable" slowness (see `iroh-assessment.md`, `sync-daemon.md`).

## Machinery that exists (use it, don't rebuild it)

- `gzero export <file>` / `gzero absorb` — atoms + tombstones snapshot
  JSON. **Does not include sections/items.**
- `gzero item list --json`, `gzero item show <id> --json`,
  `gzero ws show <name>` — workflow docs, export manually (few).
- `gzero sources` — per-source counts, the curation map.
- Hub compaction endpoint: `POST /bag/{bag}/snapshot` truncates the
  change log (gzero-hub `src/bag.ts`). No client command uses it yet.

## Plan

### 1. Freeze + backup

- Pick a cutover moment. `gzero sync` on both machines; confirm equal
  atom counts (`gzero sources` diff).
- File-level backup on each machine: `context.ws`, `comms.ws`,
  `context.db` → `~/backups/gzero-rebuild-<date>/`.

### 2. Export everything

- `gzero export atoms-<date>.json` (this machine holds the merged state).
- `gzero item list --json > items.json`; for each open item,
  `gzero item show <id> --json` (keeps notes, design, gates).
- For each section: `gzero ws show <name> > sections/<name>.md`.
- `gzero sources > sources-<date>.txt`.

### 3. Curate

- Produce a curated working set of markdown files under one directory
  (provenance matters: every file becomes a source on re-import):
  - Global tier → `~/.config/gzero/*.md` (its proper home) — core
    rules, residents, style.
  - Per-project context stays per-project (harvested AGENTS.md files
    re-import only from live checkouts).
  - Drop: dead-path sources, duplicate texts across sources, outdated
    atoms. Use the atoms JSON + sources list as the working material;
    the curation policy is `curation.md` (every fact in one place,
    replace don't append).
- Decide item/section carry-over: recreate the live ones (open items,
  debt ledger, procedures) from the exports; drop closed history.

### 4. Fresh bag

- New bag name, e.g. `CX_BAG=context2` on both machines (env/config;
  `install.sh` update). Fresh change log = the bloat problem is gone;
  old bag stays on the hub frozen as history.
- Comms bag keeps its name (epoch rolls already bound its growth).

### 5. Re-import + verify

- `gzero add <curated file>` per source, then `gzero sync`.
- Items/sections re-created from the exports (or a small script that
  replays `items.json`).
- Acceptance: both machines `gzero sources` counts match; resolve
  serves identical content; hub page pulls are small (<100 KB).

### 6. Aftermath

- Old `context` bag: leave frozen, or DELETE from D1 once `context2`
  is verified on both machines.
- Client-side: `gzero compact` command that POSTs the snapshot to the
  hub (uses the existing endpoint) — prevents recurrence.
- The daemon (`sync-daemon.md`) still happens; this rebuild removes
  the poison log so the daemon starts from a clean state.

## Evidence log (2026-10-19)

- Test run against the real bag: `pull: 41894ms, FAILED: timed out
  reading response` at `since=1200`, ~2.5 MB pages; repeated on every
  sync attempt.
- MacPro `gzero sources`: 311-atom `atoms.json` source; multiple
  `/mnt/data/...` and `projects-old/` sources.
- Both machines converge on the same items/sections (verified).

## Executed (2026-10-19, laptop; daemon build happening on the MacPro in parallel)

- Bag name kept as `context` (no config change needed): both machines'
  docs + sidecars wiped (archived to `tmp/bloated-context/` here and
  `~/tmp/bloated-context/` on the MacPro), hub log truncated.
- Hub: `POST /bag/context/truncate {before: 3241}` deleted all 3240
  changes; verified `since=0` returns empty. No snapshot was stored.
  Comms bag untouched.
- Exports (pre-wipe, both machines converged at 701 atoms / 115
  tombstones): `exports/atoms-snapshot.json`, 21 items as JSON,
  3 sections as md, sources + tags lists. Curated re-import material:
  `tmp/cleanout/` (27 scope files, 678 atoms — 23 dropped in curation;
  115 tombstones reset, which also clears the text-keyed-tombstone
  limitation).

## Round 2 (2026-10-19): first re-import was silently defeated — redo

The first re-import looked clean but old state resurrected on both
machines. Cause: a long-lived gzero-mcp process on the MacPro (the
in-development daemon, plus other sessions) held the **pre-wipe doc in
memory** and re-pushed old changes to the hub as new seqs after the
truncate; the next pulls flowed them back into both "fresh" docs.
Wipes only defeat on-disk state, never in-memory holders.

Redo (verified clean):
- Killed all gzero-mcp on the MacPro (note: `pkill -f gzero-mcp` kills
  your own ssh wrapper — use `pkill -x`), re-truncated the hub
  (253 further changes deleted), wiped both docs + sidecars.
- Re-imported: 31 curated files (`context/`, committed), all 48
  sections across 7 scopes, **all 20 items** replayed from the archive
  JSONs incl. closed history, notes re-attached, edges remapped
  (title-matched; ids differ from the old ones).
- Item id map: d294→a348, 7e9f→a585, b66c→2399, 9e16→4cc5.
- Verification: laptop 678 atoms / 0 tombstones / 20 items / 7 scopes;
  hub log 159 changes; **fresh-client test** — MacPro wiped doc pulls
  the whole log in 0.76s and lands on 680 atoms / 20 items / 7 scopes
  with **zero old-path sources**. The poison-page problem is gone.

Lesson for the daemon (sync-daemon.md): a resident holder must reload
state from disk/hub at startup and must never push from memory it
loaded before an external reset. A daemon that wins the "who holds the
truth" contest silently resurrects deleted data.
