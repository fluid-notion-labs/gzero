# SETUP — getting a machine up from hacks/sync

Dirty devbox sync. This branch is an orphan (no repo code). Do everything from
a scratch dir; never base code work on this branch.

## 1. Code
```sh
jj git clone git@github.com:fluid-notion-labs/contextual.git contextual
cd contextual           # main has src/, research/, pi-contextual-plugin/
```
(this hacks/sync branch only carries context: `context.md`, `sync/`)

## 2. Build & install binaries
```sh
cargo build --release          # bins: cx, cx-mcp
cargo install --path .         # → ~/.cargo/bin/cx + cx-mcp
```
Verify: `cx tags | head`

## 3. Plugin
```sh
mkdir -p ~/.pi/agent/extensions
ln -s ~/projects/explorations/nursery/contexture/pi-contextual-plugin \
      ~/.pi/agent/extensions/contextual
# package.json has no deps — only recreate the pi-tui symlink:
# mkdir -p pi-contextual-plugin/node_modules/@earendil-works
# ln -s ~/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-tui \
#       pi-contextual-plugin/node_modules/@earendil-works/pi-tui
# ```
# (no node_modules in git; npm install is NOT needed)

## 4. Context (the store)
```sh
cx absorb sync/atoms.json            # atoms + tombstones (merge, idempotent)
cp sync/context.ws ~/.pi/agent/context.ws   # workflow doc (sections+items), fresh machine only
```
If ~/.pi/agent/context.ws already exists on this machine, do NOT cp over it —
ask, then reconcile by hand.

## 5. Verify
```sh
cx                    # untagged atoms inject below; expect the refresh-test atom
cx ws list            # vision/architecture/plan/plan-todo(13/31)/now/decisions
cx item ready
```
Restart pi; the plugin adds the workflow pane (right side), Ctrl+W sections
viewer, `/workflow` command. Typecheck plugin after edits:
`npx -y -p typescript tsc --noEmit` (run inside pi-contextual-plugin/).

## Env
- `CX_DB` default `~/.pi/agent/context.db`; `CX_WS_DB` default `~/.pi/agent/context.ws`
- VCS is jj colocated: check `.jj` at repo root.
- Rule: work item done → push its branch to remote before starting the next.
