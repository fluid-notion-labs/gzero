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
//! - `add`     — save atoms; batch `operations` for add+remove in one call
//! - `remove`  — tombstone atoms by substring (self-healing errors)
//! - `tags`    — tag vocabulary with counts
//!
//! Workflow sections (`ws_*`): keyed, typed documents (md or checklist)
//! per project scope — the workflow system's long-form content
//! (vision, plan, checklists, user stories; plan3 W1). Stored in the
//! automerge doc at `CX_WS_DB` (default ~/.pi/agent/context.ws),
//! separate from the atom bag.
//!
//! Curation policy in the tool descriptions follows hermes' memory tool
//! (see `research/context/curation.md`): WHEN/SKIP routing, declarative
//! phrasing, swap-don't-skip via batched remove+add.
//!
//! `CX_DB` selects the bag (default `~/.pi/agent/context.db`, same as `cx`).
//! Logging goes to stderr only; stdout is protocol.

use std::collections::BTreeSet;
use std::io::{BufRead, Write};

use contextual::hub::{Event, Hub};
use contextual::sections::{Section, SectionKind};
use contextual::snapshot::Atom;
use contextual::{
    resolve_tiers, search, tag_counts, AutomergeStore, ParsedAtom, Row, SqliteStore, Storage,
};

const SOURCE: &str = "mcp";
const FALLBACK_SCOPE: &str = "inbox";
const DEFAULT_NODE: &str = "notes";

fn main() {
    let mut store = open_store();
    pull_from_hub(&mut store);
    seed_on_startup(&mut store);
    reconcile_harvest_on_startup(&mut store);
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
    match hub
        .fetch_snapshot()
        .map_err(|e| e.to_string())
        .and_then(|snap| {
            let n = snap.atoms.len() + snap.tombstones.len();
            contextual::absorb_snapshot(store, "hub", &snap)
                .map_err(|e| e.to_string())
                .map(|_| n)
        }) {
        Ok(n) => eprintln!("cx-mcp: hub sync ({n} entries)"),
        Err(e) => eprintln!("cx-mcp: hub sync failed: {e}"),
    }
}

/// Best-effort: sync the built-in seeds so the global tier always has its
/// floor content, even in a freshly wiped bag. Never fatal.
fn seed_on_startup(store: &mut SqliteStore) {
    if let Err(e) = contextual::reconcile_seeds(store) {
        eprintln!("cx-mcp: seed sync failed: {e}");
    }
}

/// Organic harvest at startup: reconcile the cwd's repo instruction files
/// against the content hashes recorded at last harvest. Changed files are
/// re-imported (and Put to the hub), deleted files retract their sources
/// (Remove for texts asserted only there). Never fatal: the session works
/// without it, the model can still call the `harvest` tool manually.
fn reconcile_harvest_on_startup(store: &mut SqliteStore) {
    let dir = match std::env::current_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let result = match contextual::reconcile_harvest(store, &dir, false) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cx-mcp: harvest reconcile failed: {e}");
            return;
        }
    };
    if result.harvested.is_empty() && result.removed.is_empty() {
        return;
    }
    let mut events: Vec<Event> = Vec::new();
    let mut put_texts: BTreeSet<String> = BTreeSet::new();
    for h in &result.harvested {
        for a in &h.atoms {
            put_texts.insert(a.text.clone());
            events.push(Event::Put {
                atom: Atom {
                    text: a.text.clone(),
                    scope: a.scope.clone(),
                    node: a.node.clone(),
                    tags: a.tags.clone(),
                },
            });
        }
    }
    for a in &result.retracted {
        if !put_texts.contains(&a.text) {
            events.push(Event::Remove { atom: a.clone() });
        }
    }
    eprintln!(
        "cx-mcp: harvest reconcile ({} reimported, {} removed, {} unchanged)",
        result.harvested.len(),
        result.removed.len(),
        result.unchanged
    );
    try_post(events);
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

fn call_tool(
    params: &serde_json::Value,
    store: &mut SqliteStore,
) -> Result<serde_json::Value, String> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("tools/call: missing name")?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let text = match name {
        "resolve" => tool_resolve(&args, store)?,
        "search" => tool_search(&args, store)?,
        "add" => tool_add(&args, store)?,
        "remove" => tool_remove(&args, store)?,
        "tags" => tool_tags(store)?,
        "harvest" => tool_harvest(&args, store)?,
        "ws_put" | "ws_get" | "ws_list" | "ws_delete" => {
            let mut ws = ws_store()?;
            match name {
                "ws_put" => tool_ws_put(&args, &mut ws)?,
                "ws_get" => tool_ws_get(&args, &ws)?,
                "ws_list" => tool_ws_list(&args, &ws)?,
                _ => tool_ws_delete(&args, &mut ws)?,
            }
        }
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
        Some(serde_json::Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
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
    // Browse mode: a scope_prefix (even empty) bypasses tier defaults and
    // returns every atom whose scope starts with it — for inspection UIs.
    if let Some(prefix) = args.get("scope_prefix").and_then(|v| v.as_str()) {
        let items = contextual::scope_atoms(store, prefix).map_err(|e| e.to_string())?;
        return Ok(render(items));
    }
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
            format!(
                " [{}]",
                r.tags
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        out.push_str(&format!("- ({}/{}) {}{}\n", r.scope, r.node, text, tags));
    }
    Ok(out)
}

/// Full atoms among the alive set whose text contains `needle` — the
/// exact identity removal events need.
fn alive_matching(store: &SqliteStore, needle: &str) -> Result<Vec<Atom>, String> {
    Ok(contextual::alive(store)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(text, _)| text.contains(needle))
        .map(|(text, r)| Atom {
            text,
            scope: r.scope,
            node: r.node,
            tags: r.tags,
        })
        .collect())
}

/// One batch operation from the `operations` array.
enum Op {
    Add {
        text: String,
        scope: Option<String>,
        node: Option<String>,
        tags: BTreeSet<String>,
    },
    Remove {
        needle: String,
    },
}

/// Parse the request into batch ops. Either `{operations: [...]}` or the
/// single-op shape (the args object itself is one add).
fn parse_ops(args: &serde_json::Value) -> Result<Vec<Op>, String> {
    if let Some(list) = args.get("operations").and_then(|o| o.as_array()) {
        if list.is_empty() {
            return Err("add: operations must not be empty".to_string());
        }
        let mut ops = Vec::new();
        for (i, op) in list.iter().enumerate() {
            let text = |name: &str| -> Result<String, String> {
                op.get(name)
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| format!("add: operations[{i}]: {name} is required"))
            };
            match op.get("action").and_then(|a| a.as_str()).unwrap_or("add") {
                "add" => ops.push(Op::Add {
                    text: text("text")?,
                    scope: op.get("scope").and_then(|v| v.as_str()).map(str::to_string),
                    node: op.get("node").and_then(|v| v.as_str()).map(str::to_string),
                    tags: arg_tags(op),
                }),
                "remove" => ops.push(Op::Remove {
                    needle: text("text")?,
                }),
                other => {
                    return Err(format!(
                        "add: operations[{i}]: unknown action '{other}' (add|remove)"
                    ))
                }
            }
        }
        return Ok(ops);
    }
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("add: text is required")?
        .to_string();
    Ok(vec![Op::Add {
        text,
        scope: args
            .get("scope")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        node: args
            .get("node")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        tags: arg_tags(args),
    }])
}

fn tool_harvest(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let dir = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => std::path::PathBuf::from(p),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let results = contextual::harvest_dir(store, &dir).map_err(|e| e.to_string())?;
    if results.is_empty() {
        return Ok(format!(
            "(no instruction files found: {})",
            contextual::HARVEST_FILES.join(", ")
        ));
    }
    let mut out = String::new();
    let mut events: Vec<Event> = Vec::new();
    for r in results {
        match r.stats {
            None => {
                out.push_str(&format!(
                    "{}: no bullets — skipped (pointer stubs are protected)\n",
                    r.path.display()
                ));
            }
            Some(s) => {
                out.push_str(&format!(
                    "{}: +{} -{} (kept {})\n",
                    r.path.display(),
                    s.added,
                    s.removed,
                    s.kept
                ));
                events.extend(r.atoms.into_iter().map(|a| Event::Put {
                    atom: Atom {
                        text: a.text,
                        scope: a.scope,
                        node: a.node,
                        tags: a.tags,
                    },
                }));
            }
        }
    }
    try_post(events);
    Ok(out.trim_end().to_string())
}

fn tool_add(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let ops = parse_ops(args)?;
    let mut added: Vec<Atom> = Vec::new();
    let mut removed: Vec<Atom> = Vec::new();
    // Removes first, so a remove+add batch frees its room in the same call.
    for op in ops {
        match op {
            Op::Remove { needle } => {
                let victims = alive_matching(store, &needle)?;
                store.remove_matching(&needle).map_err(|e| e.to_string())?;
                removed.extend(victims);
            }
            Op::Add {
                text,
                scope,
                node,
                tags,
            } => {
                let scope = scope.unwrap_or_else(|| {
                    contextual::repo_identity().unwrap_or_else(|| FALLBACK_SCOPE.to_string())
                });
                let node = node.unwrap_or_else(|| DEFAULT_NODE.to_string());
                added.push(Atom {
                    text,
                    scope,
                    node,
                    tags,
                });
            }
        }
    }

    // Re-sync the "mcp" source: surviving atoms plus the adds. Adds win on
    // text collisions (re-asserting an atom updates its tags/scope/node).
    let mut mine: Vec<ParsedAtom> = store
        .all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|row| row.source == SOURCE)
        .map(row_to_parsed)
        .collect();
    for atom in &added {
        if let Some(existing) = mine.iter_mut().find(|p| p.text == atom.text) {
            existing.scope = atom.scope.clone();
            existing.node = atom.node.clone();
            existing.tags = atom.tags.clone();
        } else {
            mine.push(ParsedAtom {
                text: atom.text.clone(),
                scope: atom.scope.clone(),
                node: atom.node.clone(),
                tags: atom.tags.clone(),
            });
        }
    }
    store
        .sync_source(SOURCE, &mine)
        .map_err(|e| e.to_string())?;

    let mut events: Vec<Event> = removed
        .iter()
        .map(|atom| Event::Remove { atom: atom.clone() })
        .collect();
    events.extend(added.iter().map(|atom| Event::Put { atom: atom.clone() }));
    try_post(events);
    Ok(format!("added {}, removed {}", added.len(), removed.len()))
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
    let victims = alive_matching(store, needle)?;
    if victims.is_empty() {
        // Self-healing no-match: show the closest entries so the caller can
        // retry with text copied verbatim (hermes' memory-store behavior).
        let closest = contextual::closest_matches(store, needle, 3).map_err(|e| e.to_string())?;
        let mut out = format!(
            "No atom matched {needle:?}. Retry with text copied verbatim from the intended entry"
        );
        if !closest.is_empty() {
            out.push_str(" (closest entries below).");
            for entry in closest {
                out.push_str(&format!("\n- {entry}"));
            }
        } else {
            out.push('.');
        }
        return Ok(out);
    }
    let n = store.remove_matching(needle).map_err(|e| e.to_string())?;
    try_post(
        victims
            .into_iter()
            .map(|atom| Event::Remove { atom })
            .collect(),
    );
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

// ---- workflow sections (plan3 W1) ----

/// The ws doc, opened per call (sections are infrequent; D1 unifies stores).
fn ws_store() -> Result<AutomergeStore, String> {
    let path = contextual::sections::default_ws_path();
    AutomergeStore::open(Some(&path)).map_err(|e| format!("ws: open {}: {e}", path.display()))
}

fn ws_scope_arg(args: &serde_json::Value) -> String {
    args.get("scope")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| contextual::repo_identity().unwrap_or_else(|| "global".to_string()))
}

fn tool_ws_put(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or("ws_put: name is required")?
        .to_string();
    let scope = ws_scope_arg(args);
    let order = args.get("order").and_then(|o| o.as_i64()).unwrap_or(0);
    let existing = store
        .section_get(&scope, &name)
        .map_err(|e| e.to_string())?;
    let kind = match args.get("kind").and_then(|k| k.as_str()) {
        Some(k) => SectionKind::parse(k).ok_or("ws_put: kind must be md or checklist")?,
        None => existing.as_ref().map_or(SectionKind::Md, |s| s.kind),
    };
    // Omitted body/title: keep the existing ones (metadata-only update).
    let body = args
        .get("body")
        .and_then(|b| b.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|s| s.body.clone())
                .unwrap_or_default()
        });
    let title = args
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|s| s.title.clone())
                .unwrap_or_default()
        });
    let s = Section {
        scope,
        name,
        kind,
        title,
        body,
        order,
    };
    let replaced = store.section_put(&s).map_err(|e| e.to_string())?;
    Ok(format!(
        "{} {} ({}, {} bytes)",
        if replaced { "set" } else { "created" },
        format!("{}/{}", s.scope, s.name),
        s.kind.as_str(),
        s.body.len()
    ))
}

fn tool_ws_get(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("ws_get: name is required")?;
    let scope = ws_scope_arg(args);
    match store.section_get(&scope, name).map_err(|e| e.to_string())? {
        Some(s) => Ok(s.body),
        None => {
            let names: Vec<String> = store
                .section_list(&scope)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|s| s.name)
                .collect();
            if names.is_empty() {
                Err(format!("ws_get: no sections in {scope:?}"))
            } else {
                Err(format!(
                    "ws_get: no section {name:?} in {scope:?}. Available: {}",
                    names.join(", ")
                ))
            }
        }
    }
}

fn tool_ws_list(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let items = store.section_list(&scope).map_err(|e| e.to_string())?;
    if items.is_empty() {
        return Ok(format!("(no sections in {scope})"));
    }
    Ok(items
        .into_iter()
        .map(|s| {
            let prog = if s.kind == SectionKind::Checklist {
                let (d, t) = contextual::sections::checklist_progress(&s.body);
                format!(" {d}/{t}")
            } else {
                String::new()
            };
            format!(
                "{:<22} {:<10} {}{}",
                s.name,
                s.kind.as_str(),
                if s.title.is_empty() {
                    &s.name
                } else {
                    &s.title
                },
                prog
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn tool_ws_delete(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("ws_delete: name is required")?;
    let scope = ws_scope_arg(args);
    if store
        .section_delete(&scope, name)
        .map_err(|e| e.to_string())?
    {
        Ok(format!("deleted {scope}/{name}"))
    } else {
        Err(format!("ws_delete: no section {name:?} in {scope:?}"))
    }
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
        },
        "scope_prefix": {
          "type": "string",
          "description": "Browse instead of resolve: return ALL atoms whose scope starts with this prefix, ignoring tier defaults (empty string = the whole bag). For inspection UIs, not for pulling task context."
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
    "description": "Save a durable fact to persistent context — carried across sessions and machines, injected into every future session, so keep entries compact and high-signal.\n\nWHEN: only facts that apply to EVERY session regardless of task — who the user is, stable environment facts, standing conventions with no task home. Anything learned while doing a task (procedures, pitfalls, the user's preferences and corrections for that kind of work) gets a TAG instead, so it loads only when pulled via resolve(tags).\n\nHOW: write declarative facts, not instructions to yourself — 'User prefers concise responses' is right, 'Always respond concisely' is wrong (imperative phrasing is re-read as a directive in later sessions and can override the user's current request). To change an entry, batch the removal of the old atom and the add of the new one in one 'operations' call instead of appending a near-duplicate.\n\nSKIP: trivial or easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state.\n\nSingle change: {text, tags?}. Multiple changes in ONE call: {operations: [{action:'add', text, tags?} | {action:'remove', text}]} — preferred when both adding and removing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "The terse assertion (one sentence, declarative)." },
        "scope": { "type": "string", "description": "Scope: repo identity (default), 'global' for user-level, or a pack scope." },
        "node": { "type": "string", "description": "Node heading within the scope (default: notes)." },
        "tags": { "type": "string", "description": "Comma-separated hashtags. Use tags for task-specific knowledge so it loads only when pulled." },
        "operations": {
          "type": "array",
          "description": "Batch of changes applied in one call, removes first: [{action:'add', text, scope?, node?, tags?} | {action:'remove', text}]. Use when both adding and removing (e.g. replacing an entry).",
          "items": {
            "type": "object",
            "properties": {
              "action": { "type": "string", "enum": ["add", "remove"] },
              "text": { "type": "string", "description": "add: the new assertion. remove: a short substring identifying the entry to tombstone." },
              "scope": { "type": "string" },
              "node": { "type": "string" },
              "tags": { "type": "string", "description": "Comma-separated hashtags (add only)." }
            },
            "required": ["text"]
          }
        }
      },
      "required": ["text"]
    }
  },
  {
    "name": "remove",
    "description": "Retire a context atom. 'text' is a short substring IDENTIFYING the entry — it locates the entry, it is not spliced out. Removal records a tombstone, so it propagates to other machines and is permanent. If nothing matches, the closest entries are returned — retry with text copied verbatim from the intended entry. To update an entry, batch this remove with the add of the new text via the 'add' tool's 'operations'.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Short unique substring identifying the atom to remove." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "harvest",
    "description": "Import agent-instruction files from the repo into the bag as project context — instructions written for ANY agent (AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md) become one shared store, injected automatically in that repo from then on. NOTE: this runs automatically at server startup — changes to those files are detected by content hash and mirrored without anyone calling this. Call it only to pick up mid-session edits immediately. Files with no bullets are skipped (pointer stubs are protected). Optional 'path' defaults to the current directory.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "Directory whose repo to harvest (default: cwd)." }
      }
    }
  },
  {
    "name": "tags",
    "description": "List the context repository's hashtag vocabulary with counts.",
    "inputSchema": { "type": "object", "properties": {} }
  },
  {
    "name": "ws_put",
    "description": "Create or replace a workflow section: a keyed, typed document for this project. Use for long-form workflow content — vision, plan, checklists, user stories, architecture notes. 'kind' is 'md' (default) or 'checklist' (body uses '- [ ]'/'- [x]' lines). Updating metadata only (title/kind/order) without 'body' keeps the existing body.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "Slug, e.g. 'vision', 'plan', 'checklist.build'. Dots nest." },
        "scope": { "type": "string", "description": "Project scope (repo identity). Omit for the current project (or global outside a repo)." },
        "kind": { "type": "string", "enum": ["md", "checklist"] },
        "title": { "type": "string" },
        "body": { "type": "string", "description": "Markdown body. Omit to keep the existing body on update." },
        "order": { "type": "integer", "description": "Sort key within the scope; lower shows first." }
      },
      "required": ["name"]
    }
  },
  {
    "name": "ws_get",
    "description": "Read one workflow section body verbatim. Checklists keep their '- [ ]'/'- [x]' lines.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["name"]
    }
  },
  {
    "name": "ws_list",
    "description": "List workflow sections for a scope: one line each — name, kind, title, and done/total for checklists.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scope": { "type": "string", "description": "Omit for the current project." }
      }
    }
  },
  {
    "name": "ws_delete",
    "description": "Delete a workflow section. Removal is immediate and local; sections have no tombstones yet.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["name"]
    }
  }
]"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert!(handle_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &mut s
        )
        .is_none());
    }

    #[test]
    fn list_and_call_roundtrip() {
        let mut s = store();
        let reply =
            handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, &mut s).unwrap();
        assert!(reply.contains("\"resolve\""));
        assert!(reply.contains("\"search\""));
        assert!(reply.contains("\"add\""));

        // add, then see it in the default resolve
        let add = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{"text":"terse beats verbose","tags":"style"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(add.contains("added 1, removed 0"));
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
        assert!(
            !res.contains("rust only fact"),
            "tagged atom stays in the repository until pulled"
        );
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
    fn batch_add_and_remove_in_one_call() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"stale rule"}}}"#,
            &mut s,
        );
        // replace: batch remove + add, applied in one call
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"operations":[{"action":"remove","text":"stale"},{"action":"add","text":"fresh rule"}]}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("added 1, removed 1"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve","arguments":{}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("fresh rule"));
        assert!(!res.contains("stale rule"));
        // both the tombstone and the mcp row for the old text are recorded
        assert_eq!(s.tombstones().unwrap().len(), 1);
    }

    #[test]
    fn batch_validation_errors() {
        let mut s = store();
        for body in [
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"operations":[]}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"operations":[{"action":"merge","text":"x"}]}}}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{"operations":[{"action":"add"}]}}}"#,
        ] {
            let reply = handle_line(body, &mut s).unwrap();
            assert!(reply.contains("error"), "expected error for {body}");
        }
    }

    #[test]
    fn remove_no_match_returns_closest_entries() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"user prefers concise responses"}}}"#,
            &mut s,
        );
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remove","arguments":{"text":"prefers concise replies"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("No atom matched"));
        assert!(reply.contains("user prefers concise responses"));
        // the hint lists the entry, so a verbatim retry succeeds
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remove","arguments":{"text":"user prefers concise responses"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("tombstoned 1"));
    }

    #[test]
    fn reassert_updates_tags() {
        let mut s = store();
        handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"text":"same text","tags":"a"}}}"#,
            &mut s,
        );
        handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"text":"same text","tags":"b"}}}"#,
            &mut s,
        );
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve","arguments":{"tags":"b"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(res.contains("same text"));
        let res = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"resolve","arguments":{"tags":"a"}}}"#,
            &mut s,
        )
        .unwrap();
        assert!(
            !res.contains("same text"),
            "re-assertion replaces the mcp row's tags"
        );
    }

    #[test]
    fn harvest_tool_roundtrip() {
        let dir = std::env::temp_dir().join("cx-harvest-mcp");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("GEMINI.md"),
            "# Gemini\n\n## style\n- prefer short answers\n",
        )
        .unwrap();
        let mut s = store();
        let reply = handle_line(
            &format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"harvest\",\"arguments\":{{\"path\":\"{}\"}}}}}}",
                dir.display()
            ),
            &mut s,
        )
        .unwrap();
        assert!(reply.contains("+1"), "harvest reply: {reply}");
        // the atom lands in the project tier of that (non-git) dir scope
        let res = handle_line(
            &format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{{\"name\":\"search\",\"arguments\":{{\"text\":\"short answers\"}}}}}}"
            ),
            &mut s,
        )
        .unwrap();
        assert!(res.contains("prefer short answers"));
    }

    #[test]
    fn ws_roundtrip_metadata_only_update() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let reply = tool_ws_put(
            &json!({"name": "vision", "title": "Vision", "body": "v1 body"}),
            &mut s,
        )
        .unwrap();
        assert!(
            reply.contains("created") && reply.contains("vision"),
            "{reply}"
        );
        assert_eq!(
            tool_ws_get(&json!({"name": "vision"}), &s).unwrap(),
            "v1 body"
        );
        // metadata-only update keeps the body
        let reply = tool_ws_put(&json!({"name": "vision", "title": "New"}), &mut s).unwrap();
        assert!(reply.contains("set"), "{reply}");
        assert_eq!(
            tool_ws_get(&json!({"name": "vision"}), &s).unwrap(),
            "v1 body"
        );
    }

    #[test]
    fn ws_list_delete_and_missing() {
        let mut s = AutomergeStore::in_memory().unwrap();
        tool_ws_put(
            &json!({"name": "plan", "kind": "checklist", "body": "- [x] a\n- [ ] b"}),
            &mut s,
        )
        .unwrap();
        let list = tool_ws_list(&json!({}), &s).unwrap();
        assert!(list.contains("plan") && list.contains("checklist") && list.contains("1/2"));
        assert!(tool_ws_delete(&json!({"name": "plan"}), &mut s)
            .unwrap()
            .contains("deleted"));
        assert!(tool_ws_delete(&json!({"name": "plan"}), &mut s).is_err());
        assert!(tool_ws_get(&json!({"name": "plan"}), &s).is_err());
    }

    #[test]
    fn ws_bad_name_and_kind() {
        let mut s = AutomergeStore::in_memory().unwrap();
        assert!(tool_ws_put(&json!({"name": "a b"}), &mut s).is_err());
        assert!(tool_ws_put(&json!({"name": ""}), &mut s).is_err());
        assert!(tool_ws_put(&json!({"name": "ok", "kind": "yaml"}), &mut s).is_err());
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
