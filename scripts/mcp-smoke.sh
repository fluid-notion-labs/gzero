#!/bin/sh
# Smoke + timing test for gzero-mcp: drive a fixed tool-call sequence
# over stdio and report per-request wall-clock times.
#
#   scripts/mcp-smoke.sh               # with hub (isolated bag)
#   scripts/mcp-smoke.sh --offline     # no hub: pure local timings
#   SMOKE_REPEAT=3 scripts/mcp-smoke.sh
#
# Builds gzero-mcp first (SKIP_BUILD=1 to skip). The hub run never
# touches the real context bag: CX_BAG defaults to gzero-smoke-test.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [ "$1" = "--offline" ]; then
  export SMOKE_OFFLINE=1
  shift
fi

if [ -z "$SKIP_BUILD" ]; then
  echo "building gzero-mcp..." >&2
  cargo build --bin gzero-mcp
fi

exec node "$root/scripts/mcp-smoke.mjs" "$@"
