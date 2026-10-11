# contextual pi plugin

pi extension that connects the context system to pi sessions. Speaks to
contextual only via MCP — no direct SQLite or hub access.

- registers `cx-mcp` so the model gets the `mcp__context__*` tools
- injects the resolved default context (global + project tiers) into the
  system prompt on every turn
- `/context` browses the bag in a tabbed overlay — **global** (always
  active), **local** (project), **skillbag** (distilled skills); switch
  with 1/2/3, tab, or ←/→; j/k scroll; esc/q close. `/context reload`
  re-resolves; `/context add <text>` saves an atom with a confirm dialog
- alt-s or `/skills` opens the skills picker: type-to-search over the
  vendored `SKILL.md` files (title + description), enter reads the full
  skill in a scrollable overlay, esc backs out then closes. Skill
  sources: `$CX_SKILLS_DIRS` (colon-separated), or the contextual repo's
  `vendor/` next to this plugin / at the known checkout path, or any
  `vendor/` above the working directory
- warns on a stale `cx-mcp` (missing tools via `tools/list`)
- offers to install contextual on first run if `cx-mcp` is missing

Spec: `research/context/pi-plugin.md` (in the explorations repo);
curation policy: `research/context/curation.md`; skills pipeline and
hub plan: `research/skills-assay.md`.

## Install

```sh
mkdir -p ~/.pi/agent/extensions
cp -r pi ~/.pi/agent/extensions/contextual
```

Requires `cx` and `cx-mcp` (the plugin offers to run
`cargo install --git https://github.com/fluid-notion-labs/contextual`).
Hub sync uses `CX_HUB_URL` and `CX_TOKEN`; unset means offline.
