# gzero

A persisted context system for AI agents: terse, tagged instruction
atoms plus structured workflow documents — named sections and work
items — injected into every session and synced across machines. The
replacement for AGENTS.md-style files and scattered planning docs.

Previously `contextual`, then briefly `contexture`; now `gzero` in
code and on GitHub. Historical identifier: the MCP server name
(`context`, so tools resolve as `mcp__context__*`). Binaries are
`gzero` (the CLI) and `gzero-mcp` (the MCP server).

## How it works

- **gzero-mcp** — the MCP server (served to agents as "context"). Atoms
  and workflow docs are only touched through it; the `gzero` CLI stays
  for shell use (ingest, inspection, sync).
- **Atom store** — terse instruction atoms, one rule each, tagged with
  hashtags (`#rust`, `#style`). Untagged atoms inject every session;
  tags pull the rest on demand. Since 23c0 the atoms live in the same
  automerge doc as the workflow system (`CX_WS_DB`, default
  `~/.pi/agent/context.ws`); the legacy SQLite store (`context.db`)
  is kept only as a rollback hatch (`CX_LEGACY_DB=1`).
- **Workflow docs** — an automerge document per scope holding typed,
  named sections (vision, architecture, now, decisions, checklists,
  user stories, …) and work items with priorities, blockers, gates,
  and a WIP limit; `plan_next` ranks what's ready.
- **pi plugin** — injects global + local context at session start and
  adds the gzero panel (tasks / context / skills / router / history
  / documentation), the skills picker, and session presence.
- **Teams** — named groups of collaborators, agents now and humans
  soon: scope `team/<name>` in the atom store (source `team:<name>`),
  one `## purpose` node plus a `## member/<id>` node per member
  (`kind: human|agent`, `role: …`). `gzero teams` and the `teams`
  MCP tool list them; the example team (`team/example`) seeds on
  startup and grows organically.
- **Hub sync** — a Cloudflare Worker + D1 change log carries the doc
  across machines (`gzero sync`; the doc is written per mutation, and
  sessions pull at startup). The hub is a change log, not a merge
  engine — automerge on each replica does the merging. v0 hub:
  `research/hub-v0.md`, repo `gzero-hub`.

## Install

From a checkout (also the upgrade path — pull, then run):

```sh
./install.sh
```

Or remotely, npm-style (works once the repo is public; while it's
private, install from a checkout — the script's clone step uses your
own git credentials):

```sh
curl -fsSL https://raw.githubusercontent.com/fluid-notion-labs/gzero/main/install.sh | sh
```

Idempotent; safe to re-run. It locates or clones the repo
(`GZERO_DIR`, default `~/projects/explorations/nursery/gzero`),
cargo-installs the `gzero` and `gzero-mcp` binaries, blesses the pi
plugin, checks `mcp.json`, sets up hub auth (`CX_HUB_URL`/`CX_TOKEN`,
token file `~/.config/gzero/hub-token`), migrates legacy SQLite atoms
into the automerge doc (`gzero migrate-db`), and syncs through the
hub. `--no-plugin` and `--no-migrate` narrow the run.

## Status

- Shipped: atom store with resolve/search and hub sync; workflow
  system W0–W4 (sections, work items, plan_next, pinned items,
  ranking with score + evidence, WIP limit, gates).
- In progress: W5 — repo docs migrate into the workflow system and
  become stubs.
- Deferred: Track D (change-based push/pull of workflow docs via the
  hub), resident track (far later).

## Repo map

- `src/` — the Rust core: atom store, workflow store, MCP server, CLI
- `gzero-plugin/` — the pi extension (blessed to
  `~/.pi/agent/extensions/gzero`; plain pi runs that snapshot)
- `sync/` — hub sync setup and exported atom snapshots
- `tools/` — skills pipeline, session tooling, dev helpers
- `packs/`, `seeds/` — generated atom packs and seed atoms
- `research/` — design docs and history; `research/old/` is archival
  and never rewritten. Live documentation lives in the workflow
  system, not here.

## Updating from contexture

gzero replaces the old `contexture` install. On each machine:

1. Pull this repo and `cargo install --path .` (bins: `gzero`,
   `gzero-mcp`).
2. Remove the old contexture plugin from your pi extensions — delete
   `~/.pi/agent/extensions/contexture` (and any other directory or
   symlink pointing at the old plugin).
3. Install the gzero plugin snapshot: run `tools/bless-plugin.sh`
   from a checkout of this repo.
4. If your `.pi/mcp.json` still points at an old `contexture` binary
   or config path, repoint it at gzero's `gzero-mcp`.

Atom stores are compatible — old contexture store data keeps working
under gzero. Cut over to the automerge doc with `gzero migrate-db`
(idempotent; the SQLite store stays untouched for rollback), then
`gzero sync` to share it through the hub. Machines that haven't cut
over keep working against the hub's legacy endpoints in the meantime.

## Development

- Rust: `cargo build`, `cargo test`
- Plugin: `npm test` and `tools/typecheck.sh` in
  `gzero-plugin/` (`tools/bless-plugin.sh` refreshes the
  snapshot after merging)
- Workflow: jj workspaces per task (`.jj/workspaces/<feature>`),
  conventional commits, merge to `main`, push
