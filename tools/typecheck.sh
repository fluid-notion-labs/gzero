#!/bin/sh
# Typecheck a plugin without a node_modules tree: find the vendored pi
# checkout, generate a throwaway tsconfig mapping @earendil-works/* to its
# dist .d.ts files (and @types/node from the vendored tree), run tsc, and
# remove the generated file. Runtime dep resolution for tests lives in
# tests/deps.mjs. Pass the plugin directory name to check a different one
# (default: gzero-plugin).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  /*) plugin="$1" ;;
  *) plugin="$root/${1:-gzero-plugin}" ;;
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
"$tsc" --noEmit -p "$tmp"
echo "typecheck ok"
