#!/bin/sh
# syncd acceptance: constant, live, fan-out (research/sync-daemon.md).
#
# Starts `wrangler dev` (local hub), then:
#
#   A (one-shot MCP) adds an atom        -> pushed by its write sync
#   B runs gzero-syncd                   -> sees it within ~2s (SSE path,
#                                           backstop stays at 60s so the
#                                           assertion proves the push event)
#   A adds a second atom                 -> B's daemon is kill -9'd first,
#                                           restarted after: boot sync must
#                                           converge, nothing lost
#
# Requires the gzero-hub checkout as a sibling of this repo (or set
# HUB_DIR), and `cargo` + `wrangler` on PATH.
#
#   scripts/syncd-convergence-test.sh
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
hub="${HUB_DIR:-}"
if [ -z "$hub" ]; then
  d="$root"
  while [ "$d" != "/" ]; do
    [ -d "$d/gzero-hub" ] && { hub="$d/gzero-hub"; break; }
    d="$(dirname "$d")"
  done
fi
port="${HUB_TEST_PORT:-8799}"
token="token"
bag="${CX_BAG_TEST:-syncd-convergence-test}"

[ -d "$hub" ] || { echo "gzero-hub repo not found at $hub (set HUB_DIR)" >&2; exit 1; }

echo "building gzero-syncd and gzero-mcp..."
cargo build --bin gzero-syncd --bin gzero-mcp
daemon="$root/target/debug/gzero-syncd"
mcp="$root/target/debug/gzero-mcp"

ts="$(date +%s)"
atom1="syncd-live-$ts"
atom2="syncd-restart-$ts"
tmp="$(mktemp -d)"
trap 'kill -9 $bpid 2>/dev/null; kill $wpid 2>/dev/null; wait $wpid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM

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

envA="CX_WS_DB=$tmp/a.ws CX_BAG=$bag CX_HUB_URL=http://127.0.0.1:$port CX_TOKEN=$token"
envB="CX_WS_DB=$tmp/b.ws CX_BAG=$bag CX_HUB_URL=http://127.0.0.1:$port CX_TOKEN=$token"

# B's daemon: silent refresher — B never writes; everything it gets
# must come over the wire.
echo "starting gzero-syncd for B..."
env $envB "$daemon" >"$tmp/daemon.log" 2>&1 &
bpid=$!

# Drive one MCP server: initialize, then the JSON lines on stdin.
mcp_add() { # needle
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"add\",\"arguments\":{\"text\":\"$1\"}}}"
  } | env $envA "$mcp" >/dev/null
}

# Wait until B's doc shows the needle (read-only display; no sync).
await() { # needle, seconds
  n=0
  until env $envB "$root/target/debug/gzero" 2>/dev/null | grep -q "$1"; do
    n=$((n + 1))
    [ "$n" -gt $((2 * $2)) ] && return 1
    sleep 0.5
  done
}

echo "--- live path: A writes, B must see it within ~3s (SSE) ---"
# B's own boot sync happens before A writes anything, so whatever
# shows up now came through B's SSE-triggered cycle.
mcp_add "$atom1"
if await "$atom1" 3; then
  echo "ok: $atom1 reached B without any B-side write (SSE push trigger)"
else
  echo "FAIL: $atom1 not on B within 3s" >&2
  exit 1
fi

echo "--- restart path: kill -9 mid-stream, boot sync must converge ---"
kill -9 $bpid 2>/dev/null || true
mcp_add "$atom2"
# The old daemon is dead; nothing is pulling. Restart it (boot sync +
# fresh SSE): the atom must arrive without any B-side write.
env $envB "$daemon" >"$tmp/daemon2.log" 2>&1 &
bpid=$!
if await "$atom2" 5; then
  echo "ok: $atom2 converged after daemon restart"
else
  echo "FAIL: $atom2 not on B after restart; daemon log:" >&2
  cat "$tmp/daemon2.log" >&2
  exit 1
fi

echo "ALL OK: B's sync cursor survived two pushes and a kill -9"
grep -o '"pushed_heads"' "$tmp/b.ws.sync.json" | head -1
