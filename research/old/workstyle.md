# Contextual — workstyles

*A workstyle: a named set of directives — how we get things done. Each
directive is one way of working and references a skillset. Referenced from
chat with `##`-codes. Companions: `pi-plugin.md` (plugin surface the picker
extends), `plan.md`, `findings.md` (concept + style grounding). Code:
`nursery/contextual/pi-contextual-plugin/`.*

## Concept

- **Workstyle**: named set of directives, e.g. a future `dev`, `flutter`,
  `testing` workstyle.
- **Directive**: one way to get things done. Has a key (`jjc`), a terse
  instruction, and a skillset reference (`#skill:jj-workflow`).
- First directive: `jjc` — use jj, git colocated; if no jj setup,
  `jj git init --colocate` (#skill:jj-workflow).

## Reference syntax

| form | meaning |
|------|---------|
| `##workstyle.key` | bare reference; expands to the directive text |
| `##workstyle.key(extra ideas)` | parenthetical is extra info for this repo / this message; it stays in the message verbatim, it is never part of the shared atom |

`##` (double hash) is deliberately distinct from the single-hash spaces:
`#tag` = context pull, `#skill:` = skill, `##` = workstyle directive.

## Storage (local first, hub later)

- One atom per directive in the bag. Tag `ws-<workstyle>` (tag charset is
  alphanumerics + hyphen, so no slash); the key leads the atom text in
  backticks so it is parseable.
- Meta atom (untagged, node `workstyle`) describes the scheme so every
  session knows the syntax.
- Directives are tagged, so they load only when pulled (resolve with
  `ws-<workstyle>`), not on every turn.
- Local design: everything lives in the per-machine ledger (SQLite) and
  rides the existing sync path (snapshot → hub, OR-set with tombstones).
  Workstyles from other machines merge like any atoms. No hub dependency:
  offline, workstyles resolve from the local ledger.

## UX (pi plugin)

- **ctrl-space in the chat bar**: workstyle picker, mirrors the skills
  picker (alt-s, `skills.ts`). Search box filters across workstyles,
  directive keys, and descriptions. Enter inserts the code
  (`##workstyle.key`) at the cursor.
- **Data path**: `tags` MCP tool filtered to `ws-*` → workstyle names;
  `resolve(tags: <ws-tag>)` → that workstyle's directives. Key parsed from
  the leading backticked token.
- **Autocomplete**: typing `##` in the input offers workstyle/directive
  codes (extend the `SkillsAutocomplete` provider pattern).

## Expansion

- On submit, the plugin finds `##workstyle.key(extra)` codes in the prompt,
  resolves each directive via MCP, and prepends the collected directive
  texts as a context block before the turn goes out.
- The parenthetical stays inline in the message — it is repo/message-local
  extra info, not synced.
- Unknown code: left as-is; the model sees it and can `resolve`/`search`.

## Open questions

- Workstyle-level reference (`##dev` = expand the whole set)?
- Global-scope workstyles (user-level, cross-repo) vs project scope?
