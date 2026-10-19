# Session history — projects → sessions → the branch tree

*2026-10-19. Design for rebuilding the gzero panel's history section.
Today it is one linear list of user prompts scraped from every
`.jsonl` in the project's sessions folder — sessions lose their
identity, forks and branches are invisible. The model below is a tree,
and almost all of it already exists in pi's session format; the work is
mostly honest reading plus UI. Companion: `history.md` (scrubbing /
time over the store — the deeper layer this panel eventually sits
on).*

## Ground truth (what pi already records)

- **Entries are a tree.** Every session JSONL entry carries
  `{id, parentId, timestamp}`. `branch(entryId)` re-parents new work to
  an earlier entry, forming a sibling branch; `branch_summary` entries
  mark the divergence; `getTree()` returns `SessionTreeNode {entry,
  children, label}`. Nothing to invent — just stop flattening it.
- **Forks are session-level.** The session header carries
  `parentSession` (the parent session file's path) — written on resume-
  from and fork. Session lineage is a DAG of files, each internally a
  tree.
- **Projects are folders.** Sessions live under
  `~/.pi/agent/sessions/<project-slug>/`. The slug is the scope key.
- **Cross-machine visibility is the comms doc.** Presence rows
  (`sessions` map: `session_id, machine, scope, cwd, label, last_seen`)
  sync through the `comms` stream. A session file is local; its
  existence and liveness are global. Messages address `dest = session
  id` — the same id the panel will display.

## The model

Three node types, two edge families:

```
project (scope)
  └─ session (file; session_id)         — edge: folder membership
       ├─ session (fork parent)         — edge: parentSession (DAG)
       └─ entry tree (id/parentId)      — edge: in-file branches
```

- **Project** = scope (repo identity). Backed today by the sessions
  folder; tomorrow by the `project/<scope>` stream — one name, so the
  panel, the hub, and the Flutter projects list all agree.
- **Session** = one `.jsonl` file. Identity is the session id (the
  same id presence broadcasts and messages address). Fork links make
  sessions a forest, not a list.
- **History** = the entry tree *within* a session. The active branch is
  the path from the leaf to the root; siblings at any node are
  branch/fork points.

**Fork vs branch, unified.** They are different mechanisms with the
same shape: fork = new file (survives restarts, visible in the session
list), branch = new subtree in the same file. In the UI they render as
one tree: when a session has a `parentSession`, the panel splices the
parent's path *up to the fork entry* in as shared ancestry, marked with
a session-boundary glyph. The fork point is the common ancestor; the
parent's other branches stay collapsed behind it.

## What the panel becomes

Three levels, drill-down navigation replacing the flat list:

1. **Projects** — scopes that have sessions on this machine (plus
   presence-only scopes from other machines, badged, read-only).
2. **Sessions** — the project's sessions, newest first, showing: name /
   first prompt, fork parent (→), live-on-machine badge from presence,
   message count.
3. **Session history** — the entry tree: prompts along the active path
   (current behavior's content, now with real topology), branch points
   as fork glyphs, `branch_summary` text at divergence, non-prompt
   entries (tool calls, compaction, model changes) collapsed as context
   rows.

Enter still picks a prompt and inserts it into the editor — unchanged
contract from today's panel.

## Decisions this forces

1. **Canonical project identity.** The sessions-folder slug must be the
   canonical scope string (the `repo_identity` the comms presence rows
   and future `project/<scope>` streams use). Today the slug is derived
   from cwd with its own normalization — that's a silent split-brain
   waiting to happen. Decide the mapping once, in core, and have the
   plugin read it.
2. **Session content stays local; presence is the global layer.** Per
   `history.md`: session timelines replicate (if at all) as
   blob-pointer facts, never as lattice state. v1 panel shows this
   machine's content; other machines' sessions appear as roster rows
   only. Don't sneak session text into the automerge docs.
3. **Filler filtering survives**, applied per prompt entry as today —
   the tree is topology, the leaves are still cleaned prompts.
4. **Labels are already in the tree.** `SessionTreeNode.label` /
   `labelTimestamp` exist — use them for branch naming before inventing
   anything.

## Open questions

- Entry granularity in level 3: prompts-only with collapsed context
  rows (proposed), or full entry rendering? Full is a debug view; it
  probably wants to live behind an expand toggle, not be the default.
- Do forked sessions inherit the project of their parent when started
  from a different cwd (fork across projects)? The folder the file
  *lands in* decides today; confirm that's the semantics we want.
- Session pruning/GC: the panel reads every file eagerly. With trees
  this becomes "read headers + getTree lazily" — cheap, but the
  eager-load habit should die in the rewrite.
- Relationship to scrubbing (`history.md`): the entry tree is the
  timeline layer's index. When scrubbing lands, this panel is its UI
  front door — design the node ids so a future "scrub to here" is a
  pointer, not a retrofit.
