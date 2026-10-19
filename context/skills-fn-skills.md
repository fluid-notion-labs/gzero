# Context — skills/fn-skills

## jj-cleanup #jj #vcs
- Removes the local jj bookmarks, revisions, and workspaces left behind by merged or closed GitHub pull requests #jj #vcs
- install: If jj cleanup / jj cl report an unknown alias or jj-cleanup isn't on PATH #jj #vcs
- locks: jj cleanup lock <bookmark>... #jj #vcs
- why-a-bookmark-is-kept: A bookmark is a candidate only when: it has an associated PR, none of those PRs is open, at least one is in the requested state #jj #vcs
- workflow: jj cleanup fetches before planning unless --no-fetch. #jj #vcs
- workspaces: Cleaned only when: clean, not the primary workspace, not the one running cleanup, holds a candidate's revisions #jj #vcs

## jj-create-pr #github #jj #vcs
- Creates GitHub pull requests from Jujutsu changes with AI-generated descriptions. #jj #vcs #github

## jj-gh-stack #github #jj #vcs
- Manages GitHub stacked PRs from a Jujutsu (jj) repository with the gh stack CLI. #jj #vcs #github
- model: One layer = one mutable jj commit on trunk + one bookmark per layer.; gh stack link a b c takes branches bottom to top, positionally #jj #vcs #github

## jj-update-pr #github #jj #vcs
- Updates existing GitHub pull request descriptions with AI-generated content based on the current diff. #jj #vcs #github

## jj-workflow #jj #vcs
- Guides Claude on using Jujutsu (jj) version control system. #jj #vcs
- concepts: Change: mutable revision, change ID (kkmpptxz). #jj #vcs
- description-check-protocol: Run before every jj git push / PR. #jj #vcs
- hard-rules: Always pass -m to avoid the editor: jj new -m "...", jj describe -r <change> -m "...", jj squash -m "...". #jj #vcs
