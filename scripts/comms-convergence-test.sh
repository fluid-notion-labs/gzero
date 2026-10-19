#!/bin/sh
# Track S v1 acceptance: two gzero-mcp processes exchange comms (S3/S3b)
# through the hub's per-stream change log (stream from CX_COMMS_STREAM).
#
# Starts `wrangler dev` (local hub), then drives two MCP servers over
# stdio with distinct comms docs on the same comms stream:
#
#   A sends a message to session B   -> pushed by its write sync
#   B (fresh process) msg_read       -> must show A's message
#   B posts a broadcast              -> pushed by its write sync
#   A (fresh process) resolve        -> must show the broadcast
#   live: B's gzero-syncd running; A sends -> B's doc has it in ~2s
#         (SSE wake; B's reads are one-shot/local so only the daemon
#         can have delivered it)
#   offline: hub down, A sends (queues locally), hub back, A sends
#         again -> the queued message rides the next write's push and
#         B receives both
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
# Unique stream per run: wrangler dev persists its D1 state in
# gzero-hub/.wrangler, so a reused stream name carries stale messages
# from previous runs into the assertions.
bag="${CX_COMMS_STREAM_TEST:-comms-convergence-test-$(date +%s)}"

[ -d "$hub" ] || { echo "gzero-hub repo not found at $hub (set HUB_DIR)" >&2; exit 1; }

echo "building gzero-mcp and gzero-syncd..."
cargo build --bin gzero-mcp --bin gzero-syncd
bin="$root/target/debug/gzero-mcp"
daemon="$root/target/debug/gzero-syncd"

ts="$(date +%s)"
msg="hello-from-a-$ts"
bcast="heads-up-$ts"
live="live-delivery-$ts"
offline1="offline-queued-$ts"
offline2="offline-retry-$ts"
tmp="$(mktemp -d)"
# No `wait` in the trap: wrangler's children can outlive the kill and
# hang the exit (seen as a timeout-kill after a successful PASS).
trap 'kill $wpid $dpid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM

start_hub() { # starts (or restarts) wrangler dev, waits for health
  wrangler dev --port "$port" >"$hub/.wrangler-dev.log" 2>&1 &
  wpid=$!
  i=0
  while ! curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "hub did not come up; log:" >&2; tail -20 "$hub/.wrangler-dev.log" >&2; exit 1; }
    sleep 0.5
  done
}

echo "starting wrangler dev on :$port..."
cd "$hub"
start_hub
echo "hub up."

# B's daemon: silent refresher for B's comms doc. B's own reads in the
# live and offline legs are one-shot (CX_ONE_SHOT=1, local-only), so
# anything that shows up there was delivered by this daemon.
env CX_WS_DB="$tmp/ws" CX_HUB_URL="http://127.0.0.1:$port" CX_TOKEN="$token" \
  CX_DB="$tmp/unused.db" CX_COMMS_DB="$tmp/b-comms.ws" CX_COMMS_STREAM="$bag" \
  "$daemon" >"$tmp/daemon.log" 2>&1 &
dpid=$!

# Poll a one-shot B msg_read until the given text appears (the daemon's
# delivery), or fail after the budget. The offline budget is generous:
# delivery there legitimately rides the daemon's SSE reconnect backoff
# (2/4/8s) after the hub outage.
await_delivery() { # needle, label, [budget_polls]
  i=0
  limit="${3:-24}"
  while :; do
    out="$(CX_ONE_SHOT=1 mcp_as "$tmp/b-comms.ws" comms-sess-b "$read_call")"
    echo "$out" | grep -q "$1" && { echo "ok: $2 delivered"; return 0; }
    i=$((i + 1))
    [ "$i" -gt "$limit" ] && { echo "FAIL: $2 never delivered; daemon log:" >&2; tail -10 "$tmp/daemon.log" >&2; exit 1; }
    sleep 0.5
  done
}

mcp() { # lines...
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    for line in "$@"; do echo "$line"; done
  } | CX_WS_DB="$tmp/ws" CX_HUB_URL="http://127.0.0.1:$port" \
      CX_TOKEN="$token" CX_DB="$tmp/unused.db" \
      CX_COMMS_DB="$1" CX_COMMS_STREAM="$bag" "$2" - 2>/dev/null
}
# session id is the second env slot: shift trick
mcp_as() { # comms_db, session_id, lines...
  db="$1"; sid="$2"; shift 2
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'
    for line in "$@"; do echo "$line"; done
  } | CX_WS_DB="$tmp/ws" CX_HUB_URL="http://127.0.0.1:$port" \
      CX_TOKEN="$token" CX_DB="$tmp/unused.db" \
      CX_COMMS_DB="$db" CX_COMMS_STREAM="$bag" CX_SESSION_ID="$sid" "$bin" 2>/dev/null
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

# --- live delivery: the daemon path (what actually happens across
# machines in production — the sender's session is gone by the time the
# recipient looks) ---
echo "live: A sends while B's daemon is watching"
live_call='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"msg_send","arguments":{"to":"comms-sess-b","text":"'"$live"'"}}}'
out="$(mcp_as "$tmp/a-comms.ws" comms-sess-a "$live_call")"
echo "$out" | grep -q "message .* sent" || { echo "FAIL: A live send: $out" >&2; exit 1; }
await_delivery "$live" "live message"

# --- offline: hub unreachable at send time; the message queues
# locally and rides the next write's push ---
echo "offline: stopping hub, A sends (must queue locally)"
kill "$wpid" 2>/dev/null || true
sleep 1
off1_call='{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"msg_send","arguments":{"to":"comms-sess-b","text":"'"$offline1"'"}}}'
out="$(mcp_as "$tmp/a-comms.ws" comms-sess-a "$off1_call")"
echo "$out" | grep -q "message .* sent" || { echo "FAIL: A offline send: $out" >&2; exit 1; }
echo "offline: message queued. Restarting hub; A sends again"
start_hub
off2_call='{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"msg_send","arguments":{"to":"comms-sess-b","text":"'"$offline2"'"}}}'
out="$(mcp_as "$tmp/a-comms.ws" comms-sess-a "$off2_call")"
echo "$out" | grep -q "message .* sent" || { echo "FAIL: A retry send: $out" >&2; exit 1; }
# Both arrive: the retry's write push carries the queued message's
# changes too (push cursor is local — nothing was uploaded while down).
# Poll msg_read and ACCUMULATE: it marks what it shows read, so each
# delivered message appears exactly once across polls — grep the
# accumulated text for both at the end.
seen=""
i=0
while :; do
  seen="$seen
$(CX_ONE_SHOT=1 mcp_as "$tmp/b-comms.ws" comms-sess-b "$read_call")"
  if echo "$seen" | grep -q "$offline1" && echo "$seen" | grep -q "$offline2"; then
    echo "ok: offline delivery asserted via msg_read"
    break
  fi
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "FAIL: offline messages never delivered; daemon log:" >&2; tail -10 "$tmp/daemon.log" >&2; exit 1; }
  sleep 0.5
done

# Epoch roll (GC): with the roll threshold at 1, A's next resolve sees
# two expired messages (from steps above, now past TTL after backdating
# is not possible via MCP — so instead drive the roll by volume: send
# CX_EPOCH_ROLL_THRESHOLD+1 messages, let them expire client-side? No:
# roll triggers on expired count, which needs old messages. Skip in this
# script; the unit tests cover the roll (epoch_roll_keeps_live_and_drops_expired)
# and the hub test covers truncate. The roll's hub push path is exercised
# by any roll in production.

echo "comms-convergence-test: PASS"
