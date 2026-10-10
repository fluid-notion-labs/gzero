# Skills assay — the skill repos as a source for the context repository

*Five repos vendored at `nursery/contextual/vendor/` (gitignored — clones,
not ours). Question: what do agent-skill collections teach us about
populating the context repository, and how much do we want to import?
Related: `architecture.md` (resolution model, pull-in workflow).*

## The collections

| repo | skills | character | license |
|---|---|---|---|
| `anthropics/skills` | 20 | official demos: doc formats (docx/pdf/pptx/xlsx, source-available), design, `mcp-builder`, `webapp-testing`, `skill-creator` | Apache-2.0 (doc skills source-available) |
| `obra/superpowers` | 15 | development **methodology**: TDD, systematic debugging, code review, planning, verification-before-completion | MIT |
| `addyosmani/agent-skills` | 25 | production **engineering**: spec-driven development, API/interface design, CI/CD, security, performance, context-engineering | MIT |
| `Jeffallan/claude-skills` | 67 | role/stack **experts**: angular, fastapi, django, cpp, devops, chaos-engineering… widest tech coverage | MIT |
| `ComposioHQ/awesome-claude-skills` | index | curated list — discovery, not content | — |

## Format

Every skill is a folder with `SKILL.md`: YAML frontmatter (`name`,
`description`) + body. The activation mechanism is entirely in the
description — **"Use when…" trigger phrases** (e.g. Jeffallan's
`test-master` lists a dozen triggers: unit tests, k6, OWASP, flaky
tests…). The body is a full methodology document, 300–1000+ lines, often
with scripts and reference files alongside.

## Findings

1. **Skills are documents, not atoms.** Their size is 2–3 orders of
   magnitude past our terse model. They are *reference material*, not
   always-on context. Confirms the three-tier design: the bag holds
   terse atoms; heavy documents live elsewhere and get pulled on demand.
2. **"Use when…" ≈ our hashtags.** Their trigger phrase is doing the job
   of our tag vocabulary — except theirs is prose matched by an LLM,
   ours is a discrete tag matched by `resolve(tags)`. Complementary:
   our tags are cheap and deterministic; their triggers are rich and
   fuzzy. `search` bridges the gap (text → tag).
3. **Three genres**, and the workflow needs all three:
   - *stack experts* (Jeffallan) — map directly to "rust api, svelte app,
     flutter app" pulls
   - *methodology* (superpowers, addyosmani) — map to verbs: testing,
     debugging, reviewing, shipping
   - *artifact tools* (anthropics) — docx/pdf/etc., mostly not our battle
4. **Licensing is fine** for MIT repos; anthropics' doc skills are
   source-available — reference only.

## Import strategy (proposed)

Hybrid, staged:

1. **Distill, don't copy.** A converter turns each skill's frontmatter +
   headings into a terse pack atom: one assertion ("TDD: red-green-refactor,
   test first always") + hashtags derived from name/triggers, plus a
   pointer to the vendored SKILL.md path. The bag stays terse; the depth
   stays on disk. `search` finds the atom; reading the file gives the depth.
2. **Curate per genre.** Methodology skills distill well (they're already
   procedural). Stack experts distill to checklists. Skip artifact tools.
3. **Direct import is wrong** — `cx add` on a SKILL.md would import its
   whole body as dozens of atoms, breaking terse. The converter must
   summarize, not transcribe.

## Status

- ✅ vendored: `anthropics/skills`, `obra/superpowers`,
  `addyosmani/agent-skills`, `Jeffallan/claude-skills`,
  `ComposioHQ/awesome-claude-skills`
- ⬜ converter: `SKILL.md` → pack atoms (distilled + hashtags + file pointer)
- ⬜ first distilled pack to validate the pipeline (probably superpowers TDD)
