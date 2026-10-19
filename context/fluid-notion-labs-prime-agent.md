# Context — fluid-notion-labs/prime-agent

## change-hygiene
- If a change starts forcing edits across many crate internals, stop and fix the boundary instead.
- If you change dependencies (`Cargo.toml`), regenerate/commit `Cargo.lock` in the same change. A new dependency is an architectural change: state in the PR why the existing crates cannot host the functionality, and `make deny` must stay clean for it.
- One logical change per PR. Fixes ride with the change that introduced them when possible; a PR that mixes a feature with unrelated lint fixes or refactors hides both from review.

## crates
- Dependencies only point from higher crates to lower crates shown above. No cycles or reverse edges. The leaf crates are peers; add only the dependencies needed for their work. Shared wire/domain vocabulary belongs in `pa-types`, not in a higher crate or a duplicate.
- `pa-cli` is a composition root: it wires crates together and contains no business logic.
- `pa-tui` renders from wire types and events; it does not link the session engine.

## lint-discipline
- Explain lint exceptions next to the `#[allow(...)]` or workspace configuration; keep exceptions narrow. Advisory ignores in `deny.toml` need a reason and review date.
- Zero-warning posture: the merge gates run fmt + clippy + tests at `-D warnings`, so a `warn` lint is a merge blocker. Keep the enabled set deliberate and selective; enable a new lint family only with every current site fixed in the same change.

## merge-gates
- **Parity-diff evidence is a merge gate** (the port's definition, not optional polish): every PR that touches a user-visible surface must include a "parity-diff evidence" section in its description showing the TS-binary comparison for what it changed: (1) rendered output — frame-diff vs the TS binary; (2) interactive behavior — the same input handled identically (keys, mouse, timing); (3) wire parity — byte-compare the TS daemon's traffic for protocol changes; (4) user-visible invariants — every user action produces the same visible reaction as TS (`/compact` shows started+completed; `/model` shows the selector; a refinement shows its decoration). A feature that "works" but was never diffed against the TS binary does not pass review. If TS shows it, Rust shows it identically; if Rust shows something TS does not, that is also a parity bug.
- PRs must state ownership compliance (crate README scope/non-goals/public API, dependency direction) and classify the change: internals, new `pub` surface, or a new dependency/cross-crate re-export. The latter two are architectural changes — an innocent-looking `pub use` is a very simple way to break encapsulation.
- The compiled fallback model catalog `crates/pa-ai/src/models_generated.rs` is hand-maintained Rust mirroring the TS `packages/ai/src/models.generated.ts` object literal — edit it by hand, exactly like its TS source (there is no generator). The parity fixture `crates/pa-models/tests/fixtures/catalog.v1.json` refreshes with `scripts/generate-catalog-fixture.py`. Bulk data files are exempt from the size guidance.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` must pass before every merge. Run `make check` — the local mirror of the same gates; CI runs on the org's billing (`.github/workflows/continuous.yml` on `main` pushes; `release.yml` on version tags). The PR-only codebase-health check reports growth past 2,000 lines as review guidance; it never blocks a merge.

## notes
- Cursor Bugbot's PR review rules (`.cursor/BUGBOT.md`) mirror these standards — update both whenever either changes.
## notes #cloudflare-setup
- Bypass recipe — settings.json: `{"onboardingShown": true, "defaultProvider": "cloudflare-workers-ai", "defaultModel": "@cf/zai-org/glm-5.3-flash"}` and ensure `export CLOUDFLARE_API_KEY=<key> CLOUDFLARE_ACCOUNT_ID=<acct>` before launch. Or persist the key in `~/.prime/agent/auth.json` as `{"cloudflare-workers-ai": {"type": "api_key", "key": "<key>"}}`.
- Cloudflare env var names are case-sensitive: use `CLOUDFLARE_API_KEY` for the API key, `CLOUDFLARE_ACCOUNT_ID` for the account, and `CLOUDFLARE_GATEWAY_ID` for the gateway (AI Gateway only).
- Current limitation: the `/login` panel stores only an API key; it does not prompt for `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_GATEWAY_ID`, so ambient env is the supported route until the multi-field login flow is ported.
- First interactive launch defaults to the Prime Inference startup model if you do not pass `--provider` / `--model`; it will ask for Prime Intellect login even with Cloudflare env vars set.
- First-time Prime Agent login prompt defaults to Prime Intellect; to start with Cloudflare immediately (no interactive login), pass `--api-key <CLOUDFLARE_API_KEY>` together with `CLOUDFLARE_ACCOUNT_ID` env and `--provider cloudflare-workers-ai --model @cf/zai-org/glm-5.3-flash`.
- For Cloudflare AI Gateway, also set `export CLOUDFLARE_GATEWAY_ID=<gateway>` and use provider `cloudflare-ai-gateway` instead of `cloudflare-workers-ai`; the same auth gate hides the gateway models without all three variables.
- If `onboardingShown` is false, the app probes a startup model. With no `--provider`/`--model` flags, the default startup model is `prime-inference`; that requires Prime Intellect auth, so you get the Prime login.
- If env vars are in `~/.bashrc`, they only take effect in new shells (`source ~/.bashrc` in existing terminals, or launch `prime-agent` from the same interactive shell where you verified `env | grep CLOUDFLARE`).
- If it still asks to log in, check the exact env var names with `env | grep CLOUDFLARE` — Rust uses `CLOUDFLARE_API_KEY`, not `CLOUDFLARE_API_TOKEN`. Also verify `prime-agent model list` shows the `cloudflare-workers-ai` block.
- Onboarding/login check: `run_onboarding_phase` first reads `onboardingShown` from `~/.prime/agent/settings.json`. If true, it skips the whole first-run flow immediately.
- Per-run Cloudflare command: `CLOUDFLARE_ACCOUNT_ID=<acct> prime-agent --provider cloudflare-workers-ai --model @cf/zai-org/glm-5.3-flash --api-key <key>`. For AI Gateway add `CLOUDFLARE_GATEWAY_ID` and `cloudflare-ai-gateway` provider.
- Preferred model for this project is `@cf/zai-org/glm-5.3-flash` via provider `cloudflare-workers-ai`.
- Run Prime Agent against Cloudflare Workers AI with `export CLOUDFLARE_API_KEY=<token>` and `export CLOUDFLARE_ACCOUNT_ID=<account>`, then `prime-agent --model cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash`.
- Run with explicit startup model to bypass the Prime login prompt: `CLOUDFLARE_ACCOUNT_ID=<acct> CLOUDFLARE_API_KEY=<key> prime-agent --provider cloudflare-workers-ai --model @cf/zai-org/glm-5.3-flash`.
- To bypass the onboarding login without typing anything, create `~/.prime/agent/settings.json` with `onboardingShown: true` and set `defaultProvider`/`defaultModel` to Cloudflare.
- Verify Cloudflare is configured by running `prime-agent model list` — the `cloudflare-workers-ai` block appears only when `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` are both set. Missing env vars make the Cloudflare models disappear from the picker.
- `CLOUDFLARE_API_TOKEN` and `CF_API_TOKEN` are NOT read by the Rust port; the provider map only knows `CLOUDFLARE_API_KEY`.

## performance-and-the-critical-path
- Fire-and-forget boundaries need a red-first test: a hanging sink (one that never replies) must not delay paint. The test fails if any await on the critical path reaches the worker's delivery.
- Nothing user-visible awaits the network. Any HTTP/socket call on a render path (telemetry, catalog fetch, update check) runs on a background worker; the paint path hands the work off and returns immediately. Delivery semantics (timeout, retry, ordering) live with the worker, not the caller.
- Telemetry is fire-and-forget from user-facing code. `pa-telemetry`'s background worker owns delivery end to end; no startup, session create, tab open, or first-render path may hold a flush or await a sink.
- Tests that mock a sink or run offline cannot prove the above (the benchmark's mock hides the POST). The regression test with a hanging sink is the required verifier.

## reliability-model
- No stubs, no `todo!()`, no swallowed errors (`anyhow` bubbling to UI is fine).
- The daemon is a supervisor: it spawns one worker process per active session instead of hosting sessions in-process. Workers are supervised, restarted with backoff, and sessions persist on disk (append-only JSONL, same layout as `~/.prime/agent/sessions`) so reattach works even if the supervisor restarts.

## repository
- **Never add `Co-authored-by` trailers** — not in commit messages, not in squash suggestions, not as attribution for work merged from branches. A PR's commits carry one identity: the ambient git config's. Fabricated or hand-written trailers (including noreply forms) misattribute commits to unrelated GitHub accounts.
- **Never set git identity for commits to this repo's history.** Agents must not set `user.name`/`user.email` (config or `-c`) or `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/ `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` for commits that land in this repository. Those commits carry the identity of the ambient git config. If such a commit fails for a missing identity, report it instead of adding config. Allowed: the `*_DATE` variables (the golden corpus pins them for reproducibility), throwaway temp repos created by tests, and the release automation's bot identity.
- CI runs on the org's billing: `.github/workflows/continuous.yml` on `main` pushes and `release.yml` on version tags.
- Parity ground truth is unchanged: a read-only checkout of the TS implementation (this repo at tag `v0.9.8`, the last TS release before the Rust port merged to `main`). Clone it to `~/prime-agent`, the conventional location the parity scripts and code fall back to; tooling that honors an override reads `PA_TS_REFERENCE`.

## style-and-structure
- Aim for files under 2,000 lines, tests included. The 2,000-2,100 range is a soft review signal, not a merge limit: when adding to an already-large file, consider splitting by responsibility rather than growing it further. Move related tests and docs with extracted code.
- Collapse if statements per clippy::collapsible_if.
- Inline format args: always prefer `format!("{x}")` over positional.
- Instrument async work at the definition (`#[tracing::instrument(...)]`), not with `.instrument(...)` at call sites. Check whether the callee is already instrumented first.
- Make `match` statements exhaustive; avoid wildcard arms.
- Name modules for what they own, not `utils` or `common`. Follow existing structure: in `crates/pa-core/src/kernel/manager/`, `mod.rs` connects `execution.rs`, `requests.rs`, and `teardown.rs`; put a new kernel-manager concern beside them. In `crates/pa-core/src/cron/store/`, `mod.rs` connects `heartbeat.rs`, `jobs.rs`, and `session_artifacts.rs`; keep storage work there rather than growing the scheduler.
- New traits need doc comments explaining their role and how implementations are expected to behave.
- No opaque positional `bool`/`Option` parameters (`foo(false)` is unreadable). Prefer enums, named methods, or newtypes. If you must pass an opaque literal by position, use an exact `/*param_name*/` comment matching the callee signature.
- No single-use helper methods. Do not create a helper referenced only once.
- Prefer method references over closures per clippy::redundant_closure_for_method_calls.
- Prefer native RPITIT trait methods with explicit `Send` bounds (`fn foo(&self) -> impl Future<Output = T> + Send;`) over `#[async_trait]` or `#[allow(async_fn_in_trait)]`. Implementations may use `async fn` when they satisfy the contract.
- Prefer private modules with an explicitly exported public crate API. Internals are `pub(crate)`.
- Workspace crates are prefixed `pa-`. The hard ownership rules: one owned area per crate, pa-types is the only shared crate, cycle-free dependency direction, minimal public APIs, no god-modules. The dependency direction is pinned in the Crates table below; each crate's README.md states its scope, non-goals, and public API surface.

## surface-contract-(must-not-change)
- CLI shape: `prime-agent` with the same commands/flags as the TS product; headless modes (RPC/daemon/session-worker) with identical behavior.
- RLM kernel API in the persistent Python REPL: `rlm.spawn/find_models/collect/list_subagents/delete_subagent/create_session/progress_note`, `rlm.harness` CRUD, `agent_message.send`, `agent_observe`, `compact`, `goal`, `refine`, `attach_image`, skills (markdown + Python) per the skill contract in the base system prompt.
- System prompt structure: layered — cache-stable static layer files (core harness description with the full API surface, mandatory usage rules, opinionated guidelines, per-model additions from the model-prompts TOML rule map) followed by one dynamic tail (packages, project context, skills inventory, MCP servers, environment, session role); the harness digest stays a separate `[harness-digest]` user message. `prime-agent prompt` dumps the assembled prompt with its layer breakdown.
- Tools exposed to the model: `bash`, `edit`, `python_repl` (internal helpers: `rename`, `stdout`).

## tests
- Bug fixes need a regression test that fails without the fix.
- Do not add negative tests for logic that was removed.
- Do not add tests for statically defined values.
- Prefer whole-object equality comparisons over field-by-field checks.
- Tests must wait for observable readiness, not fixed sleeps or retry-to-green loops. If a test must be disabled, give a reason at the test. Use isolated ports and temporary paths, and restore shared state. Run focused tests when changing their behavior.
- Verifiers over self-assessment: tmux user-level tests, differential tests against the TS binary on PATH, golden corpora replayed against real captured data. No lane merges without its verifier passing, rerun by the reviewer where feasible.
