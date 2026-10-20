# Context — gzero-hub (systems/hub)

## notes
- The hub lives in-repo at `systems/hub/` since the 2026-10-20 repo unification — copied from `fluid-notion-labs/gzero-hub` (main 98ea350d) without history; the standalone repo stays on GitHub as archive/reference. Deploy flow unchanged: `wrangler deploy` from `systems/hub/`.
- npm project (Cloudflare Worker + DO); `#npm` carries package/workflow conventions — pull via resolve(tags).
