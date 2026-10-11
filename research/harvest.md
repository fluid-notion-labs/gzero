# Harvest — organic import of agent-instruction files

*Design decision (2026-10-10 evening). Replaces the one-shot reading of
`harvest` with an organic reconciliation loop. Status: designed, not
implemented. Companion: `plan.md` (harvest feature), `architecture.md`
(sync), `curation.md` (what belongs in the bag).*

## Problem

`cx harvest` imports AGENTS.md / CLAUDE.md / GEMINI.md / .cursorrules /
.windsurrlules / .github/copilot-instructions.md as project context with
per-source sync — but it is manual. The user must remember to re-run it
after a file changes. The requirement: AGENTS.md stays in repos by default
(other agents read them), and the bag mirrors them organically — change
detection, pull in changes when detected, no ceremony.

## Design

### Session-start reconciliation (not a watcher)

`cx-mcp` already starts once per session. Add to startup: for the cwd's
repo, stat each candidate file, hash its contents, compare against the
hash recorded at last harvest, and re-harvest only changed sources. A
file that no longer exists is a change: tombstone that source's atoms.

- **Content hash, not mtime** — `touch` never triggers; any edit does.
  Hash stored per source in the ledger.
- **Cost**: ~6 stat + hash operations per session start. No daemon, no
  inotify, no watcher.
- **Mid-session changes land next session** — consistent with the frozen
  injection model (pi-plugin.md): the injected block is resolved once per
  session; a file edited mid-session (e.g. by Claude Code) is mirrored at
  the next session start. No mid-session re-pricing, no partial state.
- **The `harvest` tool stays** — it becomes the "pick up now" path for
  immediate use; the automatic path means the model never has to remember
  to call it.

### Two authoring modes (partial P4 reversal, coherent)

- **Global** (`~/.pi/agent/AGENTS.md`): stays a pointer stub. The bag is
  the only authority; no other agent reads the global file.
- **Per-repo**: AGENTS.md and friends remain real files — other agents
  (Claude Code, Cursor) depend on them — and the bag mirrors them via
  auto-harvest. **File is the authoring surface; the bag is the
  distribution surface.**

### `harvest --take` (opt-in)

For repos where the bag should be sole authority: import, then delete the
file. With deletion-as-change, the tombstone follows automatically.
Default is mirror mode — deleting files other agents depend on is a
choice, never a side effect.

### Intelligence lives in the loop, not the parser

The existing parser + per-source sync is the extraction intelligence:
structure (H2 nodes, bullets), dedupe by text, wholesale replacement on
change. What makes harvest organic is the reconciliation trigger, not
smarter parsing.

## Consequence for the hub merge rule

With file sources legitimate again, the duplicate-source bug (hub rows
duplicating file rows; PK is `(text, source)`) must be fixed on the hub
side: **hub pulls merge by text** — source becomes provenance metadata on
first import, not a second ownership domain. This restores the founding
principle (atom identity = text) while keeping per-source sync as the
authoring-file mechanism. Order of operations: merge-rule fix before the
hub token lands and multi-machine sync resumes.

## Implementation sketch

1. Ledger: per-source `content_hash` (new column or side table).
2. `cx-mcp` startup: reconcile_repo(cwd) — stat/hash/compare/re-harvest.
3. Same routine callable as `cx harvest --check` (manual trigger).
4. `cx harvest --take`: harvest then delete + tombstone via the deletion
   rule.
5. Tests: change detection (edit, touch, delete), stub protection
   (zero-bullet files still skipped), deletion tombstones.
