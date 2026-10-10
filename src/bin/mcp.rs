//! `cx-mcp` — the context system as an MCP stdio server, so agents (pi,
//! and anything speaking MCP) can read and grow context directly.
//!
//! Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. No
//! third-party MCP SDK — the surface we need is tiny.
//!
//! Tools (server name "context" → `mcp__context__*`):
//! - `resolve` — tiered context: global (always) + project (auto from
//!   git repo identity) + hashtags pulled from the repository
//! - `search`  — discover atoms/tags by text when the hashtag is unknown
//! - `add`     — assert a new atom (source: "mcp", project scope by default)
//! - `remove`  — tombstone atoms by substring
//! - `tags`    — tag vocabulary with counts
//!
//! `CX_DB` selects the bag (default `~/.pi/agent/context.db`, same as `cx`).
//! Logging goes to stderr only; stdout is protocol.

use std::collections::BTreeSet;
use std::io::{BufRead, Write};

use contextual::hub::{Event, Hub};
use contextual::snapshot::Atom;
use contextual::{resolve_tiers, search, tag_counts, ParsedAtom, Row, SqliteStore, Storage};

const SOURCE: &str = "mcp";
const FALLBACK_SCOPE: &str = "inbox";
const DEFAULT_NODE: &str = "notes";

fn main() {
    let mut store = open_store();
    pull_from_hub(&mut store);
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(&line, &mut store) {
            writeln!(out, "{response}").expect("cx-mcp: stdout closed");
            out.flush().expect("cx-mcp: flush failed");
        }
    }
}

fn open_store() -> SqliteStore {
    let path = std::env::var("CX_DB").unwrap_or_else(|_| {
        format!(
            "{}/.pi/agent/context.db",
            std::env::var("HOME").expect("cx-mcp: no HOME")
        )
    });
    SqliteStore::open(&path).expect("cx-mcp: cannot open bag")
}

/// Best-effort: absorb the hub's merged snapshot so this session sees
/// other machines' updates immediately. Offline mode just skips this.
fn pull_from_hub(store: &mut SqliteStore) {
    let Some(hub) = Hub::from_env() else { return };
    match hub.fetch_snapshot().map_err(|e| e.to_string()).and_then(|snap| {
        let n = snap.atoms.len() + snap.tombstones.len();
        contextual::absorb_snapshot(store, "hub", &snap)
            .map_err(|e| e.to_string())
            .map(|_| n)
    }) {
        Ok(n) => eprintln!("cx-mcp: hub sync ({n} entries)"),
        Err(e) => eprintln!("cx-mcp: hub sync failed: {e}"),
    }
}

/// Best-effort event post to the hub.
fn try_post(events: Vec<Event>) {
    if events.is_empty() {
        return;
    }
    if let Some(hub) = Hub::from_env() {
        if let Err(e) = hub.post_events(&events) {
            eprintln!("cx-mcp: hub post failed: {e}");
        }
    }
}

/// Handle one incoming JSON-RPC message; None for notifications.
fn handle_line(line: &str, store: &mut SqliteStore) -> Option<String> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(|m| m.as_str())?.to_string();
    let params = msg.get("params").cloned().unwrap_or(serde_json::json!({}));

    let result: Result<serde_json::Value, String> = match method.as_str() {
        "initialize" => Ok(serde_json::json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "context", "version": "0.1.0" },
            "instructions": "Context system: terse tagged instructions, \
                shared across machines. Three tiers: global context is \
                always included; the current git repo's context is \
                auto-included; more is pulled from the repository by \
                hashtag. At task start call resolve (with tags when the \
                user names technologies or domains); use search to \
                discover hashtags; add to remember durable facts; \
                remove to retire them.",
        })),
        "ping" => Ok(serde_json::json!({})),
        "tools/list" => Ok(serde_json::json!({
            "tools": serde_json::from_str::<serde_json::Value>(TOOLS)
                .expect("cx-mcp: TOOLS literal is not valid JSON")
        })),
        "tools/call" => call_tool(&params, store),
        _ => Err(format!("method not found: {method}")),
    };

    Some(match result {
        Ok(value) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": value }).to_string(),
        Err(message) => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": message }
        })
        .to_string(),
    })
}

fn call_tool(params: &serde_json::Value, store: &mut SqliteStore) -> Result<serde_json::Value, String> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("tools/call: missing name")?;
    let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
    let text = match name {
        "resolve" => tool_resolve(&args, store)?,
        "search" => tool_search(&args, store)?,
        "add" => tool_add(&args, store)?,
        "remove" => tool_remove(&args, store)?,
        "tags" => tool_tags(store)?,
        other => return Err(format!("unknown tool: {other}")),
    };
    Ok(serde_json::json!({
        "content": [{ "type": "text", "text": text }]
    }))
}

fn arg_tags(args: &serde_json::Value) -> BTreeSet<String> {
    match args.get("tags") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(s)) => {
            s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect()
        }
        _ => BTreeSet::new(),
    }
}

fn render(items: Vec<(String, Row)>) -> String {
    if items.is_empty() {
        return "(no matching context)".to_string();
    }
    let mut out = String::new();
    let mut current = String::new();
    for (text, r) in items {
        let key = format!("{}/{}", r.scope, r.node);
        if key != current {
            out.push_str(&format!("\n# {key}\n"));
            current = key;
        }
        out.push_str(&format!("- {text}\n"));
    }
    out
}

fn tool_resolve(args: &serde_json::Value, store: &SqliteStore) -> Result<String, String> {
    let tags = arg_tags(args);
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    let project = contextual::repo_identity();
    let items = resolve_tiers(store, project.as_deref(), &refs).map_err(|e| e.to_string())?;
    Ok(render(items))
}

fn tool_search(args: &serde_json::Value, store: &SqliteStore) -> Result<String, String> {
    let needle = args
        .get("text")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
        .ok_or("search: text is required")?;
    let items = search(store, needle).map_err(|e| e.to_string())?;
    if items.is_empty() {
        return Ok(format!("(nothing matches {needle:?})"));
    }
    // Show scope/node + tags so the caller can map results to hashtags.
    let mut out = String::new();
    for (text, r) in items {
        let tags = if r.tags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", r.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "))
        };
        out.push_str(&format!("- ({}/{}) {}{}\n", r.scope, r.node, text, tags));
    }
    Ok(out)
}

fn tool_add(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("add: text is required")?
        .to_string();
    let scope = args
        .get("scope")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            contextual::repo_identity().unwrap_or_else(|| FALLBACK_SCOPE.to_string())
        });
    let node = args
        .get("node")
        .and_then(|t| t.as_str())
        .unwrap_or(DEFAULT_NODE);
    let tags = arg_tags(args);

    // Re-sync the "mcp" source: its existing atoms plus the new one.
    let mut mine: Vec<ParsedAtom> = store
        .all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|row| row.source == SOURCE)
        .map(row_to_parsed)
        .collect();
    mine.push(ParsedAtom {
        text: text.clone(),
        scope: scope.clone(),
        node: node.to_string(),
        tags: tags.clone(),
    });
    store.sync_source(SOURCE, &mine).map_err(|e| e.to_string())?;
    try_post(vec![Event::Put {
        atom: Atom {
            text,
            scope,
            node: node.to_string(),
            tags,
        },
    }]);
    Ok("stored".to_string())
}

fn row_to_parsed(row: Row) -> ParsedAtom {
    ParsedAtom {
        text: row.text,
        scope: row.scope,
        node: row.node,
        tags: row.tags,
    }
}

fn tool_remove(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let needle = args
        .get("text")
        .and_then(|t| t.as_str())
        .ok_or("remove: text is required")?;
    // Capture full atoms first so the remove events carry exact identity.
    let victims: Vec<Atom> = contextual::alive(store)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(text, _)| text.contains(needle))
        .map(|(text, r)| Atom {
            text,
            scope: r.scope,
            node: r.node,
            tags: r.tags,
        })
        .collect();
    let n = store.remove_matching(needle).map_err(|e| e.to_string())?;
    try_post(victims.into_iter().map(|atom| Event::Remove { atom }).collect());
    Ok(format!("tombstoned {n} atom(s) matching {needle:?}"))
}

fn tool_tags(store: &SqliteStore) -> Result<String, String> {
    let counts = tag_counts(store).map_err(|e| e.to_string())?;
    if counts.is_empty() {
        return Ok("(no tags yet)".to_string());
    }
    Ok(counts
        .into_iter()
        .map(|(tag, n)| format!("#{tag} ({n})"))
        .collect::<Vec<_>>()
        .join(", "))
}

const TOOLS: &str = r#"[
  {
    "name": "resolve",
    "description": "Get the current context: global context plus the current git repo's context, always; pass tags to also pull matching contexts from the repository. Call at task start, and whenever the user names technologies or domains (e.g. 'rust api, svelte app' -> tags rust,svelte).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tags": {
          "type": "string",
          "description": "Comma-separated hashtags to pull from the repository, e.g. \"rust, svelte\". Omit for just global + project context."
        }
      }
    }
  },
  {
    "name": "search",
    "description": "Find context atoms by text (case-insensitive), with their hashtags, when you don't know which tags exist. Use to map a user's words to hashtags, then call resolve with them.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Text to search atom texts for." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "add",
    "description": "Remember a durable fact, preference, or instruction in context (shared across machines). One terse sentence per atom. Lands in the current repo's scope by default.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "The terse assertion (one sentence)." },
        "scope": { "type": "string", "description": "Scope: repo identity (default), 'global' for user-level, or a pack scope." },
        "node": { "type": "string", "description": "Node heading within the scope (default: notes)." },
        "tags": { "type": "string", "description": "Comma-separated hashtags." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "remove",
    "description": "Retire context atoms by substring match; records tombstones so removals propagate to other machines.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Substring to match atom texts against." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "tags",
    "description": "List the context repository's hashtag vocabulary with counts.",
    "inputSchema": { "type": "object", "properties": {} }
  }
]"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SqliteStore {
        SqliteStore::in_memory().unwrap()
    }

    #[test]
    fn initialize_handshake() {
        let mut s = store();
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("\"protocolVersion\":\"2025-06-18\""));
        assert!(reply.contains("context"));
    }

    #[test]
    fn notifications_get_no_reply() {
        let mut s = store();
        assert!(handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &mut s).is_none());
    }

    #[test]
    fn list_and_call_roundtrip() {
        let mut s = store();
        let reply = handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, &mut s).unwrap();
        assert!(reply.contains("\"resolve\""));
        assert!(reply.contains("\"search\""));
        assert!(reply.contains("\"add\""));

        // add, then see it in the default resolve
        let add = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{"text":"terse beats verbose","tags":"style"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(add.contains("stored"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"resolve","arguments":{"tags":"style"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("terse beats verbose"));
    }

    #[test]
    fn tagged_atom_hidden_until_pulled() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"rust only fact","tags":"rust"}}}"#,
            &mut s,
        );
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resolve","arguments":{}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(!res.contains("rust only fact"), "tagged atom stays in the repository until pulled");
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve","arguments":{"tags":"rust"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("rust only fact"));
    }

    #[test]
    fn search_finds_and_shows_tags() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"sveltekit adapter node","tags":"svelte"}}}"#,
            &mut s,
        );
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"text":"SVELTEKIT"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("sveltekit adapter node"));
        assert!(res.contains("#svelte"));
    }

    #[test]
    fn remove_tombstones() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"gone soon"}}}"#,
            &mut s,
        );
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remove","arguments":{"text":"gone"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("tombstoned 1"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve","arguments":{}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(!res.contains("gone soon"));
        // tombstone recorded, so it propagates via export
        assert_eq!(s.tombstones().unwrap().len(), 1);
    }

    #[test]
    fn unknown_tool_and_method_error() {
        let mut s = store();
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("unknown tool"));
        let reply = handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"wat/xyz"}"#, &mut s).unwrap();
        assert!(reply.contains("method not found"));
    }
}
