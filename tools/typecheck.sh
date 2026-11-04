#!/bin/sh
# Typecheck a plugin without a node_modules tree: find the vendored pi
# checkout, generate a throwaway tsconfig mapping @earendil-works/* to its
# dist .d.ts files (and @types/node from the vendored tree), run tsc, and
# remove the generated file. Runtime dep resolution for tests lives in
# tests/deps.mjs. Pass the plugin directory path to check a different one
# (default: systems/clients/pi-gzero).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  /*) plugin="$1" ;;
  *) plugin="$root/${1:-systems/clients/pi-gzero}" ;;
esac
pi=""
d="$root"
while [ "$d" != "/" ]; do
  if [ -d "$d/vendor/pi/packages/tui/dist" ]; then pi="$d/vendor/pi"; break; fi
  d="$(dirname "$d")"
done
[ -n "$pi" ] || { echo "vendor/pi not found above $root" >&2; exit 1; }
tsc="$pi/node_modules/.bin/tsc"
[ -x "$tsc" ] || { echo "tsc not found at $tsc" >&2; exit 1; }

tmp="$plugin/tsconfig.deps.json"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "typeRoots": ["$pi/node_modules/@types"],
    "types": ["node"],
    "paths": {
      "@earendil-works/pi-tui": ["$pi/packages/tui/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["$pi/packages/ai/dist/index.d.ts"],
      "@earendil-works/pi-coding-agent": ["$pi/packages/coding-agent/dist/index.d.ts"],
      "typebox": ["$pi/node_modules/typebox"]
    }
  }
}
EOF
# The recall engine's runtime deps (@lancedb/lancedb, apache-arrow,
# fastembed) live in the plugin's package.json but only get installed
# in blessed snapshots — a fresh checkout types them as missing
# modules. Install them into the checkout on demand (idempotent, and
# node_modules is gitignored), so a fresh clone typechecks cleanly.
if ! grep -q '"@lancedb/lancedb"' "$plugin/package.json" 2>/dev/null; then
  echo "no plugin dependencies in package.json — skipping dep install" >&2
elif [ ! -d "$plugin/node_modules/@lancedb" ]; then
  echo "installing recall-engine deps into $plugin/node_modules (first run only)" >&2
  ( cd "$plugin" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
    || echo "WARNING: npm install failed — recall.ts will report missing modules" >&2
fi

"$tsc" --noEmit -p "$tmp"
echo "typecheck ok"
