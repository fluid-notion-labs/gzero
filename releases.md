# gzero releases

Live copy: the gzero store's workflow section `docs.releases` (updates with the store, no commit needed). This file mirrors it at the landed main tip — update both when a release lands.

# Installing & updating (full guide)

## Existing machine — update (one command, idempotent)

```sh
cd <your gzero clone>
jj tug                      # fetch + rebase onto latest main
./install.sh                # everything below, in order
```

Then **restart pi** (or `/reload` in the running session) — the plugin
snapshot only takes effect on load. Verify:

```sh
gzero                       # untagged atoms inject
gzero ws list               # workflow sections resolve for this repo
gzero item ready            # work items
curl $CX_HUB_URL/health     # hub reachable
```

## Fresh machine — from nothing

1. **Code** (jj colocated with git):
   ```sh
   jj git clone git@github.com:fluid-notion-labs/gzero.git gzero
   cd gzero
   ```
2. **Binaries** (needs rustup):
   ```sh
   cargo build --release
   cargo install --path systems/crates/gzero   # gzero, gzero-mcp, gzero-syncd
   ```
   (or just run `./install.sh` — it builds and installs to
   `~/.local/share/gzero/bin` with symlinks in `~/.local/bin`, and removes
   stale `~/.cargo/bin` copies that would shadow them)
3. **pi plugin**: symlink the checkout into the auto-discovery path:
   ```sh
   mkdir -p ~/.pi/agent/extensions
   ln -s <clone>/systems/clients/pi-gzero ~/.pi/agent/extensions/gzero
   # package.json has no deps — recreate the pi-tui symlink only:
   mkdir -p systems/clients/pi-gzero/node_modules/@earendil-works
   ln -s ~/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-tui \
         systems/clients/pi-gzero/node_modules/@earendil-works/pi-tui
   ```
   (no npm install needed)
4. **MCP**: check `~/.pi/mcp.json` points at gzero-mcp (install.sh does this).
5. **Hub auth**: `CX_HUB_URL` + `CX_TOKEN` (token file lives at
   `~/.config/gzero/hub-token`; install.sh sets it up).
6. **The store**: with hub auth configured, a fresh machine bootstraps from
   the hub itself:
   ```sh
   gzero sync                 # pulls the full change log; state converges
   ```
   No hub access? Offline bootstrap: `gzero absorb sync/atoms.json` (atoms +
   tombstones, idempotent) and `cp sync/context.ws ~/.pi/agent/context.ws`
   — **only if no doc exists there**; if one does, ask, then reconcile by hand.
7. **Resident sync** (`gzero-syncd`): install.sh installs it as a systemd
   user unit (Linux) or LaunchAgent (macOS) — constant fan-out sync while
   you're away.

## install.sh flags

- `--no-plugin` — skip the plugin bless
- `--no-migrate` — skip migrate-db + sync (binaries/plugin only)
- `--no-daemon` — skip the resident sync service

## Troubleshooting

- `~/.local/bin` not on PATH → add it to your shell profile.
- Plugin loads but panels are broken → the pi-tui symlink (step 3) is missing.
- Store looks empty/stale → `gzero sync`; if `CX_LEGACY_DB=1` is set, the
  rollback hatch is hiding the doc store — unset it.
- Store content seems missing after a repo rename → sections are scoped by
  repo identity; see the scope-migration note in release notes.
- jj/git colocated: git HEAD is detached by design; end sessions with
  describe/commit + push + bookmarks exported.

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
