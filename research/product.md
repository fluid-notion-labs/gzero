# Contextual — product stance

*Terse and canonical; distilled from `context-fresh-spec.md` (2026-10).
Where the architecture is documented: **`architecture.md`** (the
umbrella — contexture, five planes, build order) and **`plan3.md`**
(the active plan). This doc states what the product is and where it
stands; those two carry the detail.*

## What it is

An MCP server (`cx-mcp`, served to agents as "context"), plus the `cx`
CLI and a pi plugin. It stores context and workflow content, and
injects the right slice into the agent's context every session.

## Terminology

- **WS / WF** — the workflow system: per-project structured content.
  Never a rule name.
- **context / prompt** — what gets injected. Parts are prefixed:
  `g` global, `l` local, `s` skillset.

## Context planes

| plane | scope | persists |
|---|---|---|
| global (`g`) | all projects, all machines | yes |
| local (`l`) | this project | yes, across sessions |
| skillsets (`s`) | reusable capabilities | yes |

Global and local are injected every session; skillsets activate on
demand. Everything persists across sessions; global is global.

## Skill activation (a workflow in the global context)

When the user wants to do something *new* (e.g. create a Rust
document), the agent assesses whether to activate a skill from the
skillsets — **semi-automatically: ask the user first**. Never
auto-activate, never auto-flood context.

## WS — the workflow system

Per-repository/project content, stored as **sections**: an arbitrary
number of named, typed documents. Starters: vision, synopsis (short
and thorough variants), architecture (evolves over time), plan (todo
checklists), arbitrary checklists, user stories — plus anything else
worth storing (we keep looking for more).

Features:

- Arbitrary number of sections; arbitrary markdown bodies; a `type`
  field (md, checklist, …).
- Plan tasks eventually inject into context, **prompted by the user**.
- Later/advanced: content-addressable links across sections and
  workflows.
- Initially built for pi; other agents possible later.

## Storage

- **Automerge** where it earns its keep: ordering, storage,
  distribution. Adopted (W0) as the engine core behind `Storage`;
  SQLite is a derived index, not truth. The hand-rolled bagflow
  prototype is deprecated.
- Single machine first; Cloudflare (the hub) comes later for
  distribution.

## Status (2026-10)

- Shipped: bag + per-session injection + pi plugin + hub (atoms);
  WS local: sections (W1), work items (W2); workflow pane + Ctrl+W
  section viewer in the plugin.
- In progress: W3 — plan-task injection (plan_next, pinned items,
  skill-activation seed atom).
- Then: W4 (policy/ranking), W5 (docs migrate into WS), Track D
  (distribution). Resident track is far later — see architecture.md.
