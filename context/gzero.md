# Context — gzero

## dev-gzero-mcp #mcp #pi #rust
- Repo-level dev gzero-mcp: a repo can ship executable .pi/dev-gzero-mcp plus a 'context' entry in .pi/mcp.json; pi's MCP client then uses it for the model's tools, and the plugin's internal calls prefer <cwd>/.pi/dev-gzero-mcp when present. In the gzero repo this points at target/debug/gzero-mcp (walks up out of jj workspaces to find a build; cargo build first).

## notes
- After a work item is done, push its feature branch to remote (jj git push) before starting the next one — finished work is never left local-only.
- Begin each task in a jj workspace at .jj/workspaces/<feature> — never work in the default checkout.
- Commit logical units of work, each with a conventional-commits description.
- Dev loop: plan as a work item with design, build in a jj workspace (.jj/workspaces/<feature>), commit per logical unit with the item id in the message, then bookmark main, push, jj new main in the default checkout, and close the item.
- Plugin dev plumbing: edit the plugin (systems/clients/pi-gzero) in a jj workspace; test with npm test + tools/typecheck.sh; run a dev pi via tools/run-pi (loads the checkout copy directly); plain pi runs a blessed SNAPSHOT at ~/.pi/agent/extensions/gzero — tools/bless-plugin.sh copies the plugin there and must be re-run after each merge to main.
- Rust project; #rust carries build/workflow conventions — pull via resolve(tags).
- The off-center look of the tasks strip glyphs is the terminal font's ink placement inside the cell, not a layout bug — no code fix exists.
- VCS is jj colocated with git: check for .jj at the repo root; if missing, run jj git init --colocate.
- When a feature touches the Storage/automerge layer, weigh the architectural concerns first — the goal is full distributed persistence with history. Sanctioned path: make the change work for now and record it in the 'distributed-architecture-debt' workflow section (steps, files, destination, trigger — the ledger is accumulative), or do the proper architectural change, asking the user first. Since 23c0 atoms live in the automerge doc (CX_WS_DB) synced via gzero sync; SQLite (CX_LEGACY_DB=1) is a rollback hatch slated for removal once all machines cut over.
- When architecture or plans change, update the context atoms and docs within the same work item — the context must never end up describing a system that no longer exists.
- gzero is the context system for AI agents; the GitHub repo is fluid-notion-labs/gzero.
- pi-gzero (systems/clients/pi-gzero) folds in the router and history extensions (router/, history/ submodules); the gzero panel has six sections: tasks, context, skills, router, history, documentation.

## notes #cloudflare #pi
- Workers AI's chat endpoint rejects assistant messages carrying tool_calls with content:null (pi sends null for tool-call-only turns; OpenAI allows it) — multi-turn tool loops on @cf/ models fail on request 2 with 'oneOf at /' 400. Fix: rewrite null content to "" in a before_provider_request hook (pi-router-plugin/compat.ts); subagents need the same fix, so load the extension via -e in spawned pi processes.

## notes #naming
- The name 'gzero-hub' is a working title, not final — the hub lives in-repo at systems/hub (copied 2026-10-20 from the standalone fluid-notion-labs/gzero-hub repo, which stays as archive); the name may change, don't treat it as fixed in docs.

## pi-tui-pitfalls #pi #tui #typescript
- pi-tui has NO attach() lifecycle on components — the method is never called. Components get their theme via the ui.custom factory args or the constructor (TierViewer pattern). Relying on attach() leaves theme null and render() empty: an invisible overlay that can silently capture all input and look like pi froze. Diagnosed via a pyte-driven pty repro of the real TUI.

## plugin-testing #pi #testing #typescript
- pi-gzero tests use node:test (`npm test`; Node runs .ts natively) with NO node_modules: tests/deps.mjs is an in-thread module-resolution hook mapping @earendil-works/* to the vendored pi checkout's dist builds (found by walking up). Typecheck via tools/typecheck.sh (generated throwaway tsconfig → vendored dist .d.ts + @types/node).

## skills-pipeline
- Skills pipeline: tools/skills/install.py imports the vendored repos into ~/.pi/pi-gzero/skills (deduped by name, skills.yaml priority order); the plugin's skills picker reads only that dir (CX_SKILLS_DIRS overrides) — never cwd or repo paths.
