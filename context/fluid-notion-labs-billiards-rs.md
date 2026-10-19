# Context — fluid-notion-labs/billiards-rs

## conventions
- All parity constants from the original game live in `src/consts.rs`; never inline magic numbers
- Fixed timestep is 60 Hz in `FixedUpdate`; all gameplay logic that needs cadence runs there
- Game code (rules, input, aim, HUD) never touches backend engine types; backends implement the contract in `src/physics/mod.rs`
- No code comments; explanations live in `docs/ARCHITECTURE.md`

## dev-environment
- CI/sandbox runners are lavapipe (software Vulkan); wgpu feature-request crashes there are environmental noise, not app bugs — build + clippy + tests must pass, visual state is confirmed by the user on real hardware

## notes #android #bevy
- billiards-rs Android path: cargo-apk (NativeActivity, no Gradle) is the quick route to an APK; bevy 0.19 requires explicitly adding the android-native-activity feature (no longer default), a cdylib lib target with #[bevy_main], and point shadows/MSAA must be disabled on Android (known bevy crashes #8214/#8229). Full doc: workflow section cx.docs.vendor.bevy.android.

## physics-backends
- `custom`: hand-rolled port of the original cannon-es model — no external physics dep
- `phys-rapier` / `phys-avian` features: deferred (M5/M6), no adapters yet
- `tailuge`: self-contained port of the tailuge/billiards physics model (`src/physics/tailuge.rs`, unit tests included; glue in `src/physics/tailuge_backend.rs` is data-marshalling only, no math)
- selected at runtime via the `PhysicsBackend` resource (default `custom`), switchable in the dev panel; both are always compiled

## vendored-crates-(`vendor/`)
- `vendor/Billiards` — original three.js + cannon-es source being ported (assets copied into `assets/` per milestone)
- `vendor/bevy` — bevy 0.19.1 monorepo (all workspace crates under `crates/`); pinned for API reference when working around bevy quirks, NOT used as a Cargo dependency ```
- `vendor/billiards` — tailuge/billiards TypeScript source; its physics model is ported in `src/physics/tailuge.rs`
