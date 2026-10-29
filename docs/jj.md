# jj — the primer, and surviving git colocation

*2026-10-29. Written after a git-stash rescue wiped a day of work from the
working copy (the "alt-m weirdness" recovery). Also in the context store
(global tier + `#jj` tag) — this doc is the offline/longer version.*

## Mental model

Everything is a commit, including the working copy. `@` **is** a commit —
edit files and they auto-amend into it. No staging area, no uncommitted
state. `change_id` is stable across amends; `commit_id` changes on every
amend.

```bash
jj st                          # status (snapshots the working copy)
jj describe -m "feat: thing"   # name the @ commit
jj new                         # open the NEXT change on top
# repeat: history accumulates as you work
```

| git | jj |
|---|---|
| `git add` + `git commit` | automatic — into `@` |
| `git commit --amend` | keep editing `@` |
| `git rebase -i` | `jj rebase -r/-s <rev> -d <dest>`, then edit |
| `git cherry-pick` | `jj squash --from A --into B` |
| `git restore <paths>` | `jj restore <paths>` |
| conflicts abort the rebase | conflicts are first-class: commits carry them, resolve later (`jj resolve`) |

History is always safe to rewrite — `jj split`, squash, abandon, reorder,
all after the fact, all navigated by stable change_ids.

## Colocation: why git went weird (2026-10-29 incident)

Colocated repos have **two heads**: jj's `@` and git's HEAD. jj normally
keeps git HEAD detached (moving it on export, trailing at most one empty
commit behind `@`) and syncs the git index. Any *state-mutating* git
command (`git stash`, `git checkout`, `git reset --hard`, `git commit`)
desynchronizes the two — then each tool's auto-repair fights the other:

- a symref HEAD (a branch checked out via git) pins git to `@`'s parent,
  so git shows all of `@`'s committed work as uncommitted changes — one
  `git commit` away from duplicating history;
- jj's half-finished index export leaves files staged-as-deleted while
  present in the worktree.

**The rule: git is read-only in this repo.** `git log/diff/status` are
fine; mutations go through jj (`st/squash/new/restore/describe`), which
keeps HEAD and the index in sync as a side effect.

## Recovery recipe

If git looks haunted:

1. `jj st` — **snapshot first**, before touching anything. This is what
   preserved the day's work in `git stash@{0}` during the incident.
2. Diagnose: `git status` dirty though `jj st` shows `@` empty → HEAD is
   pinned to `@`'s parent. Staged-deleted-but-present files → index desync.
3. Re-detach HEAD onto the real work commit:
   ```bash
   git update-ref --no-deref HEAD <commit-id of the described commit>
   git reset -q          # re-sync the index (worktree untouched)
   ```
4. Verify `git status` is clean **and stays clean across a second
   `jj st`** — jj's export must not re-break the index.
5. Clean up recovery artifacts: stray branches created during the rescue
   (`jj bookmark delete <name>`), and the stash once everything is
   verified (`git stash drop`).
