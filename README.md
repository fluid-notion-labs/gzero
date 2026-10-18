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
  tags pull the rest on demand.
- **Workflow docs** — an automerge document per scope holding typed,
  named sections (vision, architecture, now, decisions, checklists,
  user stories, …) and work items with priorities, blockers, gates,
  and a WIP limit; `plan_next` ranks what's ready.
- **pi plugin** — injects global + local context at session start and
  adds the gzero panel (tasks / context / skills / router / history
  / documentation), the skills picker, and session presence.
- **Hub sync** — a Cloudflare Worker + Durable Object carries atoms
  across machines; workflow-doc distribution is Track D (deferred).
  v0 of the hub rebuild is planned in `research/hub-v0.md` (new repo,
  automerge change log; includes the mobile client plan).

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
under gzero, so no migration of context content is needed.

## Development

- Rust: `cargo build`, `cargo test`
- Plugin: `npm test` and `tools/typecheck.sh` in
  `gzero-plugin/` (`tools/bless-plugin.sh` refreshes the
  snapshot after merging)
- Workflow: jj workspaces per task (`.jj/workspaces/<feature>`),
  conventional commits, merge to `main`, push
