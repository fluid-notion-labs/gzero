# contextual pi plugin

pi extension that connects the context system to pi sessions. Speaks to
contextual only via MCP — no direct SQLite or hub access.

- registers `cx-mcp` so the model gets the `mcp__context__*` tools
- injects the resolved default context (global + project tiers) into the
  system prompt on every turn
- `/context` shows ground truth — exactly what is injected into the
  system prompt this session: the `<context>` block (global + project
  tier defaults) and the `<skills>` block (session-loaded skills).
  It renders as a tabbed document: top-level tier menu bar (global /
  local / skills), and below
  it a flat scrollable document where each section opens with a
  horizontal divider carrying its title. Keys: ←→ switch tiers, ↑↓
  scroll line-wise, pgup/pgdn page-wise, ctrl+↓/ctrl+↑ jump
  sections, esc/q close. Note the skillbag is *not* sent to the model —
  its atoms load only when a tag is pulled or a skill is
  referenced/loaded. The injection refreshes itself: the cache is
  stamped with the bag file's mtime, so any change — the model's
  `add`/`remove` calls, `/context add`, `cx` in a shell, another
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
  Skill sources: `$CX_SKILLS_DIRS` (colon-separated), or the contextual
  repo's `vendor/` next to this plugin / at the known checkout path, or
  any `vendor/` above the working directory
- `#` in the composer autocompletes skills (tab/enter) like `@` does for
  files: type `#` then part of a name, pick one, and the referenced
  skill's full text is injected into the turn's system prompt
  (`<skills>` section) as `#skill:<name>`. Referencing also feeds the
  skillbag: a skill not yet in the bag is distilled (summary + section
  highlights, same style as `tools/skills/pull.py`) and added via
  `cx-mcp add` with `skills/<vendor>` scope, tagged `#<name>` and
  `#<vendor>`, so its terse atoms persist across sessions. Re-adding is
  idempotent (bag dedupes by text); explicitly removed atoms stay
  removed (tombstones). Plain hashtags still type normally — just keep
  typing past the popup. Skill discovery is precached on session start
- `Ctrl+W` or `/workflow` opens the context panel: a flat horizontal
  tab bar with one tab per thing — `tasks` (the work-item tree) first,
  then one tab per workspace section in `cx ws list` order
  (architecture, user-stories, …). The panel keeps a fixed shape: the
  body area is always the full viewport height, and the footer's left
  corner holds a scroll indicator (accent-colored ↓ when there's more
  content below, ↑ when content sits above). tab/shift+tab (or ←→)
  cycle tabs, ↑↓/j/k scroll, pgup/pgdn page, home/end (and g/G) jump,
  esc/q (or ctrl+c) closes. When the strip doesn't fit the width it
  slides — a window of tabs centered on the active one, `‹`/`›` marking
  hidden tabs
- `/tasks` toggles the tasks sidebar (alias `/items`): a
  non-capturing overlay anchored top-right listing work items with
  status glyphs and priority, auto-hidden when empty; its header has a
  rule under the title
- warns on a stale `cx-mcp` (missing tools via `tools/list`)
- offers to install contextual on first run if `cx-mcp` is missing

- post-turn review: every turn is captured; when `CX_REVIEW_BATCH`
  (default 5) turns are pending, one forked model call — the session's
  model — reviews the batch and saves durable facts to the bag (scope
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
ln -s "$(pwd)/pi-contextual-plugin" ~/.pi/agent/extensions/contextual
```

Blessed (export a snapshot of whichever checkout you run it from —
use this once work is stable, so the live pi is decoupled from
fast-moving dev workspaces):

```sh
./tools/bless-plugin.sh   # run from the checkout to bless
```

The blessed copy is standalone: pi resolves `@earendil-works/*`
imports itself, so no node_modules is shipped.

Requires `cx` and `cx-mcp` (the plugin offers to run
`cargo install --git https://github.com/fluid-notion-labs/contextual`).
Hub sync uses `CX_HUB_URL` and `CX_TOKEN`; unset means offline.

### Dev cx-mcp override

A repo can ship its own locally built server: drop an executable at
`.pi/dev-cx-mcp` and add a `context` entry to `.pi/mcp.json` (see the
contextual repo). The plugin's own calls (`/context`, autocomplete)
prefer `<cwd>/.pi/dev-cx-mcp` when present, matching the mcp.json
override pi applies to the model's tools.

## Tests

`npm test` runs node:test over `tests/*.test.ts` — no test framework,
no node_modules: `tests/deps.mjs` (an in-thread module-resolution hook)
maps `@earendil-works/*` to the vendored pi checkout's dist builds,
found by walking up from the plugin. Typecheck with `tools/typecheck.sh`
(generates a throwaway tsconfig pointing at the vendored dist `.d.ts`
files and `@types/node`, runs tsc, cleans up).
