#!/bin/sh
# Track S v1 acceptance: two gzero-mcp processes exchange comms (S3/S3b)
# through the hub's per-bag change log (bag from CX_COMMS_BAG).
#
# Starts `wrangler dev` (local hub), then drives two MCP servers over
# stdio with distinct comms docs on the same comms bag:
#
#   A sends a message to session B   -> pushed by its write sync
#   B (fresh process) msg_read       -> must show A's message
#   B posts a broadcast              -> pushed by its write sync
#   A (fresh process) resolve        -> must show the broadcast
#
# Requires the gzero-hub checkout as a sibling of this repo (or set
# HUB_DIR), and `cargo` + `wrangler` on PATH.
#
#   scripts/comms-convergence-test.sh
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
hub="${HUB_DIR:-}"
if [ -z "$hub" ]; then
  # Walk up from the checkout (a jj workspace lives under .jj/workspaces).
  d="$root"
  while [ "$d" != "/" ]; do
    [ -d "$d/gzero-hub" ] && { hub="$d/gzero-hub"; break; }
    d="$(dirname "$d")"
  done
fi
port="${HUB_TEST_PORT:-8798}"
token="token"
bag="${CX_COMMS_BAG_TEST:-comms-convergence-test}"

[ -d "$hub" ] || { echo "gzero-hub repo not found at $hub (set HUB_DIR)" >&2; exit 1; }

echo "building gzero-mcp..."
cargo build --bin gzero-mcp
bin="$root/target/debug/gzero-mcp"

ts="$(date +%s)"
msg="hello-from-a-$ts"
bcast="heads-up-$ts"
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

mcp() { # lines...
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    for line in "$@"; do echo "$line"; done
  } | CX_WS_DB="$tmp/ws" CX_HUB_URL="http://127.0.0.1:$port" \
      CX_TOKEN="$token" CX_DB="$tmp/unused.db" \
      CX_COMMS_DB="$1" CX_COMMS_BAG="$bag" "$2" - 2>/dev/null
}
# session id is the second env slot: shift trick
mcp_as() { # comms_db, session_id, lines...
  db="$1"; sid="$2"; shift 2
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    for line in "$@"; do echo "$line"; done
  } | CX_WS_DB="$tmp/ws" CX_HUB_URL="http://127.0.0.1:$port" \
      CX_TOKEN="$token" CX_DB="$tmp/unused.db" \
      CX_COMMS_DB="$db" CX_COMMS_BAG="$bag" CX_SESSION_ID="$sid" "$bin" 2>/dev/null
}

send_call='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"msg_send","arguments":{"to":"comms-sess-b","text":"'"$msg"'"}}}'
read_call='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"msg_read","arguments":{}}}'
bcast_call='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"broadcast","arguments":{"text":"'"$bcast"'"}}}'
resolve_call='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"resolve","arguments":{}}}'

echo "A: msg_send -> comms-sess-b"
out="$(mcp_as "$tmp/a-comms.ws" comms-sess-a "$send_call")"
echo "$out" | grep -q "message .* sent to comms-sess-b" || { echo "FAIL: A send: $out" >&2; exit 1; }

echo "B (fresh, startup pull): msg_read must show A's message"
out="$(mcp_as "$tmp/b-comms.ws" comms-sess-b "$read_call")"
echo "$out" | grep -q "$msg" || { echo "FAIL: B read missing message: $out" >&2; exit 1; }

echo "B: broadcast"
out="$(mcp_as "$tmp/b-comms.ws" comms-sess-b "$bcast_call")"
echo "$out" | grep -q "broadcast .* posted" || { echo "FAIL: B broadcast: $out" >&2; exit 1; }

echo "A (fresh, startup pull): resolve must show B's broadcast"
out="$(mcp_as "$tmp/a-comms.ws" comms-sess-a "$resolve_call")"
echo "$out" | grep -q "$bcast" || { echo "FAIL: A resolve missing broadcast: $out" >&2; exit 1; }

# Epoch roll (GC): with the roll threshold at 1, A's next resolve sees
# two expired messages (from steps above, now past TTL after backdating
# is not possible via MCP — so instead drive the roll by volume: send
# CX_EPOCH_ROLL_THRESHOLD+1 messages, let them expire client-side? No:
# roll triggers on expired count, which needs old messages. Skip in this
# script; the unit tests cover the roll (epoch_roll_keeps_live_and_drops_expired)
# and the hub test covers truncate. The roll's hub push path is exercised
# by any roll in production.

echo "comms-convergence-test: PASS"
