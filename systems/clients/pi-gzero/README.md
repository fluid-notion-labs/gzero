# gzero pi plugin

pi extension that connects the context system to pi sessions. Speaks to
gzero only via MCP — no direct SQLite or hub access.

- registers `gzero-mcp` so the model gets the `mcp__context__*` tools
- injects the resolved default context (global + project tiers) into the
  system prompt on every turn
- plain `/context` shows usage; it no longer opens anything —
  `/gzero` is the panel. Note the skillbag is *not* sent to the
  model — its atoms load only when a tag is pulled or a skill is
  referenced/loaded. The injection refreshes itself: the cache is
  stamped with the store file's mtime, so any change — the model's
  `add`/`remove` calls, `/context add`, `gzero` in a shell, another
  session — is picked up on the next turn. `/context reload` forces a
  re-resolve without waiting; `/context add <text>` saves an atom with
  a confirm dialog; `/context local|global <text>` sends the raw note
  to the session model for a one-atom condense, shows the query and
  rewrite in a confirm dialog, and saves to the chosen tier (local =
  this repo's project scope, global = scope "global")
- alt-s or `/skills` opens the skills picker: type-to-search over the
  vendored `SKILL.md` files (title + description), enter reads the full
  skill in a scrollable overlay, esc backs out, and enter again in the
  detail view loads the skill for the session — its full instructions
  apply to every turn, and it distills into the skillbag on your next
  message.
  Skill source: the canonical dir `~/.pi/pi-gzero/skills`, installed
  by `tools/skills/install.py` from the vendored repos (deduped by name);
  `$CX_SKILLS_DIRS` (colon-separated) overrides
- `#` in the composer autocompletes skills (tab/enter) like `@` does for
  files: type `#` then part of a name, pick one, and the referenced
  skill's full text is injected into the turn's system prompt
  (`<skills>` section) as `#skill:<name>`. Referencing also feeds the
  skillbag: a skill not yet in the store is distilled (summary + section
  highlights, same style as `tools/skills/pull.py`) and added via
  the `add` tool with `skills/<vendor>` scope, tagged `#<name>` and
  `#<vendor>`, so its terse atoms persist across sessions. Re-adding is
  idempotent (store dedupes by text); explicitly removed atoms stay
  removed (tombstones). Plain hashtags still type normally — just keep
  typing past the popup. Skill discovery is precached on session start
- `Ctrl+Q` toggles the **task panel** (the work items sidebar,
  same as `/tasks`); the **gzero panel** opens via `/gzero`
  (`/gzero [tasks|context|skills|router|history|documentation]` opens
  directly on a section): a full-height left-tree pane with six
  sections in a top bar — `tasks` (the work-item tree with queue
  order, status transitions, priority, notes and `m` move mode),
  `context` (injection tiers), `skills` (the full catalog grouped by
  vendor, loaded skills marked ✓; enter loads an unloaded skill and
  `/` searches the catalog), `router` (work types and their blessed
  models, pinned type and last classification, the usage ledger),
  `history` (this project's prompts, newest first, fillers filtered;
  enter inserts a prompt into the editor) and `documentation` (ws
  sections as heading trees). tab/shift+tab (or ctrl+↑↓) switch
  sections with
  per-section cursor memory, ↑↓/j/k move, enter/←→ expand and open
  details, `/` searches the active section (fuzzy, with `is:open`
  / `is:closed` / `is:active` / `status:X` filters), pgup/pgdn page,
  home/end jump, esc/q/ctrl+q close. Markdown details re-flow to the
  pane width and tables render as aligned text
- **Backtick taps** also open the panel: double-tap `` opens it,
  single taps still type a literal backtick (held until the next
  keystroke, so typing code spans keeps order). `CX_PANEL_TAPS=3`
  switches the trigger to a triple tap — then double-tap types `` (an
  empty inline code span) and only a genuine triple opens; triple is
  exactly the markdown fence, so pick your clash. `CX_PANEL_TAPS=0`
  disables the interception and restores the default editor
- The **tasks strip** is always visible: a narrow bordered rail on the
  right edge, one glyph per task in timeline order — ✓ closed at top
  (past), ● in-progress, ○ open — so new tasks appear at the bottom and
  work flows upward as it completes. In-progress tasks spin (braille
  frames; the animation timer only runs while a spinner is visible).
  Blocked tasks show ⊘, overflow shows ⋮ after dropping the oldest
  rows, and an empty strip shows a quiet `·`. `/tasks` (alias
  `/items`) toggles the full **panel**: a non-capturing overlay
  anchored top-right listing work items with status glyphs and
  priority, auto-hidden when empty, with a rule under its title — the
  strip hides while the panel covers its corner. `CX_TASKS_STRIP=0`
  removes the strip and restores panel-only behavior
- The **traffic bar** is always visible: a one-line horizontal bar
  across the top row showing this session's incoming traffic — one
  ▸ entry per unread message (S3) and unseen broadcast (S3b) with a
  spinner while anything is pending, and done deliveries moving to a
  'read' queue marked ✓ (only the last 3 stay). On the right, traffic
  rates — `0.3/s · 3/10s · 8/min` — computed over sliding 1s/10s/60s
  windows from fresh arrivals only (a weekend backlog doesn't count as
  a burst), with a `⚠` + warning color above 1 msg/s. Data comes from a
  long-lived `gzero-mcp` child polling the read-only `msg_inbox` tool
  every 2s (gzero-syncd keeps the comms doc fresh between polls); the
  bar drains nothing — `msg_read` and resolve delivery stay in charge.
  `alt+m`, ctrl+m (where the terminal can tell it from enter), or
  `/messages` opens the message view panel; `CX_INBOX_BAR=0` disables
  it all.
- A **loaded-skills column** sits left of the rail: one ✦-marked skill
  name per line for every skill loaded this session. Passive display
  only — loading happens in the skills picker or the gzero panel's
  skills search; the column appears when the first skill is loaded and
  never reaches the chat area. `CX_SKILLS_STRIP=0` removes it
- warns on a stale `gzero-mcp` (missing tools via `tools/list`)
- offers to install gzero on first run if `gzero-mcp` is missing

- post-turn review: every turn is captured; when `CX_REVIEW_BATCH`
  (default 5) turns are pending, one forked model call — the session's
  model — reviews the batch and saves durable facts to gzero (scope
  global for user/environment, project for repo conventions, hashtags
  for on-demand task knowledge). "Nothing to save." is the usual reply;
  saved atoms are announced via notification. Fire-and-forget in
  interactive mode, awaited in headless. `CX_REVIEW=0` disables.
  Scope exclusions and policy: `research/context/curation.md` §5.

Spec: `research/context/pi-plugin.md` (in the explorations repo);
curation policy: `research/context/curation.md`; skills pipeline and
hub plan: `research/skills-assay.md`. Deferred: modal first-open lag
and related performance work is tracked in the implementation plan
(`plan.md` M4).

## Install

Dev (live-linked to a checkout, picks up every change on pi restart):

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/gzero
```

Blessed (export a snapshot of whichever checkout you run it from —
use this once work is stable, so the live pi is decoupled from
fast-moving dev workspaces):

```sh
./tools/bless-plugin.sh   # run from the checkout to bless
```

The blessed copy is standalone: pi resolves `@earendil-works/*`
imports itself, so no node_modules is shipped.

Requires `gzero` and `gzero-mcp` (the plugin offers to run
`cargo install --git https://github.com/fluid-notion-labs/gzero`).
Hub sync uses `CX_HUB_URL` and `CX_TOKEN`; unset means offline.

### Dev gzero-mcp override

A repo can ship its own locally built server: drop an executable at
`.pi/dev-gzero-mcp` and add a `context` entry to `.pi/mcp.json` (see the
gzero repo). The plugin's own calls (`/context`, autocomplete)
prefer `<cwd>/.pi/dev-gzero-mcp` when present, matching the mcp.json
override pi applies to the model's tools.

## Tests

`npm test` runs node:test over `tests/*.test.ts` — no test framework,
no node_modules: `tests/deps.mjs` (an in-thread module-resolution hook)
maps `@earendil-works/*` to the vendored pi checkout's dist builds,
found by walking up from the plugin. Typecheck with `tools/typecheck.sh`
(generates a throwaway tsconfig pointing at the vendored dist `.d.ts`
files and `@types/node`, runs tsc, cleans up).
