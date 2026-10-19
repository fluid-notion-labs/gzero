#!/bin/sh
# D1 acceptance: two gzero replicas converge through this hub.
#
# Starts `wrangler dev` for this repo, then runs the Rust convergence
# test in the gzero repo (HUB_TEST_URL points the test at the local
# hub). Requires the gzero checkout as a sibling of this repo (or set
# GZERO_DIR), and `cargo` on PATH.
#
#   scripts/two-replica-test.sh
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
gzero="${GZERO_DIR:-$(dirname "$root")/gzero}"
port="${HUB_TEST_PORT:-8799}"
token="token"

[ -d "$gzero" ] || { echo "gzero repo not found at $gzero (set GZERO_DIR)" >&2; exit 1; }

echo "starting wrangler dev on :$port..."
wrangler dev --port "$port" >"$root/.wrangler-dev.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null' EXIT INT TERM

# Wait for /health.
i=0
while ! curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "hub did not come up; log:" >&2; tail -20 "$root/.wrangler-dev.log" >&2; exit 1; }
  sleep 0.5
done
echo "hub up."

cd "$gzero"
HUB_TEST_URL="http://127.0.0.1:$port" \
CX_TOKEN="$token" \
  cargo test --lib two_replicas -- --nocapture --test-threads=1

echo "two-replica convergence: PASS"
