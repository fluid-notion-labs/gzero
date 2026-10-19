# Context — local

## notes
- No markdown docs: long-lived documents, plans, decisions and architecture notes live in gzero workflow sections (ws_*), not repo .md files
- Teams live in the atom store at scope team/<name> (source team:<name>): one purpose node plus a member/<id> node per member (kind: human|agent, role, notes). List with the teams MCP tool or `gzero teams`; browse raw atoms via resolve with scope_prefix team/. The example team (team/example) seeds on startup and is the fixture the first team grows from.
- viewer2 build step: scene-api's /viewer2/ route serves viewer2/dist, which is gitignored; run `npm run build` inside viewer2/ after cloning or changing the viewer source.
## notes #pool-table #scene-mcp
- Current pool-table target is a 7ft Australian competition-style Trueline/Mal Atwell table: jarrah timber rails, green Strachan-style cloth, 18 mm MDF bed screwed to a steel RHS 40x40 bracket with SHS 60x60 legs. Rail caps have a 45° inner undercut running 20 mm below the top (captured as a feature plane; true chamfered geometry needs non-box primitives, deferred). Model file is work/pool-table-7ft.glb. The MCP-native build is intended for a fresh session using this checkout's .pi/mcp.json (scene-mcp server to port 8788).
