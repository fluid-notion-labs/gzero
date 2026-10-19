# Context — explorations

## layout
- `nursery/` — all software: prototypes, tools, scripts, experiments. One directory per project.
- `research/` — documentation only: assays, notes, designs, findings. No buildable code.
- `vendor/` — third-party clones used as research sources (git-ignored).

## linking
- Code written into `nursery/<name>/` gets a symlink from the motivating `research/<topic>/` doc (e.g. `cargo-gpui -> ../../nursery/cargo-gpui`) plus a one-line pointer near the top: "Prototype at `nursery/<name>/`".
- Nurseries self-contained: own `Cargo.toml`/README stating what it is and which research doc it belongs to.
- Research references code through the symlink path, not `nursery/` directly.

## rationale
- Code stays buildable and isolated in nursery; graduates to its own repo without dragging research along.
- Research dirs stay greppable, publishable prose — no target dirs, no lockfiles.

## workstyle
- Workstyle: a named set of directives — how we get things done. Chat code `##workstyle.key(extra)` expands to the directive; the parenthetical is extra info for this repo. Stored at scope workstyle/<name>, node = key. Pick via ctrl-space.
## workstyle #jj
- Two-agent coordination — conflict funnel, integration postures, workspaces as the unit of attribution: `research/context/lockstep.md`. #jj
## workstyle #skill
- Directive `feat-nesting`: bookmarks nest `feat/<family>/<leaf>` (e.g. `feat/distributed/lattice`); a family integrates children-first, rebasing up the tree to `main`. #skill:jj-workspaces
- Directive `jj-workspaces`: parallel streams (tasks, agent sessions) each get their own jj workspace — `jj workspace add ../<name> -m "msg"`, always `-m` (no editor), named after the task, not the branch. #skill:jj-workspaces
- Directive `main-periodic`: finished `feat/*` work pulls into `main` periodically (rebase, then move the bookmark); `main` tracks reality, and remaining `feat/*` streams rebase onto it after each pull. #skill:jj-workspaces
