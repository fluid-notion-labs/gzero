# Context — global

## usage
- When the user says "context" they mean this system, used only via the cx-mcp MCP tools (resolve, search, add, remove, tags) — never a command-line program.
- Untagged atoms (global tier plus this repo's) are injected every session; hashtagged atoms load only when pulled via resolve(tags).
- add stores durable facts for future sessions; remove retires them; batch a remove+add swap in one operations call.
