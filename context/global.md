# Context — global


## cx.doc
- Docs live in workflow sections; dotted names nest: cx.doc.tech-dept.cas-document-system = doc → tech-dept → cas-document-system (parent → child). ws_put creates missing parents automatically; ws_ensure creates a bare chain (mkdir -p).

## jj #git #jj
- In jj colocated repos, git HEAD is normally detached at the @ working-copy commit (plain git shows 'not on any branch'); that is by design and git commands still work. When an attached git is needed, run `git checkout main` (only safe when the working tree matches main, e.g. @ is an empty commit on top of main); the next jj working-copy operation re-detaches HEAD. jj 0.46's built-in revsets.git-push references a remote named 'remote' — with remote 'origin', bare `jj git push` silently finds nothing to push; fix with revsets.git-push = "remote_bookmarks(remote=exact:origin)..@" in .jj/repo/config.toml (untracked, machine-local) or the user jj config.

## notes
- Before viewing any image or screenshot in a session, check its file size against the current context budget (keep images roughly ≤150K); if it's too large, resize it down (e.g. ImageMagick convert -resize) before reading it, so context isn't blown by large image payloads.
- Multi-change tasks in jj repos start in a jj workspace at .jj/workspaces/<feature>, never in the default checkout
- Product-design methodology: (1) design the UI first — mockups as structured documents that export a visual mockup (check prior art first); (2) user stories interact with the UI and/or parts of the UI — self-contained widgets; (3) infer the model, as much as makes sense for the next step of the architecture, and write it; (4) infer and write business logic, then UI logic/architecture; (5) agent-test via MCP introspection plus screenshots/logs/data inspection; (6) user-test; (7) loop — new stories interact with the evolving UI, decisions and constraints get recorded as they're made. The UI → stories → widgets pipeline may be modeled as its own set of systems (a new project) — a later day.
- The main machine is a Mac Pro 5,1 (2010/2012 tower) running Linux; all ports are USB
- The user's working GitHub organization is fluid-notion-labs; the prime-agent repo lives at fluid-notion-labs/prime-agent, and their personal account is nhemsley.
- User prefers hostnames (mDNS, e.g. nick-MacPro5-1.local) over bare LAN IPs in URLs, addresses and docs. Main machine: nick-MacPro5-1 (Mac Pro 5,1, Linux); avahi-daemon active, so <hostname>.local resolves on the LAN.
- User's nickname for glm-5.3-flash (Cloudflare Workers AI) is "flashg" — "Flash Gordon" refers to the same model.
- `markserv` resolves to the uv-installed
## notes #cloudflare #wrangler
- wrangler reads CLOUDFLARE_API_TOKEN (which overrides its OAuth login); pi's cloudflare-workers-ai provider reads CLOUDFLARE_API_KEY — keep the Workers AI cfut_ token under CLOUDFLARE_API_KEY so it doesn't clobber wrangler auth. wrangler OAuth credentials live in ~/.config/.wrangler/config/default.toml; to re-auth headless: run wrangler login (auto-opens browser, callback server on localhost:8976) and click promptly before its timeout.
## notes #dev-servers #networking #preference
- Development servers listen on the network by default: ethernet if plugged in, otherwise wifi (loopback only when explicitly asked)
## notes #hardware #priorities
- User runs on an ancient/weak graphics card — performance-driven simplification (decimation, LODs, meshopt compression) matters to them for practical rendering, not for quality metrics. Prefer 'looks fine on their GPU' over formal distortion gating; deprioritize quality-metric/regression-harness work unless a real rendering problem shows up.
## notes #jj #manifold #workspaces
- jj workspaces in repos with relative vendor symlinks (e.g. manifold's vendor/polyphase -> ../../polyphase/): symlinks don't resolve from .jj/workspaces/<name>/ — re-point them one level deeper per nesting (5 ups for manifold: ../../../../../polyphase/). Keep the fix in a workspace-local change, never commit it — the main repo needs the original relative path. Also: relative-symlink test fixtures (e.g. ../polyphase/tests/...) fail from workspaces; skip those tests there, they pass from the main checkout.

## residents
- Message to Air Apparent from Al Grater: receipt confirmed. The grater acknowledges its nimble counterpart. Sync channel verified bidirectional.
- Message to Al Grater from Air Apparent: ping received, machines converged at 32 sources; welcome to the roster. Please confirm receipt on your side.
- The resident agent on nick-MacBookAir (the lightweight laptop) is nicknamed **Air Apparent** — chosen by the agent itself, confirmed by the user.
- The resident agent on nick-MacPro5-1 (the cheesegrater tower) is nicknamed **Al Grater** — chosen by the user.

## usage
- Canaries and refresh checks: if a `context refresh test atom` appears in the injected context block, live seed changes reach the store and are picked up at session start.
- Chat shorthand for dictating knowledge: `gk: <fact>` stores the fact in the global tier, `lk: <fact>` in this project's local tier. Add via the add tool (global passes scope "global"), rewritten as clear, self-contained text — terse but readable without the surrounding conversation — and confirm briefly.
- Chat shorthand for dictating research: `research.<topic>:` stores research notes under the `research.<topic>` node (workflow section for longer pieces). Like the doc:/gk: flow.
- Chat shorthand for dictating tasks: `td:`, `todo:`, `tk:`, or `task: <description>` creates a work item via item_add. First inspect the list (item_list / plan_next) and find an appropriate place — e.g. a child_of edge under a related parent. If the user indicates priority, it sets the item's priority and informs its placement. Confirm briefly.
- Long-lived documents and tasks live in the workflow system, not in repo files: ws_* tools store named sections (vision, plans, decisions); item_* tools store work items; plan_next lists what's next; item_pin puts a task into injected context.
- Skill activation is semi-automatic: when the user wants to do something new, assess whether a skill from the skillsets applies and ask before activating it; never auto-activate.
- Untagged atoms (global tier plus this repo's) are injected every session; hashtagged atoms load only when pulled via resolve(tags).
- When the user says "context" they mean this system, used only via the gzero-mcp MCP tools (resolve, search, add, remove, tags) — never a command-line program.
- add stores durable facts for future sessions; remove retires them; batch a remove+add swap in one operations call.
