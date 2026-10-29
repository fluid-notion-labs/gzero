# Context — global

## usage
- gzero is a persistent store of terse, tagged instruction atoms that replaces AGENTS.md-style files, injected into every session and synced across machines via hub sync.
- Long-lived documents and tasks live in the workflow system, not in repo files: ws_* tools store named sections (vision, plans, decisions); item_* tools store work items; plan_next lists what's next; item_pin puts a task into injected context.
- Skill activation is semi-automatic: when the user wants to do something new, assess whether a skill from the skillsets applies and ask before activating it; never auto-activate.
- When the user says "context" they mean this system, used only via the gzero-mcp MCP tools (resolve, search, add, remove, tags) — never a command-line program.
- Untagged atoms (global tier plus this repo's) are injected every session; hashtagged atoms load only when pulled via resolve(tags).
- add stores durable facts for future sessions; remove retires them; batch a remove+add swap in one operations call.
- Chat shorthand for dictating knowledge: `gk: <fact>` stores the fact in the global tier, `lk: <fact>` in this project's local tier. Add via the add tool (global passes scope "global"), rewritten as clear, self-contained text — terse but readable without the surrounding conversation — and confirm briefly.
- Chat shorthand for dictating tasks: `td:`, `todo:`, `tk:`, or `task: <description>` creates a work item via item_add. First inspect the list (item_list / plan_next) and find an appropriate place — e.g. a child_of edge under a related parent. If the user indicates priority, it sets the item's priority and informs its placement. Confirm briefly.
- Canaries and refresh checks: if a `context refresh test atom` appears in the injected context block, live seed changes reach the store and are picked up at session start.
