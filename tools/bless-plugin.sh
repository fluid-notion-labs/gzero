#!/bin/sh
# Bless a snapshot of THIS checkout's plugin as the live personal
# extension at ~/.pi/agent/extensions/gzero — a copy, not a link.
#
# Plain `pi` sessions run the blessed snapshot and never see work-in-
# progress; the snapshot only changes when this script runs (normally
# after merging to main). For iterating on the plugin, use
# tools/run-pi, which loads the checkout copy directly:
#
#   tools/bless-plugin.sh     # refresh the blessed snapshot (from main)
#   tools/run-pi              # dev: pi against the source tree
#
# Bless from the default checkout, not a workspace — the default
# checkout tracks main.
#
# No node_modules needed: pi's extension loader resolves
# @earendil-works/* imports itself (jiti aliases to the host's own
# packages), so the copied files run standalone.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/systems/clients/pi-gzero"
dest="$HOME/.pi/agent/extensions/gzero"

[ -f "$src/index.ts" ] || { echo "no plugin at $src" >&2; exit 1; }

# Replace whatever is there (a previous copy or an old symlink).
if [ -L "$dest" ] || [ -e "$dest" ]; then
  rm -rf "$dest"
fi
mkdir -p "$(dirname "$dest")"

# The plugin is the root-level TypeScript sources plus its README and
# the router/ history/ submodules; tests and editor config are
# dev-only and stay out of the snapshot.
mkdir -p "$dest"
cp "$src"/*.ts "$src/package.json" "$src/README.md" "$dest/"
rm -rf "$dest/router" "$dest/history"
cp -R "$src/router" "$src/history" "$dest/"

echo "blessed $src"
echo "      -> $dest (snapshot: $(git -C "$root" log -1 --format=%h 2>/dev/null || echo '?'))"
echo "plain pi runs this copy; re-bless after merging to main"
