//! `cx` — the context bag CLI.
//!
//! `cx`                 print default context (untagged atoms)
//! `cx #tag ...`        default plus tagged atoms
//! `cx add file.md ...` import markdown into the bag (per-source sync)
//! `cx harvest [dir]`   import agent-instruction files (AGENTS.md, CLAUDE.md, …)
//! `cx sources`         per-source assertion counts
//! `cx rm <needle>`     remove atoms whose text contains needle
//! `cx rm-source <src>`  remove a whole source (tombstoned)
//! `cx tags`            tag vocabulary with counts

use std::collections::{BTreeMap, BTreeSet};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::exit;

use contextual::hub::{events_for_snapshot, Event, Hub};
use contextual::items::{EdgeKind, ItemEdit, MoveTarget, NewItem, Status, WorkItem};
use contextual::sections::{checklist_progress, Section, SectionKind};
use contextual::snapshot::Atom;
use contextual::{source_counts, tag_counts, AutomergeStore, ChangeFeed, SqliteStore, Storage};

/// Post events to the hub if configured; warn (don't fail) otherwise.
fn try_post_events(events: &[Event]) {
    if events.is_empty() {
        return;
    }
    if let Some(hub) = Hub::from_env() {
        if let Err(e) = hub.post_events(events) {
            eprintln!("cx: hub push failed: {e}");
        }
    }
}

/// Atoms in the resolved view matching a needle, as full atoms for events.
fn matched_atoms(store: &dyn Storage, needle: &str) -> Vec<Atom> {
    match contextual::alive(store) {
        Ok(items) => items
            .into_iter()
            .filter(|(text, _)| text.contains(needle))
            .map(|(text, r)| Atom {
                text,
                scope: r.scope,
                node: r.node,
                tags: r.tags,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

const USAGE: &str = "cx — context bag
cx                default context (untagged atoms)
cx #tag ...       default plus tagged atoms
cx add file.md    import context markdown (per-source sync; re-run after edits)
cx harvest [dir]  import agent-instruction files (AGENTS.md, CLAUDE.md, GEMINI.md,
                  .cursorrules, .windsurfrules, copilot-instructions) as project context
cx export file    write this machine's snapshot (merge unit)
cx absorb file... merge other machines' snapshots into this bag
cx pull           fetch merged snapshot from the hub (CX_HUB_URL) and absorb
cx push           post this bag's atoms + tombstones to the hub as events
cx sources        per-source assertion counts
cx rm <needle>    remove matching atoms (records tombstones)
cx rm-source <s>  remove one whole source (tombstoned; substring must match exactly one)
cx tags           tag vocabulary with counts
cx ws list        workflow sections for this project (vision, plan, checklists, ...)
cx ws show <name>          print one section (checklists render with boxes + count)
cx ws set <name> [--title T] [--type md|checklist] [--order N]
                 [--body TEXT | --file F]   create or update a section
                 (body also read from stdin when piped; omit to edit metadata only)
cx ws rm <name>   delete a section
cx ws scopes      list scopes that have sections
cx item add \"<title>\"      create a work item [--labels a,b] [--priority N]
                 [--child-of ID] [--blocks ID] [--design TEXT | --design-file F]
                 [--acceptance TEXT]
cx item list [--json]      all items: id, status, priority, title, blocked
cx item ready [--json]     the fold: open items with no open blockers, ranked
cx item pin|unpin <id>     pin = rides in injected context (resolve) until done
cx item show <id> [--json] full item incl. notes
cx item edit <id> [--title T] [--priority N] [--assignee A]
                 [--design TEXT | --design-file F] [--status open|in_progress|closed]
cx item claim <id> / close <id> / reopen <id>
cx item note <id> \"<text>\" append a note (append-only)
cx item gate <id> [--met|--unmet] [\"text\"]  set/satisfy the close gate
cx item label <id> add|rm <label>
cx item edge <id> add|rm blocks|child-of|discovered-from <target>
cx item rm <id>   delete an item
cx watch          stream ws-doc change events (items/sections) as JSON lines
                  until the reader hangs up; polls the doc file (3cd4)
cx sessions       session presence rows (stale marked; S1 inspection)
env: CX_DB        bag location (default ~/.pi/agent/context.db)
env: CX_WS_DB     workflow doc: sections + items (default ~/.pi/agent/context.ws)";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        if args.is_empty() && bag_path().exists() {
            show(&BTreeSet::new());
            return;
        }
        println!("{USAGE}");
        return;
    }
    match args[0].as_str() {
        "watch" => {
            // Stream ws-doc change events as JSON lines (work item
            // 3cd4). Polls the doc file's mtime — cheap, and the
            // semantic events still give per-item granularity. Exits
            // when the reader hangs up (EPIPE): the client is gone.
            watch_loop();
        }
        "scope" => {
            // Print the repo identity used to scope project-tier data —
            // lets script/TS clients match scopes exactly.
            match contextual::repo_identity() {
                Some(id) => println!("{id}"),
                None => {
                    eprintln!("cx: not in a git repository");
                    exit(1);
                }
            }
        }
        "sessions" => {
            // Inspection view for S1 presence: all rows, stale marked.
            let store = open_store();
            let rows = store.all_sessions().unwrap_or_else(|e| panic!("cx: {e}"));
            if args.iter().any(|a| a == "--json") {
                println!(
                    "{}",
                    serde_json::to_string(&rows).unwrap_or_else(|e| panic!("cx: {e}"))
                );
                return;
            }
            let (me, _) = contextual::sessions::session_identity();
            if rows.is_empty() {
                println!("no sessions on record");
                return;
            }
            for s in rows {
                let stale =
                    contextual::sessions::now() - s.last_seen > contextual::PRESENCE_TTL_SECS;
                let marker = if s.session_id == me {
                    " (me)"
                } else if stale {
                    " (stale)"
                } else {
                    ""
                };
                let m = (contextual::sessions::now() - s.last_seen) / 60;
                println!(
                    "{}{}  {}  {}  seen {}m ago",
                    &s.session_id[..s.session_id.len().min(12)],
                    marker,
                    s.scope,
                    if s.cwd.is_empty() { "?" } else { &s.cwd },
                    m
                );
            }
        }
        "add" => {
            if args.len() < 2 {
                eprintln!("usage: cx add file.md ...");
                exit(2);
            }
            let mut store = open_store();
            for f in &args[1..] {
                let text = std::fs::read_to_string(f).unwrap_or_else(|e| panic!("cx: {}: {e}", f));
                let source = source_path(Path::new(f));
                let stats = contextual::add_doc(&mut store, &source, &text)
                    .unwrap_or_else(|e| panic!("cx: {e}"));
                println!(
                    "{f}: +{} -{} ={} (kept {})",
                    stats.added, stats.removed, stats.kept, stats.kept
                );
                // Post only what this sync added (idempotent on the hub).
                let events: Vec<Event> = contextual::parse(&text)
                    .into_iter()
                    .map(|a| Event::Put {
                        atom: Atom {
                            text: a.text,
                            scope: a.scope,
                            node: a.node,
                            tags: a.tags,
                        },
                    })
                    .collect();
                try_post_events(&events);
            }
        }
        "pull" => {
            let hub = Hub::from_env().unwrap_or_else(|| {
                eprintln!("cx pull: set CX_HUB_URL and CX_TOKEN");
                exit(2);
            });
            let mut store = open_store();
            let snap = hub
                .fetch_snapshot()
                .unwrap_or_else(|e| panic!("cx pull: {e}"));
            let stats = contextual::absorb_snapshot(&mut store, "hub", &snap)
                .unwrap_or_else(|e| panic!("cx: {e}"));
            println!(
                "hub: +{} -{} kept {} ({} tombstones)",
                stats.added,
                stats.removed,
                stats.kept,
                snap.tombstones.len()
            );
        }
        "push" => {
            let hub = Hub::from_env().unwrap_or_else(|| {
                eprintln!("cx push: set CX_HUB_URL and CX_TOKEN");
                exit(2);
            });
            let store = open_store();
            let snap = contextual::export_snapshot(&store).unwrap_or_else(|e| panic!("cx: {e}"));
            hub.post_events(&events_for_snapshot(&snap))
                .unwrap_or_else(|e| panic!("cx push: {e}"));
            println!(
                "pushed {} atoms, {} tombstones to hub",
                snap.atoms.len(),
                snap.tombstones.len()
            );
        }
        "export" => {
            if args.len() != 2 {
                eprintln!("usage: cx export <file>");
                exit(2);
            }
            let store = open_store();
            let snap = contextual::export_snapshot(&store).unwrap_or_else(|e| panic!("cx: {e}"));
            let bytes = snap.to_json().unwrap_or_else(|e| panic!("cx: {e}"));
            std::fs::write(&args[1], bytes).unwrap_or_else(|e| panic!("cx: {}: {e}", args[1]));
            println!(
                "exported {} atoms, {} tombstones -> {}",
                snap.atoms.len(),
                snap.tombstones.len(),
                args[1]
            );
        }
        "absorb" => {
            if args.len() < 2 {
                eprintln!("usage: cx absorb <file>...");
                exit(2);
            }
            let mut store = open_store();
            for f in &args[1..] {
                let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("cx: {}: {e}", f));
                let snap = contextual::snapshot::Snapshot::from_json(&bytes)
                    .unwrap_or_else(|e| panic!("cx: {f}: {e}"));
                let source = source_path(Path::new(f));
                let stats = contextual::absorb_snapshot(&mut store, &source, &snap)
                    .unwrap_or_else(|e| panic!("cx: {e}"));
                println!(
                    "{f}: +{} -{} kept {} ({} tombstones)",
                    stats.added,
                    stats.removed,
                    stats.kept,
                    snap.tombstones.len()
                );
            }
        }
        "sources" => {
            let store = open_store();
            for (source, n) in source_counts(&store).unwrap_or_else(|e| panic!("cx: {e}")) {
                println!("{n}\t{source}");
            }
        }
        "rm" => {
            if args.len() < 2 {
                eprintln!("usage: cx rm <needle>");
                exit(2);
            }
            let needle = args[1..].join(" ");
            let mut store = open_store();
            let victims = matched_atoms(&store, &needle);
            match store.remove_matching(&needle) {
                Ok(0) => println!("(no matches)"),
                Ok(n) => {
                    println!("removed {n}");
                    try_post_events(
                        &victims
                            .into_iter()
                            .map(|atom| Event::Remove { atom })
                            .collect::<Vec<_>>(),
                    );
                }
                Err(e) => panic!("cx: {e}"),
            }
        }
        "harvest" => {
            let flags: Vec<&String> = args[1..].iter().filter(|a| a.starts_with("--")).collect();
            let check = flags.iter().any(|f| f.as_str() == "--check");
            let take = flags.iter().any(|f| f.as_str() == "--take");
            let dir = match args[1..].iter().find(|a| !a.starts_with("--")) {
                Some(d) => PathBuf::from(d),
                None => std::env::current_dir().unwrap_or_else(|e| panic!("cx: {e}")),
            };
            let mut store = open_store();
            if check || take {
                let result = contextual::reconcile_harvest(&mut store, &dir, take)
                    .unwrap_or_else(|e| panic!("cx: harvest: {e}"));
                for r in &result.harvested {
                    match &r.stats {
                        None => println!("{}: no bullets — skipped", r.path.display()),
                        Some(s) => println!(
                            "{}: +{} -{} (kept {})",
                            r.path.display(),
                            s.added,
                            s.removed,
                            s.kept
                        ),
                    }
                }
                for p in &result.taken {
                    println!("{}: imported then deleted (--take)", p.display());
                }
                for p in &result.removed {
                    println!(
                        "{}: deleted since last harvest — source retracted",
                        p.display()
                    );
                }
                println!("{} unchanged", result.unchanged);
                // Hub events: Puts for re-imported atoms, Removes for retracted ones.
                let mut events: Vec<Event> = Vec::new();
                let put_texts: std::collections::BTreeSet<String> = result
                    .harvested
                    .iter()
                    .flat_map(|r| r.atoms.iter().map(|a| a.text.clone()))
                    .collect();
                for r in &result.harvested {
                    events.extend(r.atoms.iter().map(|a| Event::Put {
                        atom: Atom {
                            text: a.text.clone(),
                            scope: a.scope.clone(),
                            node: a.node.clone(),
                            tags: a.tags.clone(),
                        },
                    }));
                }
                for a in &result.retracted {
                    if !put_texts.contains(&a.text) {
                        events.push(Event::Remove { atom: a.clone() });
                    }
                }
                try_post_events(&events);
            } else {
                let results = contextual::harvest_dir(&mut store, &dir)
                    .unwrap_or_else(|e| panic!("cx: harvest: {e}"));
                if results.is_empty() {
                    println!(
                        "(no instruction files found: {})",
                        contextual::HARVEST_FILES.join(", ")
                    );
                }
                for r in results {
                    let rel = r
                        .path
                        .strip_prefix(&dir)
                        .unwrap_or(&r.path)
                        .display()
                        .to_string();
                    match r.stats {
                        None => {
                            println!("{rel}: no bullets — skipped (pointer stubs are protected)")
                        }
                        Some(s) => {
                            println!("{rel}: +{} -{} (kept {})", s.added, s.removed, s.kept);
                            let events: Vec<Event> = r
                                .atoms
                                .into_iter()
                                .map(|a| Event::Put {
                                    atom: Atom {
                                        text: a.text,
                                        scope: a.scope,
                                        node: a.node,
                                        tags: a.tags,
                                    },
                                })
                                .collect();
                            try_post_events(&events);
                        }
                    }
                }
            }
        }
        "rm-source" => {
            if args.len() < 2 {
                eprintln!("usage: cx rm-source <source>  (substring; must match one source)");
                exit(2);
            }
            let needle = args[1..].join(" ");
            let mut store = open_store();
            let sources: Vec<String> = source_counts(&store)
                .unwrap_or_else(|e| panic!("cx: {e}"))
                .into_iter()
                .map(|(s, _)| s)
                .filter(|s| s.contains(&needle))
                .collect();
            match sources.as_slice() {
                [source] => {
                    // Tombstone first so removal survives hub pulls; then
                    // drop the rows (sync with nothing = the source asserts nothing).
                    let victims: Vec<Atom> = store
                        .all()
                        .unwrap_or_else(|e| panic!("cx: {e}"))
                        .into_iter()
                        .filter(|r| r.source == *source)
                        .map(|r| Atom {
                            text: r.text,
                            scope: r.scope,
                            node: r.node,
                            tags: r.tags,
                        })
                        .collect();
                    store
                        .tombstone(&victims)
                        .unwrap_or_else(|e| panic!("cx: {e}"));
                    let stats = store
                        .sync_source(source, &[])
                        .unwrap_or_else(|e| panic!("cx: {e}"));
                    println!("{source}: removed {}", stats.removed);
                    try_post_events(
                        &victims
                            .into_iter()
                            .map(|atom| Event::Remove { atom })
                            .collect::<Vec<_>>(),
                    );
                }
                [] => {
                    eprintln!("cx: no source matches {needle:?}");
                    exit(1);
                }
                many => {
                    eprintln!("cx: {needle:?} is ambiguous:");
                    for s in many {
                        eprintln!("  {s}");
                    }
                    exit(1);
                }
            }
        }
        "tags" => {
            let store = open_store();
            for (tag, n) in tag_counts(&store).unwrap_or_else(|e| panic!("cx: {e}")) {
                println!("#{tag} {n}");
            }
        }
        "ws" => ws_command(&args[1..]),
        "item" => item_command(&args[1..]),
        "claim" | "park" | "release" => guard_command(&args),
        "recommend" => {
            eprintln!("cx: recommend is gone — packs were dissolved (tagged atoms replace them; see plan.md M4)");
            eprintln!("pull build/workflow conventions via: cx '#rust' / cx '#npm'");
            exit(2);
        }
        other => {
            let mut tags = BTreeSet::new();
            for arg in &args {
                match arg.strip_prefix('#') {
                    Some(t) if !t.is_empty() => {
                        tags.insert(t.to_ascii_lowercase());
                    }
                    _ => {
                        eprintln!("cx: unknown command or bad tag: {other}");
                        eprintln!("{USAGE}");
                        exit(2);
                    }
                }
            }
            show(&tags);
        }
    }
}

fn show(tags: &BTreeSet<String>) {
    let store = open_store();
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    let project = contextual::repo_identity();
    let items = contextual::resolve_tiers(&store, project.as_deref(), &refs)
        .unwrap_or_else(|e| panic!("cx: {e}"));
    if items.is_empty() {
        println!("(no matching context)");
        return;
    }
    let mut current = String::new();
    for (text, r) in items {
        let key = format!("{}/{}", r.scope, r.node);
        if key != current {
            println!("\n# {key}");
            current = key;
        }
        println!("- {text}");
    }
}

fn open_store() -> SqliteStore {
    SqliteStore::open(bag_path().to_str().unwrap_or("context.db"))
        .unwrap_or_else(|e| panic!("cx: open bag: {e}"))
}

fn bag_path() -> PathBuf {
    if let Ok(p) = std::env::var("CX_DB") {
        return PathBuf::from(p);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Path::new(&home).join(".pi/agent/context.db");
    }
    PathBuf::from("context.db")
}

/// Workflow sections (plan3 W1): keyed, typed documents for this
/// project, stored in the automerge doc (`CX_WS_DB`, default
/// `~/.pi/agent/context.ws`). Scope defaults to this repo's identity.
/// Split `--flag value` / `--json` flags from positional arguments.
fn split_args(args: &[String], cmd: &str) -> (BTreeMap<String, String>, Vec<String>) {
    split_args_bools(args, cmd, &["json"])
}

/// `bools` are valueless flags: `--met`, not `--met <value>`.
fn split_args_bools(
    args: &[String],
    cmd: &str,
    bools: &[&str],
) -> (BTreeMap<String, String>, Vec<String>) {
    let mut flags: BTreeMap<String, String> = BTreeMap::new();
    let mut pos: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].clone();
        if let Some(f) = a.strip_prefix("--") {
            if bools.contains(&f) {
                flags.insert(f.to_string(), String::new());
            } else {
                match args.get(i + 1) {
                    Some(v) => {
                        flags.insert(f.to_string(), v.clone());
                        i += 1;
                    }
                    None => {
                        eprintln!("cx: --{f} needs a value ({cmd})");
                        exit(2);
                    }
                }
            }
        } else {
            pos.push(a);
        }
        i += 1;
    }
    (flags, pos)
}

fn ws_command(args: &[String]) {
    let (flags, pos) = split_args(args, "ws");

    let json = flags.contains_key("json");
    let sub = pos.first().map(String::as_str).unwrap_or("help");
    match sub {
        "help" | "-h" | "--help" => println!("{USAGE}"),
        "scopes" => {
            let store = open_ws();
            let scopes = store
                .section_scopes()
                .unwrap_or_else(|e| panic!("cx ws: {e}"));
            for s in scopes {
                println!("{s}");
            }
        }
        "list" => {
            let scope = ws_scope(pos.get(1));
            let store = open_ws();
            let items = store
                .section_list(&scope)
                .unwrap_or_else(|e| panic!("cx ws: {e}"));
            if json {
                let arr: Vec<_> = items
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "name": s.name, "kind": s.kind.as_str(),
                            "title": s.title, "order": s.order,
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&arr).unwrap());
                return;
            }
            if items.is_empty() {
                println!("(no sections in {scope})");
                return;
            }
            for s in &items {
                let extra = if s.kind == SectionKind::Checklist {
                    let (d, t) = checklist_progress(&s.body);
                    format!(" {d}/{t}")
                } else {
                    String::new()
                };
                println!(
                    "{:<22} {:<10} {}{}",
                    s.name,
                    s.kind.as_str(),
                    s.title,
                    extra
                );
            }
        }
        "show" => {
            let name = ws_arg(&pos, 1, "show <name> [scope]");
            let scope = ws_scope(pos.get(2));
            let store = open_ws();
            let Some(s) = store
                .section_get(&scope, &name)
                .unwrap_or_else(|e| panic!("cx ws: {e}"))
            else {
                eprintln!("cx ws: no section {name:?} in {scope:?}");
                exit(1);
            };
            if json {
                println!("{}", serde_json::to_string_pretty(&ws_json(&s)).unwrap());
                return;
            }
            println!(
                "# {} ({})",
                if s.title.is_empty() {
                    &s.name
                } else {
                    &s.title
                },
                s.kind.as_str()
            );
            println!();
            if s.kind == SectionKind::Checklist {
                for line in s.body.lines() {
                    let indent_len = line.len() - line.trim_start().len();
                    let (indent, t) = line.split_at(indent_len);
                    if let Some(rest) = t.strip_prefix("- [ ] ") {
                        println!("{indent}\u{2610} {rest}");
                    } else if let Some(rest) = t
                        .strip_prefix("- [x] ")
                        .or_else(|| t.strip_prefix("- [X] "))
                    {
                        println!("{indent}\u{2611} {rest}");
                    } else {
                        println!("{line}");
                    }
                }
                let (d, t) = checklist_progress(&s.body);
                println!("\n({d}/{t} done)");
            } else {
                println!("{}", s.body);
            }
        }
        "set" => {
            let name = ws_arg(&pos, 1, "set <name> [scope] [--title T] [--type md|checklist] [--order N] [--body TEXT | --file F]");
            let scope = ws_scope(pos.get(2));
            let kind = match flags.get("type") {
                Some(t) => SectionKind::parse(t).unwrap_or_else(|| {
                    eprintln!("cx ws: --type must be md or checklist");
                    exit(2);
                }),
                None => {
                    let store = open_ws();
                    store
                        .section_get(&scope, &name)
                        .unwrap_or_else(|e| panic!("cx ws: {e}"))
                        .map_or(SectionKind::Md, |s| s.kind)
                }
            };
            let mut store = open_ws();
            let existing = store
                .section_get(&scope, &name)
                .unwrap_or_else(|e| panic!("cx ws: {e}"));
            let body = if let Some(b) = flags.get("body") {
                b.clone()
            } else if let Some(f) = flags.get("file") {
                std::fs::read_to_string(f).unwrap_or_else(|e| panic!("cx ws: {}: {e}", f))
            } else if !std::io::stdin().is_terminal() {
                let mut buf = String::new();
                use std::io::Read;
                let _ = std::io::stdin().read_to_string(&mut buf);
                if buf.is_empty() {
                    existing.as_ref().map_or(String::new(), |s| s.body.clone())
                } else {
                    buf
                }
            } else {
                existing.as_ref().map_or(String::new(), |s| s.body.clone())
            };
            let order = match flags.get("order") {
                Some(o) => o.parse::<i64>().unwrap_or_else(|e| {
                    eprintln!("cx ws: --order must be a number: {e}");
                    exit(2);
                }),
                None => existing.as_ref().map_or(0, |s| s.order),
            };
            let title = flags
                .get("title")
                .cloned()
                .unwrap_or_else(|| existing.as_ref().map_or(String::new(), |s| s.title.clone()));
            let sec = Section {
                scope: scope.clone(),
                name: name.clone(),
                kind,
                title,
                body,
                order,
            };
            let replaced = store
                .section_put(&sec)
                .unwrap_or_else(|e| panic!("cx ws: {e}"));
            if json {
                println!("{}", serde_json::to_string_pretty(&ws_json(&sec)).unwrap());
            } else {
                println!(
                    "{} {scope}/{name} ({})",
                    if replaced { "set" } else { "created" },
                    kind.as_str()
                );
            }
        }
        "rm" => {
            let name = ws_arg(&pos, 1, "rm <name> [scope]");
            let scope = ws_scope(pos.get(2));
            let mut store = open_ws();
            let gone = store
                .section_delete(&scope, &name)
                .unwrap_or_else(|e| panic!("cx ws: {e}"));
            if gone {
                println!("removed {scope}/{name}");
            } else {
                eprintln!("cx ws: no section {name:?} in {scope:?}");
                exit(1);
            }
        }
        other => {
            eprintln!("cx ws: unknown subcommand {other:?} — try list, show, set, rm, scopes");
            exit(2);
        }
    }
}

fn ws_arg(pos: &[String], i: usize, usage: &str) -> String {
    pos.get(i).cloned().unwrap_or_else(|| {
        eprintln!("cx ws: usage: {usage}");
        exit(2);
    })
}

/// Scope for a ws command that omits it: this repo's identity, else `global`.
fn ws_scope(arg: Option<&String>) -> String {
    arg.cloned()
        .or_else(contextual::repo_identity)
        .unwrap_or_else(|| "global".to_string())
}

/// `cx claim|park|release [note]` — the work guard: one pinned claim
/// item per scope. Claim = actively working (every session sees it via
/// resolve); park = suspend but keep the guard (may be stale — verify
/// context freshness before obeying); release = done or verified stale.
fn guard_command(args: &[String]) {
    if args.is_empty() {
        eprintln!("cx: usage: cx claim|park|release [note]");
        exit(2);
    }
    let sub = args[0].as_str();
    let note = args[1..].join(" ");
    let mut store = open_ws();
    let scope = ws_scope(None);
    let result = match sub {
        "claim" => store.claim_repo(&scope, &note),
        "park" => store.park_repo(&scope, &note),
        _ => store.release_repo(&scope, &note),
    };
    match result {
        Ok(it) => println!("{} {} [{}] {}", sub, it.id, it.status.as_str(), it.title),
        Err(e) => {
            eprintln!("cx {sub}: {e}");
            exit(1);
        }
    }
}

fn ws_json(s: &Section) -> serde_json::Value {
    serde_json::json!({
        "scope": s.scope, "name": s.name, "kind": s.kind.as_str(),
        "title": s.title, "body": s.body, "order": s.order,
    })
}

fn open_ws() -> AutomergeStore {
    let path = contextual::sections::default_ws_path();
    AutomergeStore::open(Some(&path)).unwrap_or_else(|e| panic!("cx: open {}: {e}", path.display()))
}

/// `cx watch` — stream semantic change events (items/sections) as JSON
/// lines. Detects external writes by mtime, merges them into a live
/// doc, and drains the resulting patches; events print one per line.
fn watch_loop() {
    use std::io::Write;
    use std::time::{Duration, SystemTime};
    let _path = contextual::sections::default_ws_path();
    let mut store = open_ws();
    let Some(doc_path) = store.path().map(|p| p.to_path_buf()) else {
        eprintln!("cx: watch needs a doc file (CX_WS_DB)");
        exit(1);
    };
    // Baseline: consume the store's initial state as events, discard.
    let _ = ChangeFeed::drain_events(&mut store);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut last = file_mtime(&doc_path);
    let poll = Duration::from_millis(200);
    loop {
        std::thread::sleep(poll);
        let m = file_mtime(&doc_path);
        if m == last {
            continue;
        }
        last = m;
        if let Err(e) = store.reload_merge(&doc_path) {
            eprintln!("cx: watch: {e}");
            continue;
        }
        for ev in ChangeFeed::drain_events(&mut store) {
            if writeln!(out, "{}", ev.to_line()).and_then(|_| out.flush()).is_err() {
                // Reader gone (client closed the pipe) — done.
                return;
            }
        }
    }

    fn file_mtime(p: &Path) -> Option<SystemTime> {
        std::fs::metadata(p).and_then(|m| m.modified()).ok()
    }
}

/// Work items (plan3 W2): named records with a lifecycle, stored in
/// the same workflow doc as sections. Id prefixes resolve when unique.
fn item_command(args: &[String]) {
    let (flags, pos) = split_args_bools(args, "item", &["json", "met", "unmet"]);
    let json = flags.contains_key("json");
    let sub = pos.first().map(String::as_str).unwrap_or("help");
    let scope = flags
        .get("scope")
        .cloned()
        .or_else(contextual::repo_identity)
        .unwrap_or_else(|| "global".to_string());
    let mut store = open_ws();

    let id_of = |pos: &[String], i: usize, usage: &str| -> String {
        let arg = pos.get(i).cloned().unwrap_or_else(|| {
            eprintln!("cx item: usage: {usage}");
            exit(2);
        });
        store
            .item_resolve(&scope, &arg)
            .unwrap_or_else(|e| die("cx item", e))
    };

    match sub {
        "help" | "-h" | "--help" => println!("{USAGE}"),
        "add" => {
            let title = pos[1..].join(" ");
            if title.trim().is_empty() {
                eprintln!("cx item: usage: item add \"<title>\" [--labels a,b] [--priority N] ...");
                exit(2);
            }
            let n = NewItem {
                title,
                priority: flags
                    .get("priority")
                    .map(|p| {
                        p.parse::<i64>()
                            .unwrap_or_else(|e| die("cx item: --priority", e.into()))
                    })
                    .unwrap_or(0),
                assignee: flags.get("assignee").cloned().unwrap_or_default(),
                labels: flag_list(&flags, "labels"),
                blocks: flag_list(&flags, "blocks"),
                discovered_from: flag_list(&flags, "discovered-from"),
                child_of: flag_list(&flags, "child-of"),
                acceptance: flags.get("acceptance").cloned().unwrap_or_default(),
                design: flag_text(&flags, "design", "design-file"),
                gate: flags.get("gate").cloned().unwrap_or_default(),
            };
            let it = store
                .item_add(&scope, n)
                .unwrap_or_else(|e| die("cx item", e));
            if json {
                println!("{}", serde_json::to_string_pretty(&item_json(&it)).unwrap());
            } else {
                println!("created {} {} \"{}\"", scope, it.id, it.title);
            }
        }
        "list" | "ready" => {
            let ranked = if sub == "ready" {
                Some(
                    store
                        .item_rank(&scope)
                        .unwrap_or_else(|e| die("cx item", e)),
                )
            } else {
                None
            };
            let items = if sub == "ready" {
                ranked
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|r| r.item.clone())
                    .collect::<Vec<_>>()
            } else {
                let mut items = store
                    .item_list(&scope)
                    .unwrap_or_else(|e| die("cx item", e));
                items.sort_by(|a, b| {
                    let rank = |s: Status| match s {
                        Status::Closed => 1,
                        _ => 0,
                    };
                    rank(a.status)
                        .cmp(&rank(b.status))
                        .then(b.priority.cmp(&a.priority))
                        .then(a.id.cmp(&b.id))
                });
                items
            };
            let open_blockers = |it: &WorkItem, all: &[WorkItem]| -> Vec<String> {
                all.iter()
                    .filter(|o| o.blocks.contains(&it.id) && o.status != Status::Closed)
                    .map(|o| o.id.clone())
                    .collect()
            };
            if sub == "list" {
                let all = store
                    .item_list(&scope)
                    .unwrap_or_else(|e| die("cx item", e));
                let pinned = store.item_pinned_ids(&scope).unwrap_or_default();
                if json {
                    let arr: Vec<_> = items
                        .iter()
                        .map(|it| {
                            let mut o = item_json(it);
                            o["blocked_by"] = serde_json::json!(open_blockers(it, &all));
                            o
                        })
                        .collect();
                    println!("{}", serde_json::to_string_pretty(&arr).unwrap());
                    return;
                }
                if items.is_empty() {
                    println!("(no items in {scope})");
                    return;
                }
                for it in &items {
                    let blocked = open_blockers(it, &all);
                    let b = if blocked.is_empty() {
                        String::new()
                    } else {
                        format!(" (blocked by {})", blocked.join(", "))
                    };
                    let pin = if pinned.contains(&it.id) { " ★" } else { "" };
                    println!(
                        "{:<8} {:<12} p{:<3} {}{}{}",
                        it.id,
                        it.status.as_str(),
                        it.priority,
                        it.title,
                        pin,
                        b
                    );
                }
            } else {
                let ranked = ranked.unwrap();
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
                    println!("{}", serde_json::to_string_pretty(&arr).unwrap());
                    return;
                }
                if items.is_empty() {
                    println!("(nothing ready in {scope})");
                    return;
                }
                for r in &ranked {
                    println!(
                        "{:<8} {:>7.0} p{:<3} {} — {}",
                        r.item.id,
                        r.score,
                        r.item.priority,
                        r.item.title,
                        r.why.join(" · ")
                    );
                }
            }
        }
        "show" => {
            let id = id_of(&pos, 1, "item show <id>");
            let it = store
                .item_get(&scope, &id)
                .unwrap_or_else(|e| die("cx item", e));
            match it {
                None => die("cx item", format!("no item {id} in {scope}").into()),
                Some(it) => {
                    if json {
                        println!("{}", serde_json::to_string_pretty(&item_json(&it)).unwrap());
                        return;
                    }
                    println!(
                        "# {} [{}] ({}, p{})",
                        it.title,
                        it.id,
                        it.status.as_str(),
                        it.priority
                    );
                    if !it.assignee.is_empty() {
                        println!("assignee: {}", it.assignee);
                    }
                    for (label, heading) in [(&it.design, "design"), (&it.acceptance, "acceptance")]
                    {
                        if !heading.is_empty() && !label.is_empty() {
                            println!("\n## {heading}\n\n{label}");
                        }
                    }
                    if !it.labels.is_empty() {
                        let ls: Vec<_> = it.labels.iter().map(|l| format!("#{l}")).collect();
                        println!("\nlabels: {}", ls.join(" "));
                    }
                    for (key, set) in [
                        ("blocks", &it.blocks),
                        ("child-of", &it.child_of),
                        ("discovered-from", &it.discovered_from),
                    ] {
                        if !set.is_empty() {
                            let ids: Vec<_> = set.iter().cloned().collect();
                            println!("{key}: {}", ids.join(", "));
                        }
                    }
                    if !it.notes.is_empty() {
                        println!("\n## notes");
                        for (nid, text) in &it.notes {
                            println!("- [{nid}] {text}");
                        }
                    }
                }
            }
        }
        "edit" => {
            let id = id_of(&pos, 1, "item edit <id> [--title T] [--priority N] [--assignee A] [--status S] [--design TEXT | --design-file F]");
            let status = match flags.get("status").map(String::as_str) {
                Some(s) => Some(Status::parse(s).unwrap_or_else(|| {
                    die(
                        "cx item: --status",
                        "must be open|in_progress|closed".into(),
                    )
                })),
                None => None,
            };
            let edit = ItemEdit {
                title: flags.get("title").cloned(),
                priority: flags.get("priority").map(|p| {
                    p.parse::<i64>()
                        .unwrap_or_else(|e| die("cx item: --priority", e.into()))
                }),
                assignee: flags.get("assignee").cloned(),
                design: {
                    let d = flag_text(&flags, "design", "design-file");
                    (!d.is_empty()).then_some(d)
                },
                acceptance: flags.get("acceptance").cloned(),
                status,
                gate: flags.get("gate").cloned(),
                gate_met: None,
            };
            let it = store
                .item_edit(&scope, &id, edit)
                .unwrap_or_else(|e| die("cx item", e));
            println!("edited {} [{}] -> {}", scope, it.id, it.status.as_str());
        }
        "claim" | "close" | "reopen" => {
            let id = id_of(&pos, 1, "item <claim|close|reopen> <id>");
            let it = match sub {
                "claim" => store.item_claim(&scope, &id),
                "close" => store.item_close(&scope, &id),
                _ => store.item_reopen(&scope, &id),
            }
            .unwrap_or_else(|e| die("cx item", e));
            println!("{} {} -> {}", scope, it.id, it.status.as_str());
        }
        "move" => {
            let id = id_of(
                &pos,
                1,
                "cx item move <id> top|bottom|before|after [sibling]",
            );
            let rel = pos.get(2).map(|s| s.to_lowercase()).unwrap_or_default();
            let target = match rel.as_str() {
                "top" => MoveTarget::Top,
                "bottom" => MoveTarget::Bottom,
                "before" => MoveTarget::Before(
                    pos.get(3)
                        .map(String::clone)
                        .unwrap_or_else(|| usage_move()),
                ),
                "after" => MoveTarget::After(
                    pos.get(3)
                        .map(String::clone)
                        .unwrap_or_else(|| usage_move()),
                ),
                _ => usage_move(),
            };
            let it = store
                .item_move(&scope, &id, target)
                .unwrap_or_else(|e| die("cx item", e));
            println!("moved {} -> queue position {}", it.id, it.order);
        }
        "gate" => {
            let id = id_of(&pos, 1, "cx item gate <id> [--met|--unmet] [\"text\"]");
            let met = if flags.contains_key("met") {
                Some(true)
            } else if flags.contains_key("unmet") {
                Some(false)
            } else {
                None
            };
            let text = pos.get(2).map(String::as_str);
            if met.is_none() && text.is_none() {
                eprintln!("cx item: usage: cx item gate <id> [--met|--unmet] [\"text\"]");
                exit(2);
            }
            let it = store
                .item_gate(&scope, &id, text, met)
                .unwrap_or_else(|e| die("cx item", e));
            println!(
                "{}: gate={} met={}",
                it.id,
                if it.gate.is_empty() {
                    "(none)"
                } else {
                    &it.gate
                },
                it.gate_met
            );
        }
        "pin" | "unpin" => {
            let id = id_of(&pos, 1, "cx item pin|unpin <id>");
            let it = store
                .item_pin(&scope, &id, sub == "pin")
                .unwrap_or_else(|e| die("cx item", e));
            if sub == "pin" {
                println!(
                    "pinned {} — rides in injected context until unpinned or closed",
                    it.id
                );
            } else {
                println!("unpinned {}", it.id);
            }
        }
        "note" => {
            let id = id_of(&pos, 1, "item note <id> \"<text>\"");
            let text = flags
                .get("text")
                .cloned()
                .unwrap_or_else(|| pos[2..].join(" "));
            if text.trim().is_empty() {
                eprintln!("cx item: note text is required");
                exit(2);
            }
            let nid = store
                .item_note(&scope, &id, &text)
                .unwrap_or_else(|e| die("cx item", e));
            println!("noted {scope}/{id} [{nid}]");
        }
        "label" => {
            let id = id_of(&pos, 1, "item label <id> add|rm <label>");
            let op = pos.get(2).map(String::as_str).unwrap_or("");
            let label = pos.get(3).cloned().unwrap_or_default();
            let add = match op {
                "add" => true,
                "rm" => false,
                _ => die("cx item", "usage: item label <id> add|rm <label>".into()),
            };
            store
                .item_label(&scope, &id, &label, add)
                .unwrap_or_else(|e| die("cx item", e));
            println!(
                "{} {} {} {label}",
                if add { "labeled" } else { "unlabeled" },
                scope,
                id
            );
        }
        "edge" => {
            let id = id_of(
                &pos,
                1,
                "item edge <id> add|rm blocks|child-of|discovered-from <target>",
            );
            let op = pos.get(2).map(String::as_str).unwrap_or("");
            let kind = match pos.get(3).map(String::as_str) {
                Some("blocks") => EdgeKind::Blocks,
                Some("child-of") => EdgeKind::ChildOf,
                Some("discovered-from") => EdgeKind::DiscoveredFrom,
                _ => die(
                    "cx item",
                    "edge kind must be blocks|child-of|discovered-from".into(),
                ),
            };
            let add = match op {
                "add" => true,
                "rm" => false,
                _ => die(
                    "cx item",
                    "usage: item edge <id> add|rm <kind> <target>".into(),
                ),
            };
            let target = pos.get(4).cloned().unwrap_or_default();
            let target = store
                .item_resolve(&scope, &target)
                .unwrap_or_else(|e| die("cx item", e));
            store
                .item_edge(&scope, &id, kind, &target, add)
                .unwrap_or_else(|e| die("cx item", e));
            println!(
                "{} {} {} {} {}",
                if add { "linked" } else { "unlinked" },
                scope,
                id,
                kind.as_str(),
                target
            );
        }
        "rm" => {
            let id = id_of(&pos, 1, "item rm <id>");
            if store
                .item_delete(&scope, &id)
                .unwrap_or_else(|e| die("cx item", e))
            {
                println!("deleted {scope}/{id}");
            } else {
                die("cx item", format!("no item {id} in {scope}").into());
            }
        }
        other => {
            eprintln!("cx item: unknown subcommand {other:?} — see {USAGE}");
            exit(2);
        }
    }
}

fn die(context: &str, err: Box<dyn std::error::Error + Send + Sync>) -> ! {
    eprintln!("{context}: {err}");
    exit(1);
}

/// Comma-separated list flag ("a,b") as Vec<String>.
fn flag_list(flags: &BTreeMap<String, String>, key: &str) -> Vec<String> {
    flags
        .get(key)
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Text from `--<key> TEXT` or `--<file_key> PATH` (empty when absent).
fn flag_text(flags: &BTreeMap<String, String>, key: &str, file_key: &str) -> String {
    if let Some(t) = flags.get(key) {
        return t.clone();
    }
    if let Some(f) = flags.get(file_key) {
        return std::fs::read_to_string(f).unwrap_or_else(|e| die("cx", e.into()));
    }
    String::new()
}

fn usage_move() -> ! {
    eprintln!("cx item move <id> top|bottom|before|after <sibling>");
    exit(2);
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
    })
}

/// Canonical path used as a stable source identifier.
fn source_path(p: &Path) -> String {
    p.canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
