# contextual pi plugin

pi extension that connects the context system to pi sessions. Speaks to
contextual only via MCP — no direct SQLite or hub access.

- registers `cx-mcp` so the model gets the `mcp__context__*` tools
- injects the resolved default context (global + project tiers) into the
  system prompt at the first prompt of each session
- offers to install contextual on first run if `cx-mcp` is missing

Spec: `research/context/pi-plugin.md` (in the explorations repo);
curation policy: `research/context/curation.md`.

## Install

```sh
mkdir -p ~/.pi/agent/extensions
cp -r pi ~/.pi/agent/extensions/contextual
```

Requires `cx` and `cx-mcp` (the plugin offers to run
`cargo install --git https://github.com/fluid-notion-labs/contextual`).
Hub sync uses `CX_HUB_URL` and `CX_TOKEN`; unset means offline.
