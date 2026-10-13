#!/bin/sh
# Point the live personal extension at ~/.pi/agent/extensions/contextual
# to THIS checkout's plugin — as a symlink, not a copy.
#
# A symlink means every pi session (plain or via tools/run-pi) reads the
# same files: edits in the checkout are picked up by `/reload` with no
# re-bless step. Historically this was a symlink, then a copied snapshot
# to decouple pi from fast-moving dev; with tools/run-pi covering dev
# sessions, the symlink is back and blessing is a one-time setup.
#
# Whichever checkout the script runs from is what pi loads — point it at
# the default checkout to keep it stable across workspace work:
#
#   tools/bless-plugin.sh
#
# No node_modules needed: pi's extension loader resolves
# @earendil-works/* imports itself (jiti aliases to the host's own
# packages), so the linked checkout runs standalone.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/pi-contextual-plugin"
dest="$HOME/.pi/agent/extensions/contextual"

[ -f "$src/index.ts" ] || { echo "no plugin at $src" >&2; exit 1; }

# Replace whatever is there (a previous copy or an old symlink).
if [ -L "$dest" ] || [ -e "$dest" ]; then
  rm -rf "$dest"
fi
mkdir -p "$(dirname "$dest")"
ln -s "$src" "$dest"

echo "linked $src"
echo "     -> $dest"
echo "pi picks up edits via /reload; no re-bless needed"
