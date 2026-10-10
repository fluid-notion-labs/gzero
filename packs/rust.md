# Context — rust

## build #rust
- `cargo check` for fast iteration; `cargo build` and `cargo test` to verify.
- `cargo clippy` before done; `cargo fmt` on changed files.
- Respect `rust-toolchain.toml` MSRV when present.

## layout #rust
- Binary thin, library fat: logic in lib modules, testable without the CLI.
- Workspace for multi-crate; one concern per crate.

## deps #rust
- Prefer std and small maintained crates; pin with `=` only for engines or audited releases.
