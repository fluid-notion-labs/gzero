#!/bin/sh
# gzero installer — like `npm install`, but for your whole setup.
#
# From a checkout:   ./install.sh
# From anywhere:     curl -fsSL https://raw.githubusercontent.com/fluid-notion-labs/gzero/main/install.sh | sh
#
# What it does (idempotent; safe to re-run after pulling updates):
#   1. locate or clone this repo (GZERO_DIR, default ~/projects/gzero)
#   2. build & install the binaries (gzero, gzero-mcp) to
#      ~/.local/share/gzero/bin, symlinked into ~/.local/bin
#   3. bless the pi plugin snapshot (when pi is present)
#   4. check ~/.pi/mcp.json points at gzero-mcp
#   5. configure hub auth (CX_HUB_URL / CX_TOKEN, token file ~/.config/g/hub-token)
#   6. migrate the legacy SQLite atoms into the automerge doc (gzero migrate-db,
#      idempotent — the SQLite store is left untouched as a rollback hatch)
#   7. sync the doc through the hub (gzero sync) when hub auth is configured
#   8. install gzero-syncd as a resident service (LaunchAgent on macOS,
#      systemd user unit on Linux) — constant, live, fan-out sync
#
# Flags: --no-plugin  skip step 3
#        --no-migrate skip steps 6-7 (binaries/plugin only)
#        --no-daemon  skip step 8 (no resident sync service)
#        --help
set -eu

REPO_URL="https://github.com/fluid-notion-labs/gzero.git"
# Canonical location: ~/projects/gzero. The hub lives in-repo at
# systems/hub. Existing checkouts are found wherever they live.
default_dir="$HOME/projects/gzero"
do_plugin=1
do_migrate=1
do_daemon=1

usage() {
  cat <<'EOF'
gzero installer

  ./install.sh              # from a checkout (also the upgrade path: pull, then run)
  curl -fsSL https://raw.githubusercontent.com/fluid-notion-labs/gzero/main/install.sh | sh

Idempotent — safe to re-run. Steps: locate/clone the repo (GZERO_DIR,
default ~/projects/gzero), cargo-install the
gzero, gzero-mcp and gzero-syncd binaries, bless the pi plugin, check
mcp.json, set up hub auth (CX_HUB_URL/CX_TOKEN, token file
~/.config/gzero/hub-token), migrate legacy SQLite atoms into the
automerge doc (gzero migrate-db), sync through the hub, and install
gzero-syncd as a resident service (LaunchAgent / systemd user unit).

Flags:
  --no-plugin   skip the pi plugin bless
  --no-migrate  skip migrate-db + sync (binaries/plugin only)
  --no-daemon   skip the resident sync service install
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --no-plugin) do_plugin=0 ;;
    --no-migrate) do_migrate=0 ;;
    --no-daemon) do_daemon=0 ;;
    *) echo "install.sh: unknown flag $arg" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$1"; }
warn() { printf '    (skipped) %s\n' "$1" >&2; }

# --- 1. locate or clone the repo -------------------------------------------
repo=""
if [ -f "./Cargo.toml" ] && [ -d "./systems/clients/pi-gzero" ]; then
  repo="$(pwd)"
  say "using checkout at $repo"
elif [ -n "${GZERO_DIR:-}" ] && [ -f "$GZERO_DIR/Cargo.toml" ]; then
  repo="$GZERO_DIR"
  say "using checkout at \$GZERO_DIR"
else
  for d in "$default_dir" "$HOME/projects/explorations/nursery/gzero" "$HOME/gzero"; do
    [ -f "$d/Cargo.toml" ] && [ -d "$d/systems/clients/pi-gzero" ] && { repo="$d"; break; }
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
say "building binaries (gzero, gzero-mcp) — this compiles, takes a bit"
cargo build --release --quiet
bin_dir="$HOME/.local/share/gzero/bin"
say "installing binaries to $bin_dir (symlinks in ~/.local/bin)"
mkdir -p "$bin_dir" "$HOME/.local/bin"
cp -f target/release/gzero target/release/gzero-mcp target/release/gzero-syncd "$bin_dir/"
ln -sfn "$bin_dir/gzero" "$HOME/.local/bin/gzero"
ln -sfn "$bin_dir/gzero-mcp" "$HOME/.local/bin/gzero-mcp"
ln -sfn "$bin_dir/gzero-syncd" "$HOME/.local/bin/gzero-syncd"
[ -x "$bin_dir/gzero" ] && [ -x "$bin_dir/gzero-mcp" ] && [ -x "$bin_dir/gzero-syncd" ] \
  || { echo "install.sh: binary install failed" >&2; exit 1; }
# No cargo-installed copies left behind to shadow these.
for old in "$HOME/.cargo/bin/gzero" "$HOME/.cargo/bin/gzero-mcp"; do
  [ -e "$old" ] && rm -f "$old" && say "removed stale $old"
done
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) warn "~/.local/bin is not on PATH — add it to your shell profile" ;;
esac

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

# --- 8. resident sync daemon (gzero-syncd) -------------------------------------
# The silent refresher: pulls continuously so this machine sees remote
# writes within ~2s, even when no session is running. Sessions keep
# their push-on-write; the daemon never writes unless pulling. Safe to
# re-run: rewrites and reloads the service definition.
if [ "$do_daemon" = 1 ]; then
  if [ -z "${CX_TOKEN:-}" ] && [ -f "$token_file" ]; then
    CX_TOKEN="$(cat "$token_file")"
  fi
  if [ -z "${CX_TOKEN:-}" ]; then
    warn "gzero-syncd: no hub token — skipping service install"
  else
    case "$(uname -s)" in
      Darwin)
        plist="$HOME/Library/LaunchAgents/com.gzero.syncd.plist"
        say "installing LaunchAgent com.gzero.syncd (log: ~/Library/Logs/gzero-syncd.log)"
        mkdir -p "$(dirname "$plist")" "$HOME/Library/Logs"
        cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gzero.syncd</string>
  <key>ProgramArguments</key><array>
    <string>$bin_dir/gzero-syncd</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CX_HUB_URL</key><string>$HUB_URL</string>
    <key>CX_TOKEN</key><string>$CX_TOKEN</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/gzero-syncd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/gzero-syncd.log</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
        chmod 600 "$plist" # embeds the hub token
        launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
          || launchctl load -w "$plist"
        ;;
      Linux)
        # is-system-running exits non-zero for "degraded" (some other
        # unit failed) — that's still a working user manager for us.
        if command -v systemctl >/dev/null 2>&1 \
           && systemctl --user is-system-running 2>/dev/null \
              | grep -qE '^(running|degraded|maintenance)$'; then
          unit="$HOME/.config/systemd/user/gzero-syncd.service"
          say "installing systemd user unit gzero-syncd"
          mkdir -p "$(dirname "$unit")"
          cat > "$unit" <<EOF
[Unit]
Description=gzero resident sync daemon

[Service]
ExecStart=$bin_dir/gzero-syncd
Environment=CX_HUB_URL=$HUB_URL
Environment=CX_TOKEN=$CX_TOKEN
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
          chmod 600 "$unit" # embeds the hub token
          systemctl --user daemon-reload
          systemctl --user enable --now gzero-syncd
        else
          warn "no user systemd — run $bin_dir/gzero-syncd manually"
        fi
        ;;
      *)
        warn "gzero-syncd: unsupported OS $(uname -s)"
        ;;
    esac
  fi
fi
