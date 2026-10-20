#!/bin/sh
# 23c0 acceptance: two gzero-mcp processes converge through the hub.
#
# Starts `wrangler dev` (local hub, port 8799), then drives two MCP
# servers over stdio with distinct docs on the same bag:
#
#   A adds an atom            -> pushed by its write sync
#   B resolves the tag        -> must show it (B's startup pull)
#   B removes it              -> pushed by its write sync
#   A (fresh process) resolves-> must NOT show it (startup pull)
#
# The hub lives in this repo at systems/hub (set HUB_DIR to point at
# an external checkout instead). Requires `cargo` + `wrangler` on PATH.
#
#   scripts/mcp-convergence-test.sh
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
hub="${HUB_DIR:-$root/systems/hub}"
port="${HUB_TEST_PORT:-8799}"
token="token"
bag="${CX_BAG_TEST:-mcp-convergence-test}"

[ -d "$hub" ] || { echo "hub not found at $hub (set HUB_DIR)" >&2; exit 1; }

echo "building gzero-mcp..."
cargo build --bin gzero-mcp
bin="$root/target/debug/gzero-mcp"

ts="$(date +%s)"
atom="harness-$ts"
tmp="$(mktemp -d)"
trap 'kill $wpid 2>/dev/null; wait $wpid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM

echo "starting wrangler dev on :$port..."
cd "$hub"
wrangler dev --port "$port" >"$hub/.wrangler-dev.log" 2>&1 &
wpid=$!
i=0
while ! curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "hub did not come up; log:" >&2; tail -20 "$hub/.wrangler-dev.log" >&2; exit 1; }
  sleep 0.5
done
echo "hub up."

# Drive one MCP server: initialize, then the JSON lines on stdin;
# print the responses.
mcp() { # docdir, then lines...
  doc="$1"; shift
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    for line in "$@"; do echo "$line"; done
  } | CX_WS_DB="$doc" CX_BAG="$bag" CX_HUB_URL="http://127.0.0.1:$port" \
      CX_TOKEN="$token" CX_DB="$tmp/unused.db" "$bin"
}

add_call='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"'"$atom"' #cxtest"}}}'
resolve_call='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resolve","arguments":{"tags":"cxtest"}}}'
remove_call='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remove","arguments":{"text":"'"$atom"'"}}}'

echo "A: add $atom"
out="$(mcp "$tmp/a.ws" "$add_call")"
echo "$out" | grep -q '"added 1, removed 0"' || { echo "FAIL: A add: $out" >&2; exit 1; }

echo "B: resolve (startup pull must deliver A's atom)"
out="$(mcp "$tmp/b.ws" "$resolve_call")"
echo "$out" | grep -q "$atom" || { echo "FAIL: B resolve missing atom: $out" >&2; exit 1; }

echo "B: remove"
out="$(mcp "$tmp/b.ws" "$remove_call")"
echo "$out" | grep -q 'tombstoned 1 atom' || { echo "FAIL: B remove: $out" >&2; exit 1; }

echo "A (fresh, startup pull): resolve must be clean"
out="$(mcp "$tmp/a.ws" "$resolve_call")"
echo "$out" | grep -q "$atom" && { echo "FAIL: A still sees removed atom: $out" >&2; exit 1; }

echo "mcp-convergence-test: PASS"
