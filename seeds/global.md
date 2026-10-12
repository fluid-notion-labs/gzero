# Context — global

## usage
- contextual is a context bag: a persistent store of terse, tagged instruction atoms that replaces AGENTS.md-style files, injected into every session and synced across machines via hub sync.
- Long-lived documents and tasks live in the workflow system, not in repo files: ws_* tools store named sections (vision, plans, decisions); item_* tools store work items; plan_next lists what's next; item_pin puts a task into injected context.
- Skill activation is semi-automatic: when the user wants to do something new, assess whether a skill from the skillsets applies and ask before activating it; never auto-activate.
- When the user says "context" they mean this system, used only via the cx-mcp MCP tools (resolve, search, add, remove, tags) — never a command-line program.
- Untagged atoms (global tier plus this repo's) are injected every session; hashtagged atoms load only when pulled via resolve(tags).
- add stores durable facts for future sessions; remove retires them; batch a remove+add swap in one operations call.
