# Context — global

## usage
- contextual is a context bag: a persistent store of terse, tagged instruction atoms that replaces AGENTS.md-style files, injected into every session and synced across machines via hub sync.
- Larger or long-lived documents (decisions, working data, JSON) live in the kv annex beside the atom bag, addressed by dotted keys.
- When the user says "context" they mean this system, used only via the cx-mcp MCP tools (resolve, search, add, remove, tags) — never a command-line program.
- Untagged atoms (global tier plus this repo's) are injected every session; hashtagged atoms load only when pulled via resolve(tags).
- add stores durable facts for future sessions; remove retires them; batch a remove+add swap in one operations call.
