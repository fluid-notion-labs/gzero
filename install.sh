#!/bin/sh
# gzero installer — like `npm install`, but for your whole setup.
#
# From a checkout:   ./install.sh
# From anywhere:     curl -fsSL https://raw.githubusercontent.com/fluid-notion-labs/gzero/main/install.sh | sh
#
# What it does (idempotent; safe to re-run after pulling updates):
#   1. locate or clone this repo (GZERO_DIR, default ~/projects/explorations/nursery/gzero)
#   2. build & install the binaries (gzero, gzero-mcp) via cargo
#   3. bless the pi plugin snapshot (when pi is present)
#   4. check ~/.pi/mcp.json points at gzero-mcp
#   5. configure hub auth (CX_HUB_URL / CX_TOKEN, token file ~/.config/g/hub-token)
#   6. migrate the legacy SQLite atoms into the automerge doc (gzero migrate-db,
#      idempotent — the SQLite store is left untouched as a rollback hatch)
#   7. sync the doc through the hub (gzero sync) when hub auth is configured
#
# Flags: --no-plugin  skip step 3
#        --no-migrate skip steps 6-7 (binaries/plugin only)
#        --help
set -eu

REPO_URL="https://github.com/fluid-notion-labs/gzero.git"
default_dir="$HOME/projects/explorations/nursery/gzero"
do_plugin=1
do_migrate=1

usage() {
  cat <<'EOF'
gzero installer

  ./install.sh              # from a checkout (also the upgrade path: pull, then run)
  curl -fsSL https://raw.githubusercontent.com/fluid-notion-labs/gzero/main/install.sh | sh

Idempotent — safe to re-run. Steps: locate/clone the repo (GZERO_DIR,
default ~/projects/explorations/nursery/gzero), cargo-install the
gzero and gzero-mcp binaries, bless the pi plugin, check mcp.json,
set up hub auth (CX_HUB_URL/CX_TOKEN, token file
~/.config/gzero/hub-token), migrate legacy SQLite atoms into the
automerge doc (gzero migrate-db), and sync through the hub.

Flags:
  --no-plugin   skip the pi plugin bless
  --no-migrate  skip migrate-db + sync (binaries/plugin only)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --no-plugin) do_plugin=0 ;;
    --no-migrate) do_migrate=0 ;;
    *) echo "install.sh: unknown flag $arg" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$1"; }
warn() { printf '    (skipped) %s\n' "$1" >&2; }

# --- 1. locate or clone the repo -------------------------------------------
repo=""
if [ -f "./Cargo.toml" ] && [ -d "./gzero-plugin" ]; then
  repo="$(pwd)"
  say "using checkout at $repo"
elif [ -n "${GZERO_DIR:-}" ] && [ -f "$GZERO_DIR/Cargo.toml" ]; then
  repo="$GZERO_DIR"
  say "using checkout at \$GZERO_DIR"
else
  for d in "$default_dir" "$HOME/gzero"; do
    [ -f "$d/Cargo.toml" ] && [ -d "$d/gzero-plugin" ] && { repo="$d"; break; }
  done
fi
if [ -z "$repo" ]; then
  say "cloning $REPO_URL -> $default_dir"
  mkdir -p "$(dirname "$default_dir")"
  git clone "$REPO_URL" "$default_dir"
  repo="$default_dir"
elif [ ! -f "./Cargo.toml" ] && [ -z "${GZERO_DIR:-}" ]; then
  say "using existing checkout at $repo (pull updates yourself: git -C '$repo' pull)"
fi

cd "$repo"

# --- 2. binaries ------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "install.sh: cargo not found — install Rust first: https://rustup.rs" >&2
  exit 1
fi
say "installing binaries (gzero, gzero-mcp) — this compiles, takes a bit"
cargo install --path . --quiet
command -v gzero >/dev/null && command -v gzero-mcp >/dev/null \
  || { echo "install.sh: binaries not on PATH after install (is ~/.cargo/bin on PATH?)" >&2; exit 1; }

# --- 3. pi plugin ------------------------------------------------------------
if [ "$do_plugin" = 1 ]; then
  if [ -d "$HOME/.pi" ]; then
    say "blessing the pi plugin snapshot"
    sh tools/bless-plugin.sh
  else
    warn "no ~/.pi — pi not installed; plugin step skipped"
  fi
else
  warn "--no-plugin"
fi

# --- 4. mcp.json -------------------------------------------------------------
if [ -f "$HOME/.pi/mcp.json" ]; then
  if grep -q "gzero-mcp" "$HOME/.pi/mcp.json"; then
    say "mcp.json references gzero-mcp"
  else
    warn "mcp.json does not mention gzero-mcp — repoint the old context server:"
    warn "  set its command to gzero-mcp (see README, 'Updating from contexture')"
  fi
else
  warn "no ~/.pi/mcp.json (fine if the pi plugin manages the server itself)"
fi

# --- 5. hub auth -------------------------------------------------------------
token_file="$HOME/.config/gzero/hub-token"
HUB_URL="${CX_HUB_URL:-https://gzero-hub.nick-hems.workers.dev}"
export CX_HUB_URL="$HUB_URL"
if [ ! -f "$token_file" ]; then
  if [ -n "${CX_TOKEN:-}" ]; then
    say "writing hub token from \$CX_TOKEN -> $token_file"
    mkdir -p "$(dirname "$token_file")"
    printf '%s' "$CX_TOKEN" > "$token_file"
    chmod 600 "$token_file"
  else
    warn "no hub token. Set CX_HUB_URL + CX_TOKEN (or write the token to $token_file),"
    warn "  then re-run: ./install.sh --no-plugin"
  fi
else
  say "hub token present at $token_file"
fi
if [ -f "$HOME/.bashrc" ] && ! grep -q "CX_HUB_URL" "$HOME/.bashrc" && [ -f "$token_file" ]; then
  say "adding CX_HUB_URL / CX_TOKEN exports to ~/.bashrc"
  {
    echo ''
    echo '# gzero hub'
    echo "export CX_HUB_URL=\"$HUB_URL\""
    echo 'export CX_TOKEN="$(cat '"$token_file"' 2>/dev/null)"'
  } >> "$HOME/.bashrc"
fi

# --- 6-7. migrate + sync ------------------------------------------------------
if [ "$do_migrate" = 1 ]; then
  if [ -f "$HOME/.pi/agent/context.db" ]; then
    say "migrating legacy SQLite atoms into the automerge doc (idempotent)"
    gzero migrate-db
  else
    say "no legacy SQLite store — nothing to migrate"
  fi
  # Env may not be loaded (piped run): fall back to the token file.
  if [ -f "$token_file" ] && [ -z "${CX_TOKEN:-}" ]; then
    CX_TOKEN="$(cat "$token_file")"
    export CX_TOKEN
  fi
  if [ -n "${CX_TOKEN:-}" ]; then
    say "syncing the doc through the hub ($HUB_URL)"
    gzero sync
  else
    warn "hub auth not configured — run 'gzero sync' once it is"
  fi
  say "done. 'gzero' shows your context; restart pi sessions to pick up the new server."
fi
