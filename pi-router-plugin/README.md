# pi-router-plugin

A pi extension that classifies each turn's **work type** with a Clef/Jev
classifier model and sends the work to the **blessed model** for that type.

Design decisions live in the contexture workflow section `model-router`;
the branch/fork context (brief forks, brief composer, usage ledger) lives
in `/mnt/data/projects/explorations/research/ai-harness-memory/index.md`.

- **glm tier** (`@cf/zai-org/glm-5.3-flash`, 1M ctx): plan, research,
  architect, medium-codefix — routes in place via a virtual model.
- **qwen tier** (`@cf/qwen/qwen3-30b-a3b-fp8`, 32k ctx): easy-codefix,
  fix-warnings, fix-errors — dispatched as a fresh-context subagent
  (`pi --print`), never as the main session's model.
- **Classifier**: `@cf/cloudflare/clef-flash` (configurable), low-confidence
  or unreachable → default model.

## Files

- `config.ts` — config types, defaults, loading (`~/.pi/agent/pi-router.json`
  then `<repo>/.pi/pi-router.json`), validation, merge
- `index.ts` — extension entry (in progress)

## Development

```
npm test                          # node --test, no node_modules needed
sh ../tools/typecheck.sh pi-router-plugin
```

`tests/deps.mjs` maps `@earendil-works/*` to the vendored pi checkout's
dist builds, found by walking up; `tools/typecheck.sh` generates the
matching tsconfig for tsc.
