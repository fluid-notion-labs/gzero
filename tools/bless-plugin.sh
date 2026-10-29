#!/bin/sh
# Bless a snapshot of the plugin as the live personal extension at
# ~/.pi/agent/extensions/gzero — a copy, not a link.
#
# Blessing always takes a COMMITTED revision, never a working copy, so
# the blessed snapshot is always a "current stable" state — WIP that
# only exists in a checkout's editor can't sneak into plain `pi`
# sessions.
#
#   tools/bless-plugin.sh          # bless from main (the stable line)
#   tools/bless-plugin.sh <rev>    # bless from any committed change
#                                  # (change-id prefix, bookmark, commit id)
#
# Plain `pi` sessions run the blessed snapshot and never see work-in-
# progress; the snapshot only changes when this script runs. For
# iterating on the plugin, use tools/run-pi, which loads the checkout
# copy directly (and, from a workspace, against the shared release
# gzero-mcp).
#
# No node_modules needed for the @earendil-works/* imports: pi's
# extension loader resolves those itself (jiti aliases to the host's
# own packages). LanceDB/fastembed/arrow (the recall engine) DO need a
# node_modules tree — installed fresh in the snapshot below.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
rev="${1:-main}"

# Resolve to a git commit id (works for bookmarks, change-ids, prefixes;
# jj keeps every visible commit's objects in the colocated git repo).
sha="$(jj -R "$root" log -r "$rev" --no-graph --no-pager -T 'commit_id')"
desc="$(jj -R "$root" log -r "$rev" --no-graph --no-pager -T \
  'description.first_line().trim_end() ++ "\n"' | head -1)"
[ -n "$desc" ] || desc="(no description)"

[ -f "$root/systems/clients/pi-gzero/index.ts" ] || { echo "no plugin at $root/systems/clients/pi-gzero" >&2; exit 1; }

# Materialize the committed tree into a temp dir.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$root" archive "$sha" systems/clients/pi-gzero | tar -x -C "$tmp"
src="$tmp/systems/clients/pi-gzero"
[ -f "$src/index.ts" ] || { echo "rev $rev ($sha) has no plugin snapshot" >&2; exit 1; }

dest="$HOME/.pi/agent/extensions/gzero"

# Replace whatever is there (a previous copy or an old symlink).
if [ -L "$dest" ] || [ -e "$dest" ]; then
  rm -rf "$dest"
fi
mkdir -p "$(dirname "$dest")" "$dest"

# The plugin is the root-level TypeScript sources plus its README and
# the router/ history/ submodules; tests and editor config are
# dev-only and stay out of the snapshot.
cp "$src"/*.ts "$src/package.json" "$src/README.md" "$dest/"
cp -R "$src/router" "$src/history" "$dest/"

# Runtime deps beyond the host-provided @earendil-/* set (the recall
# engine: LanceDB, fastembed, arrow) need a node_modules tree here —
# the source tree's own node_modules is not copied.
if grep -q '"dependencies"' "$dest/package.json"; then
  ( cd "$dest" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
    && echo "deps installed in snapshot" ) \
    || echo "WARNING: npm install failed in $dest — recall falls back to lexical-only"
fi

echo "blessed $rev -> $dest"
echo "  commit $sha: $desc"
echo "plain pi runs this copy; re-bless after merging the next stable to main"
