# skills/jj-skills

## jj-workflow

- Guides Claude on using Jujutsu (jj) version control system. #jj #vcs
- minimal-output: Every read command MUST be bounded and summary-level. #jj #vcs
- sandbox: Jujutsu can be configured to sign commits (can be checked with jj config list --include-overridden | grep -i sign). #jj #vcs

## jj-workspaces

- Guides Claude on jj workspaces — multiple working directories backed by one repository, without branch locking (git calls the same idea worktrees). #jj #vcs
- minimal-output: jj workspace list is small; print it whole when asked.; Inspect a workspace's state through its log line in jj log, not by cd-ing around. #jj #vcs
- naming: The name defaults to the destination directory's basename: ../feature becomes workspace feature. #jj #vcs

## jj-cleanup

- Removes the local jj bookmarks, revisions, and workspaces left behind by merged or closed GitHub pull requests #jj #vcs
- prerequisite-binary-plus-aliases: If jj cleanup or jj cl report an unknown alias, or jj-cleanup is not on PATH, the tool is not installed. #jj #vcs
- workflow: jj cleanup runs a fetch before planning unless --no-fetch is passed. #jj #vcs
- why-a-bookmark-is-kept: A bookmark is a candidate only when it has at least one associated pull request, none of those pull requests is open #jj #vcs
- locks: jj cleanup lock <bookmark>... #jj #vcs
- workspaces: Workspaces participate by default. #jj #vcs

## jj-create-pr

- Creates GitHub pull requests from Jujutsu changes with AI-generated descriptions. #jj #vcs #github
- permission-requirements: CRITICAL: This workflow requires jj and gh CLI access with authentication. #jj #vcs #github
- complete-example: User: "Create a PR for @-" #jj #vcs #github

## jj-update-pr

- Updates existing GitHub pull request descriptions with AI-generated content based on the current diff. #jj #vcs #github
- permission-requirements: CRITICAL: This workflow requires jj and gh CLI access with authentication. #jj #vcs #github
- complete-example: User: "Update the PR for @-" #jj #vcs #github

## jj-gh-stack

- Manages GitHub stacked PRs from a Jujutsu (jj) repository with the gh stack CLI. #jj #vcs #github
- model: One layer = one mutable jj commit on top of trunk plus one bookmark per layer #jj #vcs #github
- bookmark-list-in-stack-order: link needs bottom-to-top. #jj #vcs #github
