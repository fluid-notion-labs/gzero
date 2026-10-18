//! `gzero-mcp` — the context system as an MCP stdio server, so agents (pi,
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
//! separate from the atom store.
//!
//! Curation policy in the tool descriptions follows hermes' memory tool
//! (see `research/context/curation.md`): WHEN/SKIP routing, declarative
//! phrasing, swap-don't-skip via batched remove+add.
//!
//! `CX_DB` selects the atom store (default `~/.pi/agent/context.db`, same as `cx`).
//! Logging goes to stderr only; stdout is protocol.

use std::collections::BTreeSet;
use std::io::{BufRead, Write};

use gzero::hub::{Event, Hub};
use gzero::items::{MoveTarget, Status, WorkItem};
use gzero::sections::{Section, SectionKind};
use gzero::snapshot::Atom;
use gzero::{
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
            writeln!(out, "{response}").expect("gzero-mcp: stdout closed");
            out.flush().expect("gzero-mcp: flush failed");
        }
    }
}

fn open_store() -> SqliteStore {
    let path = std::env::var("CX_DB").unwrap_or_else(|_| {
        format!(
            "{}/.pi/agent/context.db",
            std::env::var("HOME").expect("gzero-mcp: no HOME")
        )
    });
    SqliteStore::open(&path).expect("gzero-mcp: cannot open atom store")
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
            gzero::absorb_snapshot(store, "hub", &snap)
                .map_err(|e| e.to_string())
                .map(|_| n)
        }) {
        Ok(n) => eprintln!("gzero-mcp: hub sync ({n} entries)"),
        Err(e) => eprintln!("gzero-mcp: hub sync failed: {e}"),
    }
}

/// Best-effort: sync the built-in seeds so the global tier always has its
/// floor content, even in a freshly wiped store. Never fatal.
fn seed_on_startup(store: &mut SqliteStore) {
    if let Err(e) = gzero::reconcile_seeds(store) {
        eprintln!("gzero-mcp: seed sync failed: {e}");
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
    let result = match gzero::reconcile_harvest(store, &dir, false) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("gzero-mcp: harvest reconcile failed: {e}");
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
        "gzero-mcp: harvest reconcile ({} reimported, {} removed, {} unchanged)",
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
            eprintln!("gzero-mcp: hub post failed: {e}");
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
                .expect("gzero-mcp: TOOLS literal is not valid JSON")
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
        "park_claim" => tool_park_claim(&args)?,
        "ws_put" | "ws_get" | "ws_list" | "ws_ensure" | "ws_delete" => {
            let mut ws = ws_store()?;
            match name {
                "ws_put" => tool_ws_put(&args, &mut ws)?,
                "ws_get" => tool_ws_get(&args, &ws)?,
                "ws_list" => tool_ws_list(&args, &ws)?,
                "ws_ensure" => tool_ws_ensure(&args, &mut ws)?,
                _ => tool_ws_delete(&args, &mut ws)?,
            }
        }
        "session_handoff" => {
            let mut ws = ws_store()?;
            tool_session_handoff(&args, &mut ws)?
        }
        "msg_send" | "msg_read" | "broadcast" => match name {
            "msg_send" => tool_msg_send(&args, store)?,
            "msg_read" => tool_msg_read(store)?,
            _ => tool_broadcast(&args, store)?,
        },
        "item_add" | "item_list" | "item_ready" | "item_get" | "item_edit" | "item_note"
        | "item_delete" | "item_pin" | "item_gate" | "item_move" => {
            let mut ws = ws_store()?;
            match name {
                "item_add" => tool_item_add(&args, &mut ws)?,
                "item_list" => tool_item_list(&args, &ws)?,
                "item_ready" => tool_item_ready(&args, &ws)?,
                "item_get" => tool_item_get(&args, &ws)?,
                "item_edit" => tool_item_edit(&args, &mut ws)?,
                "item_note" => tool_item_note(&args, &mut ws)?,
                "item_pin" => tool_item_pin(&args, &mut ws)?,
                "item_gate" => tool_item_gate(&args, &mut ws)?,
                "item_move" => tool_item_move(&args, &mut ws)?,
                _ => tool_item_delete(&args, &mut ws)?,
            }
        }
        "sessions" => tool_sessions(store)?,
        "scope" => tool_scope()?,
        "plan_next" => {
            let ws = ws_store()?;
            tool_plan_next(&args, &ws)?
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
        let items = gzero::scope_atoms(store, prefix).map_err(|e| e.to_string())?;
        return Ok(render(items));
    }
    let tags = arg_tags(args);
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    let project = gzero::repo_identity();
    let items = resolve_tiers(store, project.as_deref(), &refs).map_err(|e| e.to_string())?;
    let mut out = render(items);
    // Presence (S1): resolve doubles as the heartbeat — it runs every
    // turn, so no timer. Sweeping expired rows rides along.
    if let Some(block) = presence_block(store) {
        out.push_str(&block);
    }
    // Conversation layer (S3/S3b): unread messages for this session;
    // unseen broadcasts delivered and drained. Ephemeral sweeps ride
    // on the same piggyback.
    if let Some(block) = comms_block(store) {
        out.push_str(&block);
    }
    // Handoff slot (S2): the newest open handoff in this scope, unless
    // this session authored it. A pointer, not the full text — the
    // model pulls details with item_get.
    if let Some(block) = handoff_block() {
        out.push_str(&block);
    }
    if let Some(block) = pinned_block() {
        out.push_str(&block);
    }
    Ok(out)
}

/// Unread messages and unseen broadcasts for this session (S3/S3b).
/// Messages show until read via msg_read; broadcasts drain on this
/// delivery (per-session seen state). Also sweeps expired rows. Best-
/// effort: failures never break resolve.
fn comms_block(store: &SqliteStore) -> Option<String> {
    let (me, _) = gzero::sessions::session_identity();
    let _ = store.sweep_messages(gzero::messages::MESSAGE_TTL_SECS);
    let _ = store.sweep_broadcasts(gzero::messages::MESSAGE_TTL_SECS);
    let unread = store.unread_messages(&me).ok()?;
    let broadcasts = store.unseen_broadcasts(&me).ok()?;
    if unread.is_empty() && broadcasts.is_empty() {
        return None;
    }
    let mut out = String::new();
    if !unread.is_empty() {
        out.push_str(&format!(
            "\n\n## messages for you\n{} unread — from your session siblings:\n",
            unread.len()
        ));
        for m in unread.iter().take(5) {
            out.push_str(&format!("- from `{}`: {}\n", m.sender, m.text));
        }
        out.push_str("- msg_read drains these; reply with msg_send {to, text}\n");
    }
    if !broadcasts.is_empty() {
        out.push_str(&format!(
            "\n\n## broadcast board\n{} new — information, not demand:\n",
            broadcasts.len()
        ));
        for b in broadcasts.iter().take(5) {
            out.push_str(&format!("- from `{}`: {}\n", b.sender, b.text));
        }
    }
    let ids: Vec<String> = broadcasts.iter().map(|b| b.id.clone()).collect();
    let _ = store.mark_broadcasts_seen(&me, &ids);
    Some(out)
}

/// The dedicated resolve slot for the newest open session handoff in
/// this scope (S2). Best-effort: failures never break resolve.
fn handoff_block() -> Option<String> {
    let path = gzero::sections::default_ws_path();
    if !path.exists() {
        return None;
    }
    let ws = AutomergeStore::open(Some(&path)).ok()?;
    let project = gzero::repo_identity()?;
    let (me, _) = gzero::sessions::session_identity();
    let it = ws.open_handoff(&project).ok()??;
    if it.assignee == me {
        return None; // own handoff: the author doesn't need reminding
    }
    let first = it.design.lines().next().unwrap_or("").to_string();
    Some(format!(
        "\n\n## last session left a handoff\n- `{}` by session `{}`: {} — item_get for details; \
         close it once picked up",
        it.id, it.assignee, first
    ))
}

/// Heartbeat this session, sweep expired rows, and return an "also
/// here" block when other live sessions share this scope. Presence is
/// best-effort: failures never break resolve.
fn presence_block(store: &SqliteStore) -> Option<String> {
    let project = gzero::repo_identity()?;
    let (session_id, machine) = gzero::sessions::session_identity();
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let workspace = gzero::sessions::current_workspace();
    let beat = gzero::sessions::SessionInfo {
        session_id: session_id.clone(),
        machine,
        scope: project.clone(),
        cwd,
        pid: std::process::id() as i64,
        label: String::new(),
        workspace,
        started_at: 0, // ignored by the upsert on conflict
        last_seen: gzero::sessions::now(),
    };
    store.heartbeat(&beat).ok()?;
    store.sweep_sessions(gzero::PRESENCE_TTL_SECS).ok()?;
    let peers = store
        .active_peers(&project, &session_id, gzero::PRESENCE_TTL_SECS)
        .ok()?;
    if peers.is_empty() {
        return None;
    }
    let ago = |seen: i64| {
        let m = (gzero::sessions::now() - seen) / 60;
        if m < 1 {
            "<1m".to_string()
        } else {
            format!("{m}m")
        }
    };
    let mut out = format!(
        "\n\n## also here\n{} other session{} active in this scope:\n",
        peers.len(),
        if peers.len() == 1 { "" } else { "s" }
    );
    for p in peers.iter().take(5) {
        out.push_str(&format!(
            "- `{}` — {} on {}, last seen {} ago\n",
            &p.session_id[..p.session_id.len().min(8)],
            p.cwd,
            p.machine,
            ago(p.last_seen)
        ));
    }
    Some(out)
}

/// Pinned open items ride in resolve output (W3): the user's explicit
/// "put task X in my context". Only explicitly pinned items appear,
/// so the block never floods; `plan_next` serves the on-demand view.
fn pinned_block() -> Option<String> {
    let project = gzero::repo_identity()?;
    let path = gzero::sections::default_ws_path();
    if !path.exists() {
        return None;
    }
    let ws = AutomergeStore::open(Some(&path)).ok()?;
    let open: Vec<_> = ws
        .item_pinned(&project)
        .ok()?
        .into_iter()
        .filter(|it| it.is_open())
        .collect();
    if open.is_empty() {
        return None;
    }
    let mut out = String::from("\n\n## pinned tasks\n");
    for it in open.iter().take(8) {
        out.push_str(&format!(
            "- [{}] {} (p{}, {})\n",
            it.id,
            it.title,
            it.priority,
            it.status.as_str()
        ));
    }
    Some(out)
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
    Ok(gzero::alive(store)
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

/// The work guard over MCP: claim / park / release the current repo.
/// Same semantics as the CLI; the agent guards itself the same way the
/// user does. A parked claim must be verified against fresh context
/// before being treated as active.
fn tool_park_claim(args: &serde_json::Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|a| a.as_str())
        .unwrap_or("claim");
    let note = args.get("note").and_then(|n| n.as_str()).unwrap_or("");
    let mut ws = ws_store()?;
    let scope = gzero::repo_identity().unwrap_or_else(|| "global".to_string());
    let it = match action {
        "claim" => ws.claim_repo(&scope, note).map_err(|e| e.to_string())?,
        "park" => ws.park_repo(&scope, note).map_err(|e| e.to_string())?,
        "release" => ws.release_repo(&scope, note).map_err(|e| e.to_string())?,
        other => {
            return Err(format!(
                "park_claim: unknown action {other:?} (claim|park|release)"
            ))
        }
    };
    Ok(format!(
        "{}: {} [{}] {}\nPinned item rides in resolve for every session in this scope.",
        action,
        it.id,
        it.status.as_str(),
        it.title
    ))
}

fn tool_harvest(args: &serde_json::Value, store: &mut SqliteStore) -> Result<String, String> {
    let dir = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => std::path::PathBuf::from(p),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let results = gzero::harvest_dir(store, &dir).map_err(|e| e.to_string())?;
    if results.is_empty() {
        return Ok(format!(
            "(no instruction files found: {})",
            gzero::HARVEST_FILES.join(", ")
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
                    gzero::repo_identity().unwrap_or_else(|| FALLBACK_SCOPE.to_string())
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
        let closest = gzero::closest_matches(store, needle, 3).map_err(|e| e.to_string())?;
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

// ---- work items (plan3 W2) ----

fn str_list(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        Some(serde_json::Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

fn item_id_arg(
    args: &serde_json::Value,
    store: &AutomergeStore,
    tool: &str,
) -> Result<(String, String), String> {
    let scope = ws_scope_arg(args);
    let arg = args
        .get("id")
        .and_then(|i| i.as_str())
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or(format!("{tool}: id is required"))?
        .to_string();
    let id = store
        .item_resolve(&scope, &arg)
        .map_err(|e| e.to_string())?;
    Ok((scope, id))
}

fn item_json(it: &WorkItem) -> serde_json::Value {
    serde_json::json!({
        "scope": it.scope, "id": it.id, "title": it.title,
        "priority": it.priority, "status": it.status.as_str(),
        "assignee": it.assignee, "created": it.created,
        "order": it.order, "closed_at": it.closed_at,
        "labels": it.labels.iter().collect::<Vec<_>>(),
        "notes": it.notes,
        "blocks": it.blocks.iter().collect::<Vec<_>>(),
        "child_of": it.child_of.iter().collect::<Vec<_>>(),
        "discovered_from": it.discovered_from.iter().collect::<Vec<_>>(),
        "gate": it.gate, "gate_met": it.gate_met,
    })
}

/// Open blockers per item, keyed by id, from the full item list.
fn open_blockers(it: &WorkItem, all: &[WorkItem]) -> Vec<String> {
    all.iter()
        .filter(|o| o.blocks.contains(&it.id) && o.status != Status::Closed)
        .map(|o| o.id.clone())
        .collect()
}

fn tool_item_add(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let title = args
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("item_add: title is required")?
        .to_string();
    let n = gzero::items::NewItem {
        title,
        priority: args.get("priority").and_then(|p| p.as_i64()).unwrap_or(0),
        assignee: args
            .get("assignee")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string(),
        labels: str_list(args.get("labels")),
        blocks: str_list(args.get("blocks")),
        discovered_from: str_list(args.get("discovered_from")),
        child_of: str_list(args.get("child_of")),
        acceptance: args
            .get("acceptance")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string(),
        design: args
            .get("design")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string(),
        gate: args
            .get("gate")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let it = store.item_add(&scope, n).map_err(|e| e.to_string())?;
    Ok(format!("created {} {} \"{}\"", scope, it.id, it.title))
}

fn item_lines(scope: &str, items: &[WorkItem], all: &[WorkItem]) -> String {
    if items.is_empty() {
        return format!("(no items in {scope})");
    }
    items
        .iter()
        .map(|it| {
            let blocked: Vec<String> = all
                .iter()
                .filter(|o| o.blocks.contains(&it.id) && o.status != Status::Closed)
                .map(|o| o.id.clone())
                .collect();
            let b = if blocked.is_empty() {
                String::new()
            } else {
                format!(" (blocked by {})", blocked.join(", "))
            };
            format!(
                "{:<8} {:<12} p{:<3} {}{}",
                it.id,
                it.status.as_str(),
                it.priority,
                it.title,
                b
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Session handoff (S2): record what this session leaves for the next
/// one as a durable item, superseding any prior open handoff in the
/// scope. Author = this session's id.
fn tool_session_handoff(
    args: &serde_json::Value,
    store: &mut AutomergeStore,
) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("session_handoff: text is required")?;
    let (author, _) = gzero::sessions::session_identity();
    let it = store
        .create_handoff(&scope, &author, text)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "handoff recorded: {} [{}] — the next session in this scope sees it in resolve; \
         superseded any prior open handoff",
        it.id, scope
    ))
}

/// msg_send (S3): one-to-one conversation between sessions. Sender =
/// this session's id. Ephemeral: expires by TTL, never stored in the
/// store.
fn tool_msg_send(args: &serde_json::Value, store: &SqliteStore) -> Result<String, String> {
    let to = args
        .get("to")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("msg_send: 'to' (recipient session id) is required")?;
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("msg_send: text is required")?;
    let (me, _) = gzero::sessions::session_identity();
    let m = store
        .send_message(to, &me, text)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "message {} sent to {} — their next resolve shows it; expires in 7 days",
        m.id, m.dest
    ))
}

/// msg_read (S3): drain this session's unread messages (marks them
/// read).
fn tool_msg_read(store: &SqliteStore) -> Result<String, String> {
    let (me, _) = gzero::sessions::session_identity();
    let unread = store.unread_messages(&me).map_err(|e| e.to_string())?;
    if unread.is_empty() {
        return Ok("no unread messages".to_string());
    }
    let mut out = format!("{} unread message(s):\n", unread.len());
    for m in unread.iter().take(10) {
        out.push_str(&format!("- [{}] from `{}`: {}\n", m.id, m.sender, m.text));
    }
    store.mark_messages_read(&me).map_err(|e| e.to_string())?;
    out.push_str("marked read; reply with msg_send {to, text}");
    Ok(out)
}

/// broadcast (S3b): post to the shared board. One-to-all, information
/// not demand; sessions see it once (drained per-session).
fn tool_broadcast(args: &serde_json::Value, store: &SqliteStore) -> Result<String, String> {
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("broadcast: text is required")?;
    let (me, _) = gzero::sessions::session_identity();
    let b = store.post_broadcast(&me, text).map_err(|e| e.to_string())?;
    Ok(format!(
        "broadcast {} posted — sessions see it once in resolve; expires in 7 days",
        b.id
    ))
}

fn tool_item_list(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let mut items = store.item_list(&scope).map_err(|e| e.to_string())?;
    items.sort_by(|a, b| {
        let rank = |it: &WorkItem| if it.status == Status::Closed { 1 } else { 0 };
        rank(a)
            .cmp(&rank(b))
            .then(b.priority.cmp(&a.priority))
            .then(a.id.cmp(&b.id))
    });
    let all = items.clone();
    if args.get("json").and_then(|v| v.as_bool()).unwrap_or(false) {
        let arr: Vec<_> = items
            .iter()
            .map(|it| {
                let mut o = item_json(it);
                o["blocked_by"] = serde_json::json!(open_blockers(it, &all));
                o
            })
            .collect();
        return Ok(serde_json::to_string_pretty(&arr).unwrap());
    }
    Ok(item_lines(&scope, &items, &all))
}

fn tool_item_ready(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let ready = store.item_ready(&scope).map_err(|e| e.to_string())?;
    Ok(item_lines(&scope, &ready, &[]))
}

fn tool_item_pin(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("item_pin: missing id")?;
    let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(true);
    let scope = ws_scope_arg(args);
    let it = store
        .item_pin(&scope, id, pinned)
        .map_err(|e| e.to_string())?;
    Ok(if pinned {
        format!(
            "pinned {} — it now rides in resolve output until unpinned or closed",
            it.id
        )
    } else {
        format!("unpinned {}", it.id)
    })
}

fn tool_plan_next(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let scope = ws_scope_arg(args);
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    let json = args.get("json").and_then(|v| v.as_bool()).unwrap_or(false);
    let ranked = store
        .item_plan_next(&scope, limit)
        .map_err(|e| e.to_string())?;
    if ranked.is_empty() {
        return Ok(format!("nothing ready: no open unblocked items in {scope}"));
    }
    if json {
        let arr: Vec<_> = ranked
            .iter()
            .map(|r| {
                let mut o = item_json(&r.item);
                o["score"] = serde_json::json!(r.score);
                o["why"] = serde_json::json!(r.why);
                o
            })
            .collect();
        return Ok(serde_json::to_string_pretty(&arr).unwrap());
    }
    let mut out = format!("next up in {scope} — top ready items, ranked:\n");
    for r in &ranked {
        out.push_str(&format!(
            "- {} {} (p{}, {}) — {}\n",
            r.item.id,
            r.item.title,
            r.item.priority,
            r.item.status.as_str(),
            r.why.join(" · ")
        ));
    }
    Ok(out)
}

fn tool_item_gate(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("item_gate: missing id")?;
    let scope = ws_scope_arg(args);
    let gate = args.get("gate").and_then(|v| v.as_str());
    let met = args.get("met").and_then(|v| v.as_bool());
    if gate.is_none() && met.is_none() {
        return Err("item_gate: provide 'gate' (description) and/or 'met'".into());
    }
    let it = store
        .item_gate(&scope, id, gate, met)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{}: gate={} met={}",
        it.id,
        if it.gate.is_empty() {
            "(none)"
        } else {
            &it.gate
        },
        it.gate_met
    ))
}

fn tool_item_move(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let (scope, id) = item_id_arg(args, store, "item_move")?;
    let rel = args
        .get("rel")
        .and_then(|v| v.as_str())
        .ok_or("item_move: rel is required (top|bottom|before|after)")?;
    let target = match rel {
        "top" => MoveTarget::Top,
        "bottom" => MoveTarget::Bottom,
        "before" => MoveTarget::Before(
            args.get("sibling")
                .and_then(|v| v.as_str())
                .ok_or("item_move: sibling is required for before/after")?
                .to_string(),
        ),
        "after" => MoveTarget::After(
            args.get("sibling")
                .and_then(|v| v.as_str())
                .ok_or("item_move: sibling is required for before/after")?
                .to_string(),
        ),
        other => {
            return Err(format!(
                "item_move: rel must be top|bottom|before|after, got {other:?}"
            ))
        }
    };
    let it = store
        .item_move(&scope, &id, target)
        .map_err(|e| e.to_string())?;
    Ok(format!("moved {} [{}] in queue", it.id, it.title))
}

/// Session presence rows as JSON (S1) — inspection and sibling detection.
fn tool_sessions(store: &SqliteStore) -> Result<String, String> {
    let rows = store.all_sessions().map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&rows).unwrap_or_else(|e| format!("sessions: {e}")))
}

/// The repo identity used to scope project-tier data, so script/TS
/// clients can match scopes exactly without duplicating normalization.
fn tool_scope() -> Result<String, String> {
    match gzero::repo_identity() {
        Some(id) => Ok(id),
        None => Err("scope: not in a git repository".into()),
    }
}

fn tool_item_get(args: &serde_json::Value, store: &AutomergeStore) -> Result<String, String> {
    let (scope, id) = item_id_arg(args, store, "item_get")?;
    match store.item_get(&scope, &id).map_err(|e| e.to_string())? {
        Some(it) => Ok(serde_json::to_string_pretty(&item_json(&it)).unwrap()),
        None => Err(format!("item_get: no item {id:?} in {scope:?}")),
    }
}

fn tool_item_edit(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let (scope, id) = {
        let store: &AutomergeStore = store;
        item_id_arg(args, store, "item_edit")?
    };
    let status = match args.get("status").and_then(|s| s.as_str()) {
        Some(s) => Some(
            gzero::items::Status::parse(s)
                .ok_or("item_edit: status must be open|in_progress|closed")?,
        ),
        None => None,
    };
    let edit = gzero::items::ItemEdit {
        title: args.get("title").and_then(|t| t.as_str()).map(String::from),
        priority: args.get("priority").and_then(|p| p.as_i64()),
        assignee: args
            .get("assignee")
            .and_then(|a| a.as_str())
            .map(String::from),
        design: args
            .get("design")
            .and_then(|d| d.as_str())
            .map(String::from),
        acceptance: args
            .get("acceptance")
            .and_then(|a| a.as_str())
            .map(String::from),
        status,
        gate: args.get("gate").and_then(|g| g.as_str()).map(String::from),
        gate_met: args.get("gate_met").and_then(|m| m.as_bool()),
    };
    let it = store
        .item_edit(&scope, &id, edit)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "edited {} [{}] -> {}",
        it.id,
        it.title,
        it.status.as_str()
    ))
}

fn tool_item_note(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let (scope, id) = {
        let store: &AutomergeStore = store;
        item_id_arg(args, store, "item_note")?
    };
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("item_note: text is required")?;
    let nid = store
        .item_note(&scope, &id, text)
        .map_err(|e| e.to_string())?;
    Ok(format!("noted {scope}/{id} [{nid}]"))
}

fn tool_item_delete(
    args: &serde_json::Value,
    store: &mut AutomergeStore,
) -> Result<String, String> {
    let (scope, id) = {
        let store: &AutomergeStore = store;
        item_id_arg(args, store, "item_delete")?
    };
    if store.item_delete(&scope, &id).map_err(|e| e.to_string())? {
        Ok(format!("deleted {scope}/{id}"))
    } else {
        Err(format!("item_delete: no item {id:?} in {scope:?}"))
    }
}

// ---- workflow sections (plan3 W1) ----

/// The ws doc, opened per call (sections are infrequent; D1 unifies stores).
fn ws_store() -> Result<AutomergeStore, String> {
    let path = gzero::sections::default_ws_path();
    AutomergeStore::open(Some(&path)).map_err(|e| format!("ws: open {}: {e}", path.display()))
}

fn ws_scope_arg(args: &serde_json::Value) -> String {
    args.get("scope")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| gzero::repo_identity().unwrap_or_else(|| "global".to_string()))
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
        Some(s) => {
            if args.get("json").and_then(|v| v.as_bool()).unwrap_or(false) {
                return Ok(serde_json::to_string_pretty(&serde_json::json!({
                    "scope": s.scope, "name": s.name, "kind": s.kind.as_str(),
                    "title": s.title, "body": s.body, "order": s.order,
                }))
                .unwrap());
            }
            Ok(s.body)
        }
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
    if args.get("json").and_then(|v| v.as_bool()).unwrap_or(false) {
        let arr: Vec<_> = items
            .iter()
            .map(|s| {
                serde_json::json!({
                    "scope": s.scope, "name": s.name, "kind": s.kind.as_str(),
                    "title": s.title, "order": s.order,
                })
            })
            .collect();
        return Ok(serde_json::to_string_pretty(&arr).unwrap());
    }
    Ok(items
        .into_iter()
        .map(|s| {
            let prog = if s.kind == SectionKind::Checklist {
                let (d, t) = gzero::sections::checklist_progress(&s.body);
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

fn tool_ws_ensure(args: &serde_json::Value, store: &mut AutomergeStore) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("ws_ensure: name is required")?;
    let scope = ws_scope_arg(args);
    let created = store
        .section_ensure(&scope, name)
        .map_err(|e| e.to_string())?;
    Ok(if created {
        format!("ensured namespace {scope}/{name}")
    } else {
        format!("namespace {scope}/{name} already exists")
    })
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
          "description": "Browse instead of resolve: return ALL atoms whose scope starts with this prefix, ignoring tier defaults (empty string = the whole store). For inspection UIs, not for pulling task context."
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
    "name": "park_claim",
    "description": "The work guard: claim the current repo while working on it, park when stepping away (claimed for now — but verify context freshness before treating a parked claim as active), release when done or verified stale. The pinned claim item rides in resolve for every session in this scope, so forgetful sessions cannot clobber in-flight work unnoticed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["claim", "park", "release"], "description": "Default claim." },
        "note": { "type": "string", "description": "Optional: what you're working on / why parked / why released." }
      }
    }
  },
  {
    "name": "harvest",
    "description": "Import agent-instruction files from the repo into gzero as project context — instructions written for ANY agent (AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md) become one shared store, injected automatically in that repo from then on. NOTE: this runs automatically at server startup — changes to those files are detected by content hash and mirrored without anyone calling this. Call it only to pick up mid-session edits immediately. Files with no bullets are skipped (pointer stubs are protected). Optional 'path' defaults to the current directory.",
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
    "description": "Read one workflow section body verbatim. Checklists keep their '- [ ]'/'- [x]' lines. json=true returns the full section (name, kind, title, body, order) as JSON.",
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
    "name": "ws_ensure",
    "description": "Create the namespace chain for a dotted section name without content — mkdir -p for the section hierarchy. 'a.b.c' creates containers a, a.b, a.b.c; sections can then be put under any level. Idempotent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "Dotted namespace path, e.g. 'docs.tech-debt.cas-document-system'." },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["name"]
    }
  },
  {
    "name": "ws_list",
    "description": "List workflow sections for a scope: one line each — name, kind, title, and done/total for checklists. Dotted names nest; bare ancestors are containers, not sections. json=true returns them as a JSON array.",
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
  },
  {
    "name": "item_add",
    "description": "Create a work item (task/bug/epic) for this project. Starts open. Optional: 'priority' (higher = more important), 'labels', 'blocks' (ids this item blocks), 'child_of' (parent id), 'discovered_from', 'design' and 'acceptance' (markdown text). Ids may be given as unique prefixes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "priority": { "type": "integer" },
        "assignee": { "type": "string" },
        "labels": { "type": "string", "description": "Comma-separated or array." },
        "blocks": { "type": "string" },
        "child_of": { "type": "string" },
        "discovered_from": { "type": "string" },
        "design": { "type": "string" },
        "acceptance": { "type": "string" },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["title"]
    }
  },
  {
    "name": "item_list",
    "description": "List work items for the current project: open first, then by priority. Lines show id, status, priority, title, and open blockers. json=true returns the full items as a JSON array.",
    "inputSchema": { "type": "object", "properties": { "scope": { "type": "string" }, "json": { "type": "boolean", "description": "Return the full items as a JSON array instead of lines." } } }
  },
  {
    "name": "item_move",
    "description": "Move a work item within the scope's display queue: 'top', 'bottom', or before/after a sibling item id.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "rel": { "type": "string", "enum": ["top", "bottom", "before", "after"] },
        "sibling": { "type": "string", "description": "Required for before/after." },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["id", "rel"]
    }
  },
  {
    "name": "sessions",
    "description": "Session presence rows as JSON (S1 inspection): every session seen in any scope, stale included. Rows carry session_id, scope, workspace, last_seen.",
    "inputSchema": { "type": "object", "properties": {} }
  },
  {
    "name": "scope",
    "description": "Print the repo identity used to scope project-tier data, so script/TS clients can match scopes exactly. Errors outside a git repository.",
    "inputSchema": { "type": "object", "properties": {} }
  },
  {
    "name": "item_ready",
    "description": "The ready fold: open work items with no open blockers, ranked by priority. Use to pick the next thing to do.",
    "inputSchema": { "type": "object", "properties": { "scope": { "type": "string" } } }
  },
  {
    "name": "item_pin",
    "description": "Pin or unpin a work item. Pinned open items render into every resolve call (the user's 'put task X in my context'); unpin when done. Nothing is pinned automatically.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "pinned": { "type": "boolean", "description": "Default true; false unpins." },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["id"]
    }
  },
  {
    "name": "plan_next",
    "description": "What's next: top ready work items for this project, ranked, each with evidence (unblocked, priority, labels, notes, subtasks). Use at task start or when the user asks what's next.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": { "type": "integer", "description": "Default 5, max 20." },
        "scope": { "type": "string", "description": "Omit for the current project." }
      }
    }
  },
  {
    "name": "msg_send",
    "description": "Send a short message to another session in this repo (S3): conversation, not memory — ephemeral, expires in 7 days, never stored in the durable store. 'to' is the recipient session id (see the 'also here' presence block for who is active; sibling sessions show their session id). Their next resolve shows it; msg_read drains.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "to": { "type": "string", "description": "Recipient session id." },
        "text": { "type": "string", "description": "The message. Keep it conversational and short." }
      },
      "required": ["to", "text"]
    }
  },
  {
    "name": "msg_read",
    "description": "Read (and mark read) this session's unread messages from other sessions. Resolve already shows unread counts; use this to drain them.",
    "inputSchema": { "type": "object", "properties": {} }
  },
  {
    "name": "broadcast",
    "description": "Post to the shared broadcast board (S3b): one-to-all, information not demand — state of the world any session can read ('deploys paused until 5pm'). Ephemeral (7-day TTL); sessions see each broadcast once in resolve, drained per-session.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "The broadcast. Informational, no action required." }
      },
      "required": ["text"]
    }
  },
  {
    "name": "session_handoff",
    "description": "Record a session handoff (S2): what this session leaves for the next one in this repo — summary, open threads, next steps. Creates a durable item the next session sees in resolve; supersedes any prior open handoff (history stays append-only). Call at session end or when handing work to a sibling session; the next session acknowledges by closing the handoff once picked up.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "The handoff: what was done, what's open, what's next."
        },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["text"]
    }
  },
    {
    "name": "item_gate",
    "description": "Set or satisfy an item's gate (W4): 'gate' is what must pass before the item can close; 'met' true/false records that it passed. Closing is refused while a gate is set and unmet.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "gate": { "type": "string", "description": "Set the gate description." },
        "met": { "type": "boolean", "description": "Mark the gate met/unmet." },
        "scope": { "type": "string", "description": "Omit for the current project." }
      },
      "required": ["id"]
    }
  },
  {
    "name": "item_get",
    "description": "Read one work item in full: fields, labels, notes, edges. Ids may be unique prefixes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "scope": { "type": "string" }
      },
      "required": ["id"]
    }
  },
  {
    "name": "item_edit",
    "description": "Edit a work item's fields. 'status' transitions: open -> in_progress -> closed; closed -> open reopens. Illegal transitions (closed -> in_progress) error.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "title": { "type": "string" },
        "priority": { "type": "integer" },
        "assignee": { "type": "string" },
        "status": { "type": "string", "enum": ["open", "in_progress", "closed"] },
        "design": { "type": "string" },
        "acceptance": { "type": "string" },
        "scope": { "type": "string" }
      },
      "required": ["id"]
    }
  },
  {
    "name": "item_note",
    "description": "Append a note to a work item. Notes are append-only and id-keyed — history, not edits.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "text": { "type": "string" },
        "scope": { "type": "string" }
      },
      "required": ["id", "text"]
    }
  },
  {
    "name": "item_delete",
    "description": "Delete a work item. References to it in other items' edge sets remain but no longer block anything.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "scope": { "type": "string" }
      },
      "required": ["id"]
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
        let dir = std::env::temp_dir().join("gzero-harvest-mcp");
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
    fn item_full_lifecycle_via_tools() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let reply =
            tool_item_add(&json!({"title": "fix the gate", "priority": 2}), &mut s).unwrap();
        assert!(reply.contains("created"), "{reply}");
        // prefix resolution from the reply's id
        let id = reply.split_whitespace().nth(2).unwrap().to_string();
        tool_item_add(&json!({"title": "epic", "child_of": &id}), &mut s).unwrap();
        let list = tool_item_list(&json!({}), &s).unwrap();
        assert!(list.contains("fix the gate") && list.contains("epic"));
        tool_item_edit(&json!({"id": &id, "status": "in_progress"}), &mut s).unwrap();
        assert!(tool_item_list(&json!({}), &s)
            .unwrap()
            .contains("in_progress"));
        tool_item_note(&json!({"id": &id, "text": "started"}), &mut s).unwrap();
        let full = tool_item_get(&json!({"id": &id}), &s).unwrap();
        assert!(full.contains("started") && full.contains("in_progress"));
        // blocked sibling: ready fold excludes it
        let kid = tool_item_add(&json!({"title": "kid", "blocks": &id}), &mut s).unwrap();
        let kid_id = kid.split_whitespace().nth(2).unwrap().to_string();
        let ready = tool_item_ready(&json!({}), &s).unwrap();
        assert!(!ready.contains(&id), "blocked item must not be ready");
        assert!(ready.contains(&kid_id));
        // once the blocker closes, the claimed item becomes ready
        tool_item_edit(&json!({"id": &kid_id, "status": "closed"}), &mut s).unwrap();
        assert!(tool_item_ready(&json!({}), &s).unwrap().contains(&id));
        tool_item_edit(&json!({"id": &id, "status": "closed"}), &mut s).unwrap();
        // illegal transition
        assert!(tool_item_edit(&json!({"id": &id, "status": "in_progress"}), &mut s).is_err());
        assert!(tool_item_delete(&json!({"id": &id}), &mut s)
            .unwrap()
            .contains("deleted"));
    }

    #[test]
    fn item_validation_errors() {
        let mut s = AutomergeStore::in_memory().unwrap();
        assert!(tool_item_add(&json!({"title": "  "}), &mut s).is_err());
        assert!(tool_item_get(&json!({"id": "zz"}), &s).is_err());
        assert!(tool_item_note(&json!({"id": "zz", "text": "x"}), &mut s).is_err());
        assert!(tool_item_delete(&json!({"id": "zz"}), &mut s).is_err());
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
