# Context — fluid-notion-labs/scene-mcp

- **This repo (`scene-mcp-geo`)** — HTTP/viewer on **8789** (8787 is held by the original scene-mcp checkout's release server; geo moved here): `SCENE_API_ADDR=127.0.0.1:8789 cargo run -p scene-api`; viewer at http://127.0.0.1:8789/viewer/. MCP sessions here use `.pi/mcp.json`, which overrides the user-level server with this checkout's release `scene-mcp` and `SCENE_API_URL=http://127.0.0.1:8789/api/scene`.
- **This repo (`scene-mcp-materials`)** — HTTP/viewer on **8788**: `SCENE_API_ADDR=127.0.0.1:8788 cargo run -p scene-api`; viewer at http://127.0.0.1:8788/viewer/. MCP sessions here use `.pi/mcp.json`, which overrides the user-level server with this checkout's `scene-mcp` and `SCENE_API_URL=http://127.0.0.1:8788/api/scene`.
- **`nursery/scene-mcp-materials` (sibling checkout)** — owns **8788** (`SCENE_API_ADDR=127.0.0.1:8788`). Never push scenes to 8788 from here.
- **`nursery/scene-mcp` (sibling checkout)** — owns **8787** and the user-level `~/.pi/agent/mcp.json`. Never push scenes to 8787 from here.
## commands
- Always commit after finishing a logical unit of work (coding, documentation, etc).
- `ac:` — "add command": register a new command in this section, then commit the change. Form: `ac: <word>: <what it does>`; afterwards the command is invoked as `<word>:` in messages. E.g. `ac: log: append a dated line to docs/log.md`.
- `agents:` — add the instruction that follows to this AGENTS.md, then commit the change. E.g. `agents: always commit after finishing a logical unit of work`.
- `fv:` — fork the given repo(s) with `gh` and clone the fork into `./vendor/`, then commit the change. If `gh` is not installed, ask the user before installing it. E.g. `fv: https://github.com/Dicklesworthstone/beads_rust.git`.
- `s:` — status: check the status of this repository (git state, cursors in `features.md`, recent commits) and get up to speed on where things stand. Read-only; no commit. When the scene-mcp MCP tools are available in the session, also call `get_viewer_logs` to check what the browser viewer has been reporting and `get_viewer_photos` to see if the user uploaded reference photos (then `get_viewer_photo` to view one).
- `sv:` — shallow clone (`git clone --depth 1`) the given repo(s) into `./vendor/`, then commit the change. E.g. `sv: https://github.com/gastownhall/beads.git`.
- `vendor:` — clone the given repos (one or more URLs or local paths, space-separated) into `./vendor/`, then commit the change. Use for third-party sources kept as research references. E.g. `vendor: https://github.com/KhronosGroup/glTF ../other/repo`.

## doc-workflow
- **README.md** Status/Milestone lines track the coarse milestone position only (M0–M5); detail lives in the two docs above.
- **Research doc** (`research/scene-mcp/README.md`, parent repo): update only for decisions, not implementation progress.
- **`docs/architecture.md`** is the living description of what is built. Update it *when implementing a feature that changes* the data model, id scheme, extras mapping, tool surface, or crate layering — not after the fact. It reflects reality, never the plan.
- **`features.md`** is the feature queue. It is *append-only, check-off, move the cursor*: 1. New ideas get appended to the bottom of the Queue, one entry per feature: checkbox, sequence number, one-line description, acceptance criteria, milestone tag if it belongs to one. 2. Slots are ordered by implementation order — slot an entry into place only *before* work starts. Once the cursor passes an item, don't reorder above it. 3. Work strictly top-down from the cursor (`◀ HERE`). 4. On completion: check the box, move the cursor down, keep the entry (it becomes the record that the feature shipped).

## notes
- User's preferred model is glm-5.3-flash on Cloudflare Workers AI (nicknamed "flashg" / "Flash Gordon"): fast, nimble, Sonnet-5.5/Opus-5-class capability at $0.15/$0.50 per M tokens; user values keeping context low.
## notes #generation #meshy
- Meshy multi-image tasks accept at most 4 images and take 5–15 minutes to complete. #meshy #generation
## notes #github #orgs
- User's GitHub organization is fluid-notion-labs (nickname "fns"); personal account is nhemsley. Prime-agent repo lives at fluid-notion-labs/prime-agent.
## notes #photos #context-safety #fluid-notion-labs/scene-mcp
- Never read photo/image files directly into session context (a 1MB base64 read broke the 'scene-mcp dev' session and every model call after it). ALWAYS check file sizes first (`ls -la`, `file`, `identify`) and reason about images via metadata, hashes, or targeted small crops — not full reads.
## notes #workflow #context-economy
- Check image/screenshot file sizes (ls -lh) before viewing them in tool results; skip or downsize large images to avoid blowing out the conversation context.
