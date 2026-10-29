#!/bin/sh
# Publish the latest built pi to a known stable place and run off it.
#
# ~/.local/bin/pi used to point INTO the vendored source tree
# (vendor/pi/packages/coding-agent/dist/bundle/cli.js), so the installed
# pi silently changed whenever that checkout was rebuilt or moved — a
# half-finished dist could become the live binary. This keeps a snapshot
# copy at ~/.local/share/pi-latest and points ~/.local/bin/pi at it.
#
#   tools/update-pi-latest.sh          # sync an existing build (fast)
#   tools/update-pi-latest.sh --build  # npm run build in vendor/pi first
#
# The bundle is self-contained; package.json must ride along because pi
# reads its VERSION (and piConfig) from the package.json next to the
# bundle — without it pi reports 0.0.0.
set -eu

PI_REPO=/mnt/data/projects/explorations/vendor/pi
SRC="$PI_REPO/packages/coding-agent/dist/bundle"
DEST="$HOME/.local/share/pi-latest"

if [ "${1:-}" = "--build" ]; then
	(cd "$PI_REPO" && npm run build)
fi

[ -f "$SRC/cli.js" ] || { echo "no bundle at $SRC — build first (--build)" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
cp "$PI_REPO/packages/coding-agent/package.json" "$DEST/package.json"
chmod +x "$DEST/cli.js"

# The bundle leaves jiti (and other externals) to runtime resolution — a
# plain npm install of pi ships node_modules next to the bundle, so the
# snapshot needs them too or loading extensions fails: "Cannot find
# module 'jiti'".
(cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

ln -sfn "$DEST/cli.js" "$HOME/.local/bin/pi"
echo "pi-latest -> $($HOME/.local/bin/pi --version)"
