#!/bin/sh
# Export the plugin in THIS checkout as the "blessed" live extension at
# ~/.pi/agent/extensions/contextual, decoupling the running pi from
# fast-moving dev (workspaces, uncommitted WIP, test fixtures).
#
# Whichever checkout the script runs from is what gets blessed — run it
# from a jj workspace to bless that workspace's state, including
# uncommitted work. Use jj diff / the log to know what you are blessing.
#
#   tools/bless-plugin.sh
#
# No node_modules needed: pi's extension loader resolves
# @earendil-works/* imports itself (jiti aliases to the host's own
# packages), so the blessed copy runs standalone.
set -e

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/pi-contextual-plugin"
dest="$HOME/.pi/agent/extensions/contextual"

[ -f "$src/index.ts" ] || { echo "no plugin at $src" >&2; exit 1; }

# Replace whatever is there (currently a symlink into the default checkout).
if [ -L "$dest" ]; then
  rm "$dest"
elif [ -d "$dest" ]; then
  rm -rf "$dest"
fi
mkdir -p "$(dirname "$dest")"

cp -R "$src" "$dest"
rm -rf "$dest/node_modules" "$dest/tests" "$dest/setup-deps.sh" \
       "$dest/package-lock.json" "$dest/tsconfig.deps.json"

echo "blessed $src"
echo "    -> $dest"
echo "restart pi (or /reload extensions) to pick it up"
