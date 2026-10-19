# Context — fluid-notion-labs/seaview

## architecture
- **Extract pure functions.** If a system has >20 lines of logic, pull it into a testable `lib/` function.
- **File size signals.** Systems >200 lines, modules >500 lines (excl. tests) → split. ```toml [patch."https://github.com/owner/repo.git"] crate-name = { path = "vendor/crate-name" } ``` ```bash git pull --rebase bd sync git push git status  # MUST show "up to date with origin" ```
- **No UI state in domain structs.** Interaction state (drag, hover, selection) lives in `UiState`.
- **One authoritative resource per domain.** Everything else is a mirror (e.g. `UiState.playback` mirrors `Timeline` + `SequenceManager`).
- **`app/`** = Bevy integration. Systems are thin wrappers: read resources → call `lib/` functions → write back.
- **`bin/`** = standalone tools. Import from `lib/` public API only, never from `app/`.
- **`lib/`** = pure logic. No system signatures, no ECS queries. Methods take plain args, return plain results. Testable without Bevy.

## notes
- seaview branch feat/amd-radeon-r600 (commit fd36e62, r600/AMD HD 5770 support via bevy-r600 forks, bevy 0.19.1) is machine-specific: never merge it into main or rebase main onto it; keep it as a local side branch
