# Context — trees of agent instructions

*Live context: global at `~/.pi/agent/AGENTS.md`, project at `CONTEXT.md`
(repo root, referenced by `AGENTS.md`). Prototype at
`nursery/contextual/` (symlinked here as `contextual`); implementation
plan: `plan.md` in this directory.*

*Concept: replace scattered AGENTS.md files with "context" — terse, addressable
trees of instructions, layered global → per-project. Name for referring to it:
`#context`.*

## TL;DR

- Context = tree of atomic, terse instruction nodes. Every node has a stable
  ID; every reference is an ID. The file is simultaneously human prose and
  machine data — **homoiconic**: no separate schema, the markdown headings
  *are* the tree, `#id` links *are* the edges.
- Two layers: **global** (`~/.pi/agent/AGENTS.md`, auto-loaded by pi in every
  working directory) and **per-project** (`<repo>/AGENTS.md` or `CONTEXT.md`,
  discovered by walking up from cwd). Project context references global by
  path; cross-references use `#id`.
- Terse style borrowed from `vendor/caveman` — with one deliberate exception:
  persisted artifacts (context files, docs, code) keep full clarity. Caveman
  compresses *conversation*, not *corpus*.

## Caveman lessons (vendor/caveman, JuliusBrussee)

Viral skill + proxy; cuts 33–65% tokens. Validated externally: Adobe Research
(CAVEWOMAN, 1.4–2.4× cheaper), JetBrains (86 tasks, no quality loss, p=0.82),
Elastic (63.6% fewer response tokens, "zero information loss").

Rules that transfer to context authoring:

| Rule | Detail |
|---|---|
| Answer first | `[thing] [action] [reason]. [next step].` No preamble, no recap |
| Kill ceremony | No "sure", "let me", hedging, filler adverbs (just/really/basically/actually) |
| One idea per sentence | ASD-STE100 floor: ≤20 words, active voice, imperative |
| Short word | "fix" not "implement a solution for"; no invented abbreviations |
| Articles optional, meaning never | Drop a/an/the if it still reads; **never** drop not/never/no/only/except; numbers exact |
| Payload verbatim | Code, commands, paths, errors exact — one changed character breaks them |
| Each fact once | No restating, no summary after a list |
| Compression ≠ grammar stripped | Cave < ultracave < megacave ladder exists, but clarity wins ties |
| Never perform | If terse phrasing isn't shorter/clearer, plain prose wins |

Two research findings worth keeping: (1) compressing the *user's prompt* makes
answers worse — compress what the agent reads and writes, not what it's asked;
(2) sessions are mostly code and tool output, so compressing prose alone
leaves most tokens on the table — hence their proxy for input files.

`caveman-compress` (their context-compression skill) validates the same idea:
strip articles/filler/connectives, preserve code/paths/numbers/structure
byte-exactly, keep a backup outside the tree so auto-loaders don't re-ingest it.

## Spec: context tree

Format (homoiconic markdown):

```markdown
# Context — <scope>

## id-of-node          ← heading text IS the node ID (slug, stable)
- atomic rule, one line          ← leaf: imperative, reorderable, mergeable
- rule with link: see #other-id  ← edge
```

Properties:

1. **Addressable**: any node retrievable as `#context:<scope>/<node-id>`
   (e.g. `#context:global/tooling`). An agent can read the whole file or a
   slice by heading.
2. **Atomic**: one rule per bullet, one line. Enables diff/merge/prune and
   exact citation in conversation ("per #context/global/style").
3. **Terse always** (caveman rules above). Context is read by agents every
   session — it is the highest-frequency payload in the system.
4. **Layered**: global (cross-project) ⊂ project. Project context never
   repeats a global rule; it references it. Conflicts: project wins.
5. **No schema, no build step**: the file is its own database. A 20-line
   parser (headings → tree, bullets → leaves, `#x` → edges) is the whole
   tooling surface. Tooling itself, when built, lives in `nursery/`.

## Deployment in this environment

- **Global context**: `~/.pi/agent/AGENTS.md` — pi auto-loads
  `<agent-dir>/AGENTS.md` for every working directory (docs/configuration.md).
  Created; seeded with style + tooling. Currently no other agent consumes it;
  when the pi replacement is built (`nursery/`), it reads the same tree.
- **Project context**: `<repo>/AGENTS.md` stays as the auto-load entry point
  for now, but becomes a thin index: one `#context` pointer line + load
  instruction, with the tree in `<repo>/CONTEXT.md`. explorations is the first.
- **Reference convention**: say `#context:global/style` or
  `#context:explorations/layout` in conversation and in research docs.

## Things queued for global context

- [ ] Git conventions (commit style, when to push) — needs decision
- [ ] Language/runtime preferences per machine (e.g. default toolchains)
- [ ] Testing expectations (when to run what)
- [ ] Session hygiene (what belongs in research vs nursery, cross-project)
- [ ] Preferred output modes (JSON/TOON for machine reads?)
- [ ] pi-specific notes (packages, extensions in use)

Open question: whether global context should also carry the explorations
layout rules (research/nursery/vendor + linking rule) once other projects
adopt the same layout — for now they stay in project context.
