# Context — loadfu

## architecture
- **Feature flag is the boundary.** `cargo check -p loadfu` must succeed with zero Bevy dependency. `cargo check -p loadfu --features bevy` adds the integration layer.

## testing
- **152 tests** as of Epic 5 completion (112 unit + 13 bevy-layer + 27 integration in `tests/pipeline.rs`) ```bash cargo check -p loadfu cargo check -p loadfu --features bevy cargo nextest run -p loadfu ``` ```bash jj describe -m "meaningful description of this change" jj new                    # Move @ forward so described change is immutable jj bookmark set main -r @-  # Advance main to the completed change (if landing to main) bd sync                   # Sync beads jj git push               # Push to remote (when remote is configured) jj log --limit 5          # Verify state ```
- **GLB:** `cube.glb`
