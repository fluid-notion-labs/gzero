# Contextual — curation policy (from hermes)

*How the agent is instructed to update and curate its memory — the
curation policy, not the architecture. Source: hermes-agent clone at
`../../vendor/hermes-agent/` (paths cited to it). Context: we are moving
off files to the hub as the always-on, always-distributed store; what
carries over is the *policy*, since it is store-agnostic. Companion:
`pi-plugin.md` (injection), `old/architecture.md` (store).*

## The three instruction sites (hermes)

Hermes teaches curation in exactly three places. All three are needed;
each covers a failure mode the other two miss.

### 1. Tool schema (`tools/memory_tool.py:347-368`)

The schema description carries HOW / WHEN / IF FULL / TARGETS / SKIP:

> **HOW:** make ALL your changes in ONE call via an 'operations' array (each
> item: {action, content?, old_text?}). The batch applies atomically and the
> char limit is checked only on the FINAL result — so a single call can
> remove/replace stale entries to free room AND add new ones, even when an
> add alone would overflow.
>
> **WHEN:** only for facts that apply to EVERY session regardless of task:
> who the user is, stable environment facts, standing conventions with no
> task home. Anything learned while doing a task (procedures, pitfalls, and
> the user's preferences and corrections for that kind of work) belongs in
> the task's skill via skill_manage, where it loads only when relevant;
> memory is injected into every turn and must stay small.
>
> **IF FULL:** an add is rejected with the current entries shown. Reissue as
> ONE batch that removes or shortens enough stale entries and adds the new
> one together.
>
> **SKIP:** trivial/obvious info, easily re-discovered facts, raw data
> dumps, task progress, completed-work logs, temporary TODO state (use
> session_search for those).

### 2. System-prompt guidance (`agent/prompt_builder.py:192`)

Short, framing-only, present in every session:

> You have persistent memory, carried across sessions and loaded into each
> new session's context; the memory tool's schema defines what belongs
> there. Skills come first: when you learn something while doing a task —
> a procedure, a pitfall, and the user's preferences and corrections for
> that kind of work — record it in the skill you used or built for the task
> (skill_manage), where it loads only when relevant. Memory is the narrow
> exception for facts that apply to EVERY session regardless of task ...;
> it has a hard character budget, so when it fills, replace or consolidate
> stale entries rather than skipping the save. Write entries as declarative
> facts, not instructions to yourself: 'User prefers concise responses' ✓ —
> 'Always respond concisely' ✗ (imperative phrasing gets re-read as a
> directive in later sessions and can override the user's current request).
> A fact stale within a week belongs in session history; procedures and
> workflows belong in skills.

### 3. Post-turn background review (`agent/background_review.py:408`)

A forked agent reviews every turn and writes to the store, never touching
the main conversation or prompt cache:

> Review the conversation above and consider saving to memory if
> appropriate. ... If something stands out, save it once, in the right
> store, using the memory tool with the matching target. If nothing is
> worth saving, just say 'Nothing to save.' and stop.

Plus the routing block it shares with the combined prompt:

> Two distinct stores — pick the right one for each fact: USER.md ... who
> the user is; MEMORY.md ... facts about the ENVIRONMENT. One fact goes to
> ONE store, never both — writing it to both bloats both files until they
> hit their size limits and crowds out the facts that matter; misrouting it
> puts it where the next session won't look.

## Supporting mechanics (store-level UX that makes policy work)

- **Replace = locate + overwrite.** `old_text` is a short unique substring
  that *locates* the entry; `content` is the COMPLETE new entry. Matching
  is typography-folded (curly→straight quotes, dashes, whitespace) because
  models re-emit entries with drifted formatting
  (`tools/memory_tool_store.py:_normalize_for_match`).
- **No-match errors teach.** A failed remove/replace returns the three
  closest entries by word overlap with a "retry with old_text copied
  verbatim" hint — the error is self-healing, not a dead end.
- **Hard budget + consolidation.** Over-budget add is rejected with current
  entries shown; failed consolidations are capped per turn so a stuck model
  doesn't thrash (`_MAX_CONSOLIDATION_FAILURES_PER_TURN`).
- **Same lesson twice is ONE rule.** From the skills prompt (applies to any
  curation): "Before adding, search ... for the rule already stated;
  strengthen or clarify it rather than appending a second copy." And
  "fix it in place when it is wrong: edit the sentence that misled, do not
  append 'UPDATE: actually...' underneath it."

## Mapping to contextual

| hermes concept | contextual equivalent |
|---|---|
| memory (always-on notes) | untagged atoms in `global` / project scope |
| USER.md vs MEMORY.md routing | `global` scope (user) vs project scope (environment) |
| skills (load only when relevant) | **tagged atoms / packs** — the hashtag pull-in is exactly "loads only when relevant" |
| session_search for ephemeral state | session history / future chat-history ownership |
| char budget | bounded injection: the resolved section must stay small (target: a few KB) |
| memory tool | `add` / `remove` MCP tools |

The skills→tags mapping is the load-bearing one: hermes routes task
knowledge to skills so memory stays universal. Contextual routes task
knowledge to **tagged** atoms so untagged (always-injected) stays universal.
Same discipline, different mechanism.

## Changes this implies for contextual

1. **Rewrite the `add` tool description** in the HOW/WHEN/SKIP shape:
   - WHEN: untagged, every-session facts only (who the user is, stable
     environment facts, standing conventions). Task-learned knowledge gets
     a tag, so it loads only when pulled.
   - SKIP: trivial/re-discoverable facts, raw dumps, task progress, TODOs.
   - Phrasing: declarative facts, never imperatives to self.
2. **Batch operations on `add`** (contextual-side change): accept an
   `operations` array so one call can add + remove atomically. Replace =
   remove + add in one batch. Today `add` can only append, so "when full,
   swap instead of skip" is impossible.
3. **`remove` should locate like hermes**: short substring locating an
   entry, no-match error returns closest entries (currently: count only).
   Removal is already a tombstone, so the replace path is safe.
4. **Injection guideline** (the P1 `<context>` section's preamble, or the
   plugin's one-time guidance): the framing block — persistent memory,
   tags-for-task-knowledge routing, declarative phrasing, consolidate
   rather than skip.
5. **Post-turn review** (built 2026-10-11, see plan.md): pi version of the
   background review — a forked model call at `turn_end` reviews the
   turn batch and saves once, in the right scope, with the right tags;
   "Nothing to save." as the expected no-op. Dovetails with the
   chat-history trajectory in `pi-plugin.md` (§Trajectory).
   Deliberate scope exclusions (v1 — revisit after some use): the
   reviewer does not save task-specific details without lasting value,
   facts stale within a week (session history covers them), procedures
   and workflows (those belong in skills), or anything already in the
   known context it is shown. Task knowledge worth keeping gets a
   hashtag so it loads on demand instead of in every session.
6. **Budget as policy, not enforcement**: the store lives on the hub now —
   no char budget in the write path. Boundedness is enforced at injection
   (resolve returns a bounded section) and by the agent's own consolidation
   habit. If injection ever overflows, the fix is curation, not a harder
   rejection — but consider a soft warning from `resolve` when the
   untagged set grows past a target size.

## Status

- ✅ policy extracted and mapped (this doc)
- ✅ `add`/`remove` tool descriptions rewritten, batch `operations` on
  `add` (remove-first, one `sync_source`), self-healing no-match on
  `remove` (closest entries by word overlap, `closest_matches` in lib.rs)
- ✅ injection preamble in the plugin (P1 shipped, `nursery/contextual/pi/`)
- ⬜ post-turn review hook
