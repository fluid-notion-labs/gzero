//! `cx-mcp` — the context bag as an MCP stdio server, so agents (pi, and
//! anything speaking MCP) can read and grow the bag directly.
//!
//! Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. No
//! third-party MCP SDK — the surface we need is tiny.
//!
//! Tools:
//! - `bag_resolve` — resolved context (default or by tags), as markdown
//! - `bag_put`     — assert a new atom (source: "mcp")
//! - `bag_remove`  — tombstone atoms by substring
//! - `bag_tags`    — tag vocabulary with counts
//!
//! `CX_DB` selects the bag (default `~/.pi/agent/context.db`, same as `cx`).
//! Logging goes to stderr only; stdout is protocol.

use std::collections::BTreeSet;
use std::io::{BufRead, Write};

use contextual::{resolve, tag_counts, ParsedAtom, Row, SqliteStore, Storage};

const SOURCE: &str = "mcp";
const DEFAULT_SCOPE: &str = "inbox";
const DEFAULT_NODE: &str = "notes";

fn main() {
    let mut store = open_store();
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
    let path = std::env::var("CX_DB")
        .unwrap_or_else(|_| format!("{}/.pi/agent/context.db", std::env::var("HOME").expect("cx-mcp: no HOME")));
    SqliteStore::open(&path).expect("cx-mcp: cannot open bag")
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
            "serverInfo": { "name": "cx-mcp", "version": "0.1.0" },
            "instructions": "Context bag: terse, tagged agent instructions \
                and notes, shared across machines. Call bag_resolve at the \
                start of a task for applicable context; bag_put to remember \
                a durable fact or preference; bag_remove to retire one.",
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
        "bag_resolve" => tool_resolve(&args, store)?,
        "bag_put" => tool_put(&args, store)?,
        "bag_remove" => tool_remove(&args, store)?,
        "bag_tags" => tool_tags(store)?,
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

fn tool_resolve(args: &serde_json::Value, store: &SqliteStore) -> Result<String, String> {
    let tags = arg_tags(args);
    let items = resolve(store, &tags).map_err(|e| e.to_string())?;
    if items.is_empty() {
        return Ok("(no matching context)".to_string());
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
    Ok(out)
}

fn tool_put(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("bag_put: text is required")?
        .to_string();
    let scope = args
        .get("scope")
        .and_then(|t| t.as_str())
        .unwrap_or(DEFAULT_SCOPE);
    let node = args
        .get("node")
        .and_then(|t| t.as_str())
        .unwrap_or(DEFAULT_NODE);
    let tags = arg_tags(&args);

    // Re-sync the "mcp" source: its existing atoms plus the new one.
    let mut mine: Vec<ParsedAtom> = store
        .all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|row| row.source == SOURCE)
        .map(row_to_parsed)
        .collect();
    mine.push(ParsedAtom {
        text,
        scope: scope.to_string(),
        node: node.to_string(),
        tags,
    });
    store.sync_source(SOURCE, &mine).map_err(|e| e.to_string())?;
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
        .ok_or("bag_remove: text is required")?;
    let n = store.remove_matching(needle).map_err(|e| e.to_string())?;
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
    "name": "bag_resolve",
    "description": "Read the context bag: terse tagged instructions and notes shared across machines. Default is the untagged set; pass tags to widen.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tags": {
          "type": "string",
          "description": "Comma-separated tags to include, e.g. \"rust, npm\". Omit for the default (untagged) context."
        }
      }
    }
  },
  {
    "name": "bag_put",
    "description": "Remember a durable fact, preference, or instruction in the context bag (shared across machines). One terse sentence per atom.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "The terse assertion (one sentence)." },
        "scope": { "type": "string", "description": "Scope heading, e.g. the project name (default: inbox)." },
        "node": { "type": "string", "description": "Node heading within the scope (default: notes)." },
        "tags": { "type": "string", "description": "Comma-separated tags." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "bag_remove",
    "description": "Retire atoms from the context bag by substring match; records tombstones so removals propagate to other machines.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Substring to match atom texts against." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "bag_tags",
    "description": "List the context bag's tag vocabulary with counts.",
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
        assert!(reply.contains("cx-mcp"));
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
        assert!(reply.contains("bag_resolve"));
        assert!(reply.contains("bag_put"));

        // put, then see it in the default resolve
        let put = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bag_put","arguments":{"text":"terse beats verbose","tags":"style"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(put.contains("stored"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bag_resolve","arguments":{"tags":"style"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("terse beats verbose"));
        assert!(res.contains("# inbox/notes"));
    }

    #[test]
    fn remove_tombstones() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bag_put","arguments":{"text":"gone soon"}}}"#,
            &mut s,
        );
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bag_remove","arguments":{"text":"gone"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("tombstoned 1"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bag_resolve","arguments":{}}}"#,
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
