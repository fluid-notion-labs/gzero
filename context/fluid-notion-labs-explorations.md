# Context — fluid-notion-labs/explorations

## compositing
- research.mbed.research.initial topic: compositing — composing rendered layers/scenes into the final frame.

## cx.local
- Do all work in a jj workspace — one workspace per session/feature.

## infinite-canvas
- research.mbed.research.initial topic: infinite canvas — unbounded pan/zoom document surface.

## notes
- Chat shorthand for dictating docs: `doc:` (alias `cx.docs:`) stores the text under the 'cx.docs' node in the global tier; longer documentation lives in workflow sections, and the dotted section name NESTS: `cx.doc.some-topic.sub-topic` means some-topic → sub-topic as parent → child in the section tree — not a flat slug; missing parents are auto-created (mkdir -p; ws_ensure creates a bare chain). Like the gk:/lk: flow.
- `sync:` — bring `nursery/` in line with the fluid-notion-labs GitHub org: pull/fetch every existing nursery clone including all branches (`git fetch --all --prune` / `jj git fetch`), then list recent org repos with `gh repo list fluid-notion-labs --json name,pushedAt,isFork,isArchived` and clone the most recently pushed own (non-fork) repos missing from nursery. Forks are not nursery material — offer them for `vendor/` instead; the r600 forks (wgpu-r600, bevy-r600) are not used on this machine; check a suspicious repo against existing ones before cloning (textural was a misnamed duplicate, retired).
- billiards dev loop: feel free to build, publish the bin to tmp/dist, and let the launcher respawn the game client autonomously during iteration — no need to ask before rebuilding/respawning; the user runs in deep iteration mode.
- billiards game window placement: the game lives on ONE dedicated GNOME workspace (not wherever the user happens to be at respawn time). Enforced by the custom GNOME Shell extension billiards-workspace@fluid-notion-labs (source: nursery/billiards/gnome-extension/): any window titled 'billiards*' is moved to the workspace index pinned in ~/.config/billiards/workspace; if that file is absent, the window's current workspace gets pinned on first sighting. Re-pin = edit or delete the file. Note: the launcher exits when its client exits cleanly, and GNOME's window-introspection D-Bus API is permission-denied; the extension needed one logout/login to load (GNOME 50 scans extensions at session start only).
- gzero is a persistent store of terse, tagged instruction atoms that replaces AGENTS.md-style files, injected into every session and synced across machines via hub sync.
- jj workspaces are the feature workflow: one workspace per feature at `.jj/workspaces/<feat>` (jj skips .jj dirs in snapshots, so no ignore needed); gzero resolves a local context tier for the active workspace — detection via `jj workspace list` longest-prefix match on cwd, scope id `<repo-id>/ws/<feat>`.
## notes #ably-automation #awesome-claude-skills
- prerequisites: Rube MCP must be connected (RUBE_SEARCH_TOOLS available); active Ably connection via RUBE_MANAGE_CONNECTIONS with toolkit ably
## notes #bevy #r600
- billiards-rs runs on the HD 5770 via [patch.crates-io] with fluid-notion-labs/bevy-r600 (branch r600-0.19.1) + wgpu-r600 (r600-29.0.4) — same setup as scene-mcp bevy-viewer and seaview feat/amd-radeon-r600; WGPU_BACKEND=gl, no Vulkan on r600, LIBGL_ALWAYS_SOFTWARE must stay unset.
## notes #billiards #git
- billiards-rs git workflow: commit fixes and features to the repo's default branch (master) first, then rebase feat/* branches (e.g. feat/amd-radeon-r600) on top of it. Feature branches hold only their stack awaiting a merge call, never accumulate side fixes.
## notes #cloudflare #llm #workers-ai
- Workers AI open-weight model landscape assayed at research/workers-ai-models/index.md (2026-10-13): glm-5.3-flash is the catalog's price-performance frontier (only 1M ctx + vision + FC + tunable reasoning under $0.50/M out); nearest rivals are deepseek-v4-flash (1M ctx, no vision, 3x output cost), gpt-oss-120b (cheap but 128k text-only), gemma-4-26b (cheapest multimodal). Catalog rotates often — re-scrape before acting.
## notes #gzero-mcp
- gzero-mcp arg shapes (codemode): `search` takes `text`, not `query`; `resolve` takes `tags` as a string, not an array. On any MCP tool validation error, capture the required shape from the error message and add a fix note to global context.
## notes #gzero
## notes #gzero #mcp #planning #rust #stretchtext
- stretchserve is feature-complete for the core idea: block-level growth shipped (long forms spanning paragraphs/lists/fences when top-level, placement-validated). Remaining: vendored mermaid/viz for offline serving, Rust port of the scanner (would be the first stretchtext crate).
## notes #npm #repair
- Never run npm install/ci with a prefix whose node_modules contains symlinks into another install: npm prunes extraneous entries by realpath and deletes the other install's packages. Recovery: the pi managed release keeps package.json + package-lock.json in releases/<version>/, so `npm ci` in that directory restores node_modules exactly (verified against metadata.json packages).

## render-to-texture
- research.mbed.research.initial topic: render to texture — offscreen rendering pipeline for terminal/canvas output.

## subprocess-spawning
- research.mbed.research.initial topic: subprocess spawning — how processes are spawned and managed for the terminal environment.

## terminal-shell
- research.mbed.research.initial topic: terminal shell — shell integration and terminal emulation layer.

## title
- mbed is the working title of the terminal-environment project: a bevy app where terminal panes are rendered to textures and composited in the scene. Prototype at nursery/mbed (branch feat/bevy-amd-radeon-r600 = full prototype incl. the r600 fork setup; main = clean crates.io reference). Research docs at research/mbed/ (symlinked to the nursery).
