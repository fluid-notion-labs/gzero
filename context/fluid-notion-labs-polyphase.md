# Context — fluid-notion-labs/polyphase

- Do not commit or push without clear authority from the active profile or the current user request.
- Explicit user or orchestrator instructions override this Beads block.
- If a required sync or push is blocked, stop and report the exact command and error.
## agent-context-profiles
- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins. ```bash git status git pull --rebase bd dolt push git push git status ```

## architecture
- **Bevy layer** (`src/bevy/`) = `#[cfg(feature = "bevy")]` only. Thin `AssetLoader` wrappers that delegate to core parsers. `Into<bevy::Mesh>` for `MeshData`.
- **Core layer** (`src/`) = pure logic. No Bevy dependency. Parsers take `&[u8]` and return `Result<MeshData>`.
- **Dependencies.** Read [`docs/architecture/dependencies.md`](docs/architecture/dependencies.md) for full rationale. Summary rules:
- **Feature flag is the boundary.** `cargo check -p polyphase` must succeed with zero Bevy dependency. `cargo check -p polyphase --features bevy` adds the integration layer.
- **File size signals.** Parsers >300 lines → split into submodules. Bevy wrappers should be thin (<100 lines each).
- **Idiomatic patterns.** Use idiomatic APIs from dependency crates (e.g. `thiserror` derives instead of hand-rolled `Display`/`Error` impls). Don't reinvent what a dependency already provides. Keep the macro/crate footprint lean — only add a derive crate if it genuinely reduces boilerplate at our scale.
- **No math library in core.** glam comes in via bevy feature; core parsers use raw arrays.
- **Parsers are pure functions.** `&[u8] → Result<MeshData>`. No IO, no filesystem, no Bevy types.
- **Prefer `[f32; 3]` over math-library types** for `MeshData` internals — zero-dep, bytemuck-compatible, universally convertible.
- **Reference code** (`ref/`) = extracted from seaview. Read-only context for extraction, not part of the crate build.
- **When adding a crate**, update `docs/architecture/dependencies.md` with: what it does, why we chose it, what we evaluated and rejected.
- **`MeshData` is the universal intermediate.** Every parser produces it, every consumer (Bevy, CLI, pipeline) reads from it.
- **mint interop is opt-in** — add behind a `mint` feature flag when needed, not as a core dep.

## beads-issue-tracker
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files
- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Use `bd` for all task tracking; do not create markdown TODO lists.

## landing-the-plane-(session-completion)
- NEVER say "ready to push when you are" — YOU must push
- NEVER stop before pushing — that leaves work stranded locally
- Work is NOT complete until changes are described, bookmarks advanced, and pushed

## notes #fluid-notion-labs/polyphase/gltf
- GLB reader color support: COLOR_0 is read as F32 VEC4, or F32 VEC3 promoted to RGBA (alpha 1.0); other encodings (normalized u8/u16) are skipped, never misread — see read_colors in src/parsers/glb.rs.
- gltf/gltf-json (1.4) gotchas: `Checked<T>`'s inner field is private — use `Checked::unwrap()`; `json::Index::new` takes u32; `root.push(f(&mut root, ...))` doesn't compile — compute first, push second; `Root::default()` already sets asset.version "2.0"; and `gltf::import_slice` DECODES embedded images, so GLBs with fake/undecodable image bytes fail import — test fixtures need real image bytes (see tests/fixtures/pixel_red.png).
## notes #fluid-notion-labs/polyphase/testing
- **206 tests** (163 lib + 39 integration + 4 doc; with --features meshopt the same suite passes, the two meshopt tests swapping by cfg). Verify with: `cargo check -p polyphase`, `cargo check -p polyphase --features bevy`, `cargo test -p polyphase` — cargo-nextest is NOT installed in this environment, use plain `cargo test`.
## notes #fluid-notion-labs/polyphase/writers
- Writers live in src/writers — bytes-in/bytes-out, no I/O, WriteError{Validation, Unsupported, GlbSerialization}. write_glb/write_glb_pretty emit: topology-aware modes, POSITION min/max accessors, all four PBR texture slots, embedded textures as bufferView images (Uri textures as image.uri), samplers/textures deduped by value, flattened node hierarchy with standalone nodes synthesized for orphan meshes (no geometry dropped), alpha_cutoff only for Mask. Round-trip gate pattern: fixture → parse_asset → write_glb → parse_asset → compare (tests/pipeline.rs); exact f32 equality is safe because f32→JSON→f32 is lossless.

## testing
- **Error paths get tests too.** Every `LoadError` variant should have at least one test that triggers it.
- **GLB:** `cube.glb`, `cube_textured.glb` (materials + embedded texture + sampler), `cube_default_sampler.glb` (texture with no explicit sampler), `quad_meshopt.glb` (EXT_meshopt_compression; regenerate via `cargo run --features meshopt --example gen_meshopt_fixture`)
- **OBJ:** `triangle.obj`, `triangle_normals.obj`, `triangle_full.obj` (normals+UVs), `quad.obj`, `two_objects.obj`
- **PLY:** `triangle.ply` (ASCII, normals), `triangle_binary.ply` (binary LE, normals), `triangle_colors.ply` (ASCII, normals+vertex colors), `quad.ply` (ASCII, n-gon triangulation test)
- **Parser tests are pure.** Feed `&[u8]` in, assert on `MeshData` fields. No filesystem, no Bevy.
- **STL:** `triangle.stl` (binary), `triangle_ascii.stl`, `quad.stl` (binary)
- **Test names describe the scenario:** `parse_binary_triangle`, `empty_stl_returns_error`, `smooth_normals_single_triangle`.
- **Validation round-trip.** After parsing, call `.validate()` and assert `Ok(())` — proves the parser produces structurally valid `MeshData`.

## version-control-—-jj-(jujutsu)
- **Bookmarks** (jj's name for branches) mark integration points. `main` is the stable line.
- **Changes, not branches.** Work happens on `@`. Use `jj new` to start a new change, `jj describe` to add a message.
- **History is always rewritable.** `jj rebase`, `jj squash`, `jj split` — use freely.
- **`@`** is always the working-copy change. jj auto-snapshots on every operation — there is no "staging area".
