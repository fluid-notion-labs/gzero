#!/bin/sh
# tools/session.sh — per-session workspace management.
#
# Solves the collision where two pi sessions land in the same
# .jj/workspaces/<feature> and overwrite each other's edits. Each
# session gets a distinct workspace named from the feature + a short
# session id. A marker under .jj/session-fork/<name> records ownership.
#
# Usage (from the repo root or any workspace):
#   cd "$(tools/session.sh root <feature>)"
#   tools/session.sh info
#   tools/session.sh gc --dry-run
#   tools/session.sh gc --force
#
# Environment:
#   CX_SESSION_ID     uuid for the current pi session
#   CX_ALLOW_DEFAULT  set to 1 to permit use from the default checkout
set -eu

# Absolute paths of the current workspace and the shared repo root.
WORKSPACE_ROOT=""
REPO_ROOT=""

set_roots() {
    WORKSPACE_ROOT=$(jj workspace root)
    cd "$WORKSPACE_ROOT"
    if [ -d .jj/repo ]; then
        # Default checkout: the shared repo is here.
        REPO_ROOT=$WORKSPACE_ROOT
    else
        # Attached workspace: .jj/repo is a pointer to the shared repo.
        local rel
        rel=$(cat .jj/repo)
        local abs
        abs=$(readlink -f ".jj/$rel")
        REPO_ROOT=$(dirname "$(dirname "$abs")")
    fi
}

workspace_parent() { echo "$REPO_ROOT/.jj/workspaces"; }
marker_dir()       { echo "$REPO_ROOT/.jj/session-fork"; }

session_id() {
    if [ -n "${CX_SESSION_ID:-}" ]; then
        printf '%s' "$CX_SESSION_ID"
    else
        printf 'cli-%s' "$$"
    fi
}

session_short() {
    session_id | cut -c1-8
}

current_workspace_name() {
    if [ "$WORKSPACE_ROOT" = "$REPO_ROOT" ]; then
        echo "default"
        return
    fi
    basename "$WORKSPACE_ROOT"
}

# The feature a workspace is working on. Canonical workspaces are named
# <feature>; forks are <feature>-<session>[-<n>]. Strip one trailing token.
current_feature() {
    name=$(current_workspace_name)
    echo "$name" | sed -E 's/-[^-]+$//'
}

guard_default() {
    if [ "$WORKSPACE_ROOT" = "$REPO_ROOT" ]; then
        if [ "${CX_ALLOW_DEFAULT:-0}" != "1" ]; then
            echo "session.sh: refusing to operate from the default checkout" >&2
            echo "session.sh: start in a feature workspace, or set CX_ALLOW_DEFAULT=1" >&2
            exit 1
        fi
    fi
}

claim_marker() {
    name=$1
    feature=$2
    mkdir -p "$(marker_dir)"
    cat > "$(marker_dir)/$name" <<EOF
session_id=$(session_id)
workspace=$name
feature=$feature
started_at=$(date +%s)
pid=$$
EOF
}

read_marker_session() {
    marker=$1
    if [ -f "$marker" ]; then
        sed -n 's/^session_id=//p' "$marker"
    fi
}

cmd_root() {
    feature=${1:-}
    if [ -z "$feature" ]; then
        echo "session.sh: missing <feature>" >&2
        echo "usage: tools/session.sh root <feature>" >&2
        exit 1
    fi
    guard_default

    ws_parent=$(workspace_parent)
    marker=$(marker_dir)
    canonical=$feature
    canonical_root="$ws_parent/$canonical"
    canonical_marker="$marker/$canonical"

    if [ -d "$canonical_root" ]; then
        owner=$(read_marker_session "$canonical_marker")
        if [ -z "$owner" ]; then
            # Legacy/unclaimed canonical workspace: claim it for this session.
            claim_marker "$canonical" "$feature"
            echo "$canonical_root"
            return
        fi
        if [ "$owner" = "$(session_id)" ]; then
            # Already ours.
            echo "$canonical_root"
            return
        fi
        # Fork this session to a separate workspace.
        base="${canonical}-$(session_short)"
        fork=$base
        i=0
        while [ -d "$ws_parent/$fork" ]; do
            i=$((i + 1))
            fork="${base}-${i}"
        done
        jj workspace add "$ws_parent/$fork"
        claim_marker "$fork" "$feature"
        echo "$ws_parent/$fork"
        return
    fi

    # Canonical workspace does not exist yet.
    jj workspace add "$canonical_root"
    claim_marker "$canonical" "$feature"
    echo "$canonical_root"
}

cmd_info() {
    echo "session_id=$(session_id)"
    name=$(current_workspace_name)
    marker="$(marker_dir)/$name"
    if [ -f "$marker" ]; then
        feature=$(sed -n 's/^feature=//p' "$marker")
        echo "feature=$feature"
    else
        echo "feature=$(current_feature)"
    fi
    echo "workspace=$name"
    echo "root=$WORKSPACE_ROOT"
    echo "repo=$REPO_ROOT"
    if [ -f "$marker" ]; then
        echo "marker=$marker"
        sed 's/^/  /' "$marker"
    else
        echo "pid=$$"
    fi
}

workspace_clean() {
    root=$1
    # jj st prints "working copy has no changes" when clean.
    if (cd "$root" && jj st --no-pager --color=never 2>/dev/null) | grep -qi "working copy has no changes"; then
        return 0
    fi
    return 1
}

workspace_has_uncommitted() {
    root=$1
    ! workspace_clean "$root"
}

pid_alive() {
    kill -0 "$1" 2>/dev/null
}

cmd_gc() {
    dry_run=0
    force=0
    for arg in "$@"; do
        case "$arg" in
            --dry-run) dry_run=1 ;;
            --force)   force=1 ;;
            *) echo "session.sh: unknown gc option $arg" >&2; exit 1 ;;
        esac
    done

    ws_parent=$(workspace_parent)
    marker=$(marker_dir)
    if [ ! -d "$marker" ]; then
        echo "No session-fork markers."
        return 0
    fi

    deleted=0
    skipped=0
    for m in "$marker"/*; do
        [ -f "$m" ] || continue
        name=$(basename "$m")
        root="$ws_parent/$name"
        owner_pid=$(sed -n 's/^pid=//p' "$m")
        owner_session=$(sed -n 's/^session_id=//p' "$m")

        if [ "$name" = "default" ]; then
            skipped=$((skipped + 1))
            continue
        fi

        if [ "$root" = "$WORKSPACE_ROOT" ]; then
            echo "SKIP current $name"
            skipped=$((skipped + 1))
            continue
        fi

        alive=true
        if [ -n "$owner_pid" ] && ! pid_alive "$owner_pid"; then
            alive=false
        fi

        if [ "$alive" = "true" ]; then
            echo "SKIP alive $name (pid $owner_pid) session=$owner_session"
            skipped=$((skipped + 1))
            continue
        fi

        if [ -d "$root" ] && workspace_has_uncommitted "$root"; then
            echo "SKIP dirty $name session=$owner_session"
            skipped=$((skipped + 1))
            continue
        fi

        if [ "$dry_run" -eq 1 ]; then
            echo "WOULD REMOVE $name session=$owner_session"
        elif [ "$force" -eq 1 ]; then
            if jj workspace list --no-pager | awk -F: '{print $1}' | grep -qx "$name"; then
                jj workspace forget "$name" 2>/dev/null || true
            fi
            rm -rf "$root"
            rm -f "$m"
            echo "REMOVED $name"
            deleted=$((deleted + 1))
        else
            echo "WOULD REMOVE $name session=$owner_session (use --force)"
        fi
    done

    echo "gc: $deleted removed, $skipped kept"
}

cmd_install_guard() {
    hook="$REPO_ROOT/.git/hooks/pre-commit"
    mkdir -p "$(dirname "$hook")"
    cat > "$hook" <<'HOOK'
#!/bin/sh
# Installed by tools/session.sh install-guard — blocks commits from the
# default jj/git checkout unless explicitly allowed.
repo_root=$(dirname "$(git rev-parse --git-common-dir)")
worktree=$(pwd)
if [ "$worktree" = "$repo_root" ] && [ "${CX_ALLOW_DEFAULT:-0}" != "1" ]; then
    echo "session-guard: commits from the default checkout are blocked." >&2
    echo "session-guard: use a feature workspace, or rerun with CX_ALLOW_DEFAULT=1." >&2
    exit 1
fi
HOOK
    chmod +x "$hook"
    echo "installed $hook"
}

cmd_help() {
    cat <<EOF
usage: tools/session.sh <command> [<args>]

Commands:
  root <feature>     create/select the feature workspace for this session;
                   prints the absolute workspace root (use with cd)
  info               print session id, workspace, feature, pid
  gc --dry-run       list session workspaces that could be cleaned up
  gc --force         remove stale session workspaces with no uncommitted changes
  install-guard      write a git pre-commit hook that blocks default-checkout commits
  help               show this text

Env:
  CX_SESSION_ID      stable per-pi-session uuid (fallback: cli-\$\$)
  CX_ALLOW_DEFAULT   set to 1 to allow operating from the default checkout
EOF
}

main() {
    set_roots
    command=${1:-help}
    shift || true
    case "$command" in
        root|enter) cmd_root "$1" ;;
        info)       cmd_info ;;
        gc)         cmd_gc "$@" ;;
        install-guard) cmd_install_guard ;;
        help|-h|--help) cmd_help ;;
        *)          echo "session.sh: unknown command $command" >&2; cmd_help; exit 1 ;;
    esac
}

main "$@"
