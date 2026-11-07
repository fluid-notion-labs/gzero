# gzero releases

Live copy: the gzero store's workflow section `docs.releases` (updates with the store, no commit needed). This file mirrors it at the landed main tip — update both when a release lands.

# Updating & installing a machine (user steps)

Canonical path — one command from an existing checkout (idempotent; safe after every pull):

```sh
cd <your gzero clone>
jj tug                      # fetch + rebase onto latest main
./install.sh                # builds, installs bins, blesses plugin, hub auth, migrate-db, sync, syncd
```

What install.sh does: builds & installs gzero / gzero-mcp / gzero-syncd to
~/.local/share/gzero/bin (symlinked into ~/.local/bin), blesses the pi plugin
snapshot (~/.pi/agent/extensions/gzero), checks ~/.pi/mcp.json, configures hub
auth (CX_HUB_URL / CX_TOKEN), migrates legacy SQLite atoms into the doc
(idempotent), syncs through the hub, installs gzero-syncd as a resident service.

User steps that only you can do:
1. **Restart pi** (or run /reload in the running session) after a plugin bless —
   the snapshot only takes effect on load. /reload also re-runs the extension
   factory; identity is stable across it since 34e8.
2. **Production deploys**: `wrangler secret put TOKEN` was set once; redeploys
   (`cd systems/hub && npm run deploy`) need no secret action.
3. **Fresh machine** (first install): clone, `cargo install --path
   systems/crates/gzero`, plugin symlink + pi-tui link (see sync/SETUP.md),
   then `gzero absorb sync/atoms.json` + `cp sync/context.ws` only if no doc
   exists — ask before overwriting an existing one.

Verify after update: `gzero` (untagged atoms inject), `gzero ws list`,
`gzero item ready`, hub reachability (`curl $CX_HUB_URL/health`).

# Known-good commits

- **49a5b24f** (2026-11-07, current main) — drift landed (debug_broadcasts +
  examples into systems/crates/gzero; f265 resolved; default checkout on main).
  Green: 47 hub / 218 plugin / 114 crate tests. Hub deployed (edf3a8ff) with
  comms transport B verified live. **Best full-update commit.**
- **20e4ad91** (2026-11-07) — plugin identity fix (34e8) + transport-B bar
  client + hub Inbox DO. Safe full-update commit.
- **c2f24353** (2026-11-07) — identity fix only.

# Parked-but-known-good feat branches (unmerged)

- `comms-delivery` 34ab68f2 — live SSE reconnect pull + startup refresh race fix
- `comms` 6359fe66 — epoch roll end-to-end test + threshold override
- `comms-messaging` ppwxwrut/a7fe6aa1 — cross-repo mail injects as `<session-message from='handle@label'>`
- `feat/flutter-client` 1f49cda1 — projects on the tablet via FFI
- `seed/jj-rule` 67f5e4fa — global jj-workspace rule seed
- `human-hash-ids` d7a5643a — sessions relative git-common-dir fix

# Do-not-use

- `feat/history-tree` 922f00dc — prototype, parked by decision (be36); do NOT merge
- pre-reorg drift head kmznstvk/cb46fd7d — superseded by 49a5b24f, reference only

# Release-specific notes

**49a5b24f / 20e4ad91 (comms transport B live):**
- Hub serves the Inbox DO: POST /inbox/messages, GET /inbox/<dest>/messages?since=,
  POST /inbox/<dest>/read, POST /inbox/sweep, POST /broadcast, GET
  /broadcasts?since=&session=, POST /broadcasts/seen, PUT/GET /presence. Bearer
  auth as before. Change-log endpoints unchanged.
- **Do NOT set CX_COMMS_TRANSPORT=inbox yet** — the pi plugin's bar will read
  the hub while the msg tools still write the local doc (read/write split).
  The flag flips when the rust InboxStore (64cd beat 2) lands.
- Identity fix is live: session ids survive /reload and mid-session reinstalls
  (derived from PI_SESSION_FILE). Old rotated-id inboxes stay orphaned — the
  data is in the comms doc, addressed to dead ids.
- Pre-reorg layout is gone: the crate lives at systems/crates/gzero (not root
  src/). Default checkout is on main again.
- Bless rule: tools/bless-plugin.sh after every merge to main (it blesses from
  the committed rev, main by default).
