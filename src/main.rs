//! `gzero` — the gzero CLI.
//!
//! `gzero`                 print default context (untagged atoms)
//! `gzero #tag ...`        default plus tagged atoms
//! `gzero add file.md ...` import markdown into the store (per-source sync)
//! `gzero harvest [dir]`   import agent-instruction files (AGENTS.md, CLAUDE.md, …)
//! `gzero sources`         per-source assertion counts
//! `gzero rm <needle>`     remove atoms whose text contains needle
//! `gzero rm-source <src>`  remove a whole source (tombstoned)
//! `gzero tags`            tag vocabulary with counts

use std::collections::{BTreeMap, BTreeSet};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::exit;

use gzero::comms::CommsLayer;
use gzero::hub::{events_for_snapshot, Event, Hub};
use gzero::items::{EdgeKind, ItemEdit, MoveTarget, NewItem, Status, WorkItem};
use gzero::sections::{checklist_progress, Section, SectionKind};
use gzero::snapshot::Atom;
use gzero::{source_counts, tag_counts, AutomergeStore, ChangeFeed, SqliteStore, Storage};

/// Post events to the hub if configured; warn (don't fail) otherwise.
fn try_post_events(events: &[Event]) {
    // Doc mode propagates atom changes via the D1 change log
    // (Atoms::write sync); legacy /events would double-write.
    if events.is_empty() || gzero::legacy_db() {
        return;
    }
    if let Some(hub) = Hub::from_env() {
        if let Err(e) = hub.post_events(events) {
            eprintln!("gzero: hub push failed: {e}");
        }
    }
}

/// Atoms in the resolved view matching a needle, as full atoms for events.
fn matched_atoms(store: &dyn Storage, needle: &str) -> Vec<Atom> {
    match gzero::alive(store) {
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

const USAGE: &str = "gzero
gzero                default context (untagged atoms)
gzero #tag ...       default plus tagged atoms
gzero add file.md    import context markdown (per-source sync; re-run after edits)
gzero harvest [dir]  import agent-instruction files (AGENTS.md, CLAUDE.md, GEMINI.md,
                  .cursorrules, .windsurfrules, copilot-instructions) as project context
gzero migrate-db     import context.db atoms + tombstones into the workspace doc
                  (per-source provenance preserved; idempotent)
gzero export file    write this machine's snapshot (merge unit)
gzero absorb file... merge other machines' snapshots into the local store
gzero sync           push+pull the workspace store through the hub change log (CX_HUB_URL,
                  CX_TOKEN; bag CX_BAG, default 'context')
gzero pull           fetch merged snapshot from the hub (CX_HUB_URL) and absorb
gzero push           post this store's atoms + tombstones to the hub as events
gzero sources        per-source assertion counts
gzero rm <needle>    remove matching atoms (records tombstones)
gzero rm-source <s>  remove one whole source (tombstoned; substring must match exactly one)
gzero tags           tag vocabulary with counts
gzero ws list        workflow sections for this project (vision, plan, checklists, ...)
gzero ws show <name>          print one section (checklists render with boxes + count)
gzero ws set <name> [--title T] [--type md|checklist] [--order N]
                 [--body TEXT | --file F]   create or update a section
                 (body also read from stdin when piped; omit to edit metadata only)
gzero ws rm <name>   delete a section
gzero ws scopes      list scopes that have sections
gzero item add \"<title>\"      create a work item [--labels a,b] [--priority N]
                 [--child-of ID] [--blocks ID] [--design TEXT | --design-file F]
                 [--acceptance TEXT]
gzero item list [--json]      all items: id, status, priority, title, blocked
gzero item ready [--json]     the fold: open items with no open blockers, ranked
gzero item pin|unpin <id>     pin = rides in injected context (resolve) until done
gzero item show <id> [--json] full item incl. notes
gzero item edit <id> [--title T] [--priority N] [--assignee A]
                 [--design TEXT | --design-file F] [--status open|in_progress|closed]
gzero item claim <id> / close <id> / reopen <id>
gzero item note <id> \"<text>\" append a note (append-only)
gzero item gate <id> [--met|--unmet] [\"text\"]  set/satisfy the close gate
gzero item label <id> add|rm <label>
gzero item edge <id> add|rm blocks|child-of|discovered-from <target>
gzero item rm <id>   delete an item
gzero watch          stream ws-doc change events (items/sections) as JSON lines
                  until the reader hangs up; polls the doc file (3cd4)
gzero sessions       session presence rows (stale marked; S1 inspection)
env: CX_WS_DB     atom store + workflow doc: atoms, tombstones, sections, items
                  (default ~/.pi/agent/context.ws); synced via `gzero sync`
                  (CX_HUB_URL, CX_TOKEN, bag CX_BAG default 'context')
env: CX_LEGACY_DB=1  rollback: atoms on the legacy SQLite store (CX_DB,
                  default ~/.pi/agent/context.db); `gzero pull`/`push` are
                  legacy-only; migrate-db imports SQLite into the doc";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        if args.is_empty() && store_path().exists() {
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
            match gzero::repo_identity() {
                Some(id) => println!("{id}"),
                None => {
                    eprintln!("gzero: not in a git repository");
                    exit(1);
                }
            }
        }
        "sessions" => {
            // Inspection view for S1 presence: all rows, stale marked.
            let rows = if gzero::legacy_db() {
                open_store()
                    .all_sessions()
                    .unwrap_or_else(|e| panic!("gzero: {e}"))
            } else {
                gzero::comms::CommsStore::open(Some(&gzero::comms::comms_db_path()))
                    .unwrap_or_else(|e| panic!("gzero: comms: {e}"))
                    .all_sessions()
                    .unwrap_or_else(|e| panic!("gzero: {e}"))
            };
            if args.iter().any(|a| a == "--json") {
                println!(
                    "{}",
                    serde_json::to_string(&rows).unwrap_or_else(|e| panic!("gzero: {e}"))
                );
                return;
            }
            let (me, _) = gzero::sessions::session_identity();
            if rows.is_empty() {
                println!("no sessions on record");
                return;
            }
            for s in rows {
                let stale = gzero::sessions::now() - s.last_seen > gzero::PRESENCE_TTL_SECS;
                let marker = if s.session_id == me {
                    " (me)"
                } else if stale {
                    " (stale)"
                } else {
                    ""
                };
                let m = (gzero::sessions::now() - s.last_seen) / 60;
                println!(
                    "{}{}  {}  {}  {}  seen {}m ago",
                    &s.session_id[..s.session_id.len().min(12)],
                    marker,
                    s.scope,
                    if s.workspace.is_empty() {
                        "default"
                    } else {
                        &s.workspace
                    },
                    if s.cwd.is_empty() { "?" } else { &s.cwd },
                    m
                );
            }
        }
        "add" => {
            if args.len() < 2 {
                eprintln!("usage: gzero add file.md ...");
                exit(2);
            }
            let mut atoms = open_atoms();
            let mut events: Vec<Event> = Vec::new();
            atoms
                .write(|store| {
                    for f in &args[1..] {
                        let text = std::fs::read_to_string(f)
                            .unwrap_or_else(|e| panic!("gzero: {}: {e}", f));
                        let source = source_path(Path::new(f));
                        let stats =
                            gzero::add_doc(store, &source, &text).map_err(|e| e.to_string())?;
                        println!(
                            "{f}: +{} -{} ={} (kept {})",
                            stats.added, stats.removed, stats.kept, stats.kept
                        );
                        // Post only what this sync added (idempotent on the hub).
                        events.extend(gzero::parse(&text).into_iter().map(|a| Event::Put {
                            atom: Atom {
                                text: a.text,
                                scope: a.scope,
                                node: a.node,
                                tags: a.tags,
                            },
                        }));
                    }
                    Ok(())
                })
                .unwrap_or_else(|e| panic!("gzero: {e}"));
            try_post_events(&events);
        }
        "sync" => {
            let bag = std::env::var("CX_BAG").unwrap_or_else(|_| "context".into());
            let hub = gzero::hub_changes::HubChanges::from_env(&bag).unwrap_or_else(|| {
                eprintln!("gzero sync: set CX_HUB_URL and CX_TOKEN");
                exit(2);
            });
            let path = gzero::sections::default_ws_path();
            let mut store = AutomergeStore::open(Some(&path))
                .unwrap_or_else(|e| panic!("gzero: open {}: {e}", path.display()));
            let sidecar = gzero::hub_changes::sidecar_path(&path);
            let mut cursor = gzero::hub_changes::SyncCursor::load(&sidecar, &bag)
                .unwrap_or_else(|e| panic!("gzero sync: {e}"));
            let (pushed, pulled) = gzero::hub_changes::sync_once(&mut store, &hub, &mut cursor)
                .unwrap_or_else(|e| panic!("gzero sync: {e}"));
            cursor
                .save(&sidecar, &bag)
                .unwrap_or_else(|e| panic!("gzero sync: {e}"));
            println!("sync {bag}: pushed {pushed}, pulled {pulled}");
        }
        "pull" => {
            let hub = Hub::from_env().unwrap_or_else(|| {
                eprintln!("gzero pull: set CX_HUB_URL and CX_TOKEN");
                exit(2);
            });
            let mut store = open_store();
            let snap = hub
                .fetch_snapshot()
                .unwrap_or_else(|e| panic!("gzero pull: {e}"));
            let stats = gzero::absorb_snapshot(&mut store, "hub", &snap)
                .unwrap_or_else(|e| panic!("gzero: {e}"));
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
                eprintln!("gzero push: set CX_HUB_URL and CX_TOKEN");
                exit(2);
            });
            let store = open_store();
            let snap = gzero::export_snapshot(&store).unwrap_or_else(|e| panic!("gzero: {e}"));
            hub.post_events(&events_for_snapshot(&snap))
                .unwrap_or_else(|e| panic!("gzero push: {e}"));
            println!(
                "pushed {} atoms, {} tombstones to hub",
                snap.atoms.len(),
                snap.tombstones.len()
            );
        }
        "migrate-db" => {
            let mut legacy = open_store();
            let mut doc = open_ws();
            let stats = gzero::migrate_db_to_doc(&mut legacy, &mut doc)
                .unwrap_or_else(|e| panic!("gzero migrate-db: {e}"));
            // Verification: every legacy alive text must exist in the doc.
            let legacy_texts: BTreeSet<String> = gzero::alive(&legacy)
                .unwrap_or_else(|e| panic!("gzero migrate-db: {e}"))
                .into_iter()
                .map(|(t, _)| t)
                .collect();
            let doc_texts: BTreeSet<String> = gzero::alive(&doc)
                .unwrap_or_else(|e| panic!("gzero migrate-db: {e}"))
                .into_iter()
                .map(|(t, _)| t)
                .collect();
            let missing: Vec<&String> = legacy_texts.difference(&doc_texts).collect();
            println!(
                "migrated {} atoms ({} sources, {} unchanged), {} tombstones; \
                 legacy {} texts, doc {} texts{}",
                stats.atoms,
                stats.sources_synced,
                stats.sources_skipped,
                stats.tombstones,
                legacy_texts.len(),
                doc_texts.len(),
                if missing.is_empty() {
                    String::new()
                } else {
                    format!(" ({} MISSING)", missing.len())
                }
            );
            if !missing.is_empty() {
                exit(1);
            }
        }
        "export" => {
            if args.len() != 2 {
                eprintln!("usage: gzero export <file>");
                exit(2);
            }
            let mut atoms = open_atoms();
            let snap =
                gzero::export_snapshot(atoms.storage()).unwrap_or_else(|e| panic!("gzero: {e}"));
            let bytes = snap.to_json().unwrap_or_else(|e| panic!("gzero: {e}"));
            std::fs::write(&args[1], bytes).unwrap_or_else(|e| panic!("gzero: {}: {e}", args[1]));
            println!(
                "exported {} atoms, {} tombstones -> {}",
                snap.atoms.len(),
                snap.tombstones.len(),
                args[1]
            );
        }
        "absorb" => {
            if args.len() < 2 {
                eprintln!("usage: gzero absorb <file>...");
                exit(2);
            }
            let mut atoms = open_atoms();
            for f in &args[1..] {
                let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("gzero: {}: {e}", f));
                let snap = gzero::snapshot::Snapshot::from_json(&bytes)
                    .unwrap_or_else(|e| panic!("gzero: {f}: {e}"));
                let source = source_path(Path::new(f));
                let stats = gzero::absorb_snapshot(atoms.storage(), &source, &snap)
                    .unwrap_or_else(|e| panic!("gzero: {e}"));
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
            let mut atoms = open_atoms();
            for (source, n) in
                source_counts(atoms.storage()).unwrap_or_else(|e| panic!("gzero: {e}"))
            {
                println!("{n}\t{source}");
            }
        }
        "teams" => {
            // List teams (scope team/<name>): name, purpose, members.
            let mut atoms = open_atoms();
            print!(
                "{}",
                gzero::teams::render(&gzero::teams::list_teams(atoms.storage())
                    .unwrap_or_else(|e| panic!("gzero: {e}")))
            );
        }
        "rm" => {
            if args.len() < 2 {
                eprintln!("usage: gzero rm <needle>");
                exit(2);
            }
            let needle = args[1..].join(" ");
            let mut atoms = open_atoms();
            let (removed, events) = atoms
                .write(|store| {
                    let victims = matched_atoms(store, &needle);
                    let n = store.remove_matching(&needle).map_err(|e| e.to_string())?;
                    Ok((
                        n,
                        victims
                            .into_iter()
                            .map(|atom| Event::Remove { atom })
                            .collect::<Vec<_>>(),
                    ))
                })
                .unwrap_or_else(|e| panic!("gzero: {e}"));
            match removed {
                0 => println!("(no matches)"),
                n => {
                    println!("removed {n}");
                    try_post_events(&events);
                }
            }
        }
        "harvest" => {
            let flags: Vec<&String> = args[1..].iter().filter(|a| a.starts_with("--")).collect();
            let check = flags.iter().any(|f| f.as_str() == "--check");
            let take = flags.iter().any(|f| f.as_str() == "--take");
            let dir = match args[1..].iter().find(|a| !a.starts_with("--")) {
                Some(d) => PathBuf::from(d),
                None => std::env::current_dir().unwrap_or_else(|e| panic!("gzero: {e}")),
            };
            let mut atoms = open_atoms();
            if check || take {
                let result = atoms
                    .write(|s| gzero::reconcile_harvest(s, &dir, take).map_err(|e| e.to_string()))
                    .unwrap_or_else(|e| panic!("gzero: harvest: {e}"));
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
                let results = atoms
                    .write(|s| gzero::harvest_dir(s, &dir).map_err(|e| e.to_string()))
                    .unwrap_or_else(|e| panic!("gzero: harvest: {e}"));
                if results.is_empty() {
                    println!(
                        "(no instruction files found: {})",
                        gzero::HARVEST_FILES.join(", ")
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
                eprintln!("usage: gzero rm-source <source>  (substring; must match one source)");
                exit(2);
            }
            let needle = args[1..].join(" ");
            let mut atoms = open_atoms();
            let sources: Vec<String> = source_counts(atoms.storage())
                .unwrap_or_else(|e| panic!("gzero: {e}"))
                .into_iter()
                .map(|(s, _)| s)
                .filter(|s| s.contains(&needle))
                .collect();
            match sources.as_slice() {
                [source] => {
                    // Tombstone first so removal survives hub pulls; then
                    // drop the rows (sync with nothing = the source asserts nothing).
                    let victims: Vec<Atom> = atoms
                        .storage()
                        .all()
                        .unwrap_or_else(|e| panic!("gzero: {e}"))
                        .into_iter()
                        .filter(|r| r.source == *source)
                        .map(|r| Atom {
                            text: r.text,
                            scope: r.scope,
                            node: r.node,
                            tags: r.tags,
                        })
                        .collect();
                    atoms
                        .write(|store| {
                            store.tombstone(&victims).map_err(|e| e.to_string())?;
                            let stats =
                                store.sync_source(source, &[]).map_err(|e| e.to_string())?;
                            println!("{source}: removed {}", stats.removed);
                            Ok(())
                        })
                        .unwrap_or_else(|e| panic!("gzero: {e}"));
                    try_post_events(
                        &victims
                            .into_iter()
                            .map(|atom| Event::Remove { atom })
                            .collect::<Vec<_>>(),
                    );
                }
                [] => {
                    eprintln!("gzero: no source matches {needle:?}");
                    exit(1);
                }
                many => {
                    eprintln!("gzero: {needle:?} is ambiguous:");
                    for s in many {
                        eprintln!("  {s}");
                    }
                    exit(1);
                }
            }
        }
        "tags" => {
            let mut atoms = open_atoms();
            for (tag, n) in tag_counts(atoms.storage()).unwrap_or_else(|e| panic!("gzero: {e}")) {
                println!("#{tag} {n}");
            }
        }
        "ws" => ws_command(&args[1..]),
        "item" => item_command(&args[1..]),
        "claim" | "park" | "release" => guard_command(&args),
        "recommend" => {
            eprintln!("gzero: recommend is gone — packs were dissolved (tagged atoms replace them; see plan.md M4)");
            eprintln!("pull build/workflow conventions via: gzero '#rust' / gzero '#npm'");
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
                        eprintln!("gzero: unknown command or bad tag: {other}");
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
    let mut atoms = open_atoms();
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    let project = gzero::repo_identity();
    let items = gzero::resolve_tiers(atoms.storage(), project.as_deref(), &refs)
        .unwrap_or_else(|e| panic!("gzero: {e}"));
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

/// The atom store for CLI commands: the automerge doc by default
/// (D1-synced via Atoms::write), legacy SQLite under CX_LEGACY_DB=1.
fn open_atoms() -> gzero::Atoms {
    gzero::Atoms::open().unwrap_or_else(|e| panic!("gzero: atoms: {e}"))
}

fn open_store() -> SqliteStore {
    SqliteStore::open(store_path().to_str().unwrap_or("context.db"))
        .unwrap_or_else(|e| panic!("gzero: open store: {e}"))
}

fn store_path() -> PathBuf {
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
                        eprintln!("gzero: --{f} needs a value ({cmd})");
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
                .unwrap_or_else(|e| panic!("gzero ws: {e}"));
            for s in scopes {
                println!("{s}");
            }
        }
        "list" => {
            let scope = ws_scope(pos.get(1));
            let store = open_ws();
            let items = store
                .section_list(&scope)
                .unwrap_or_else(|e| panic!("gzero ws: {e}"));
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
                .unwrap_or_else(|e| panic!("gzero ws: {e}"))
            else {
                eprintln!("gzero ws: no section {name:?} in {scope:?}");
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
                    eprintln!("gzero ws: --type must be md or checklist");
                    exit(2);
                }),
                None => {
                    let store = open_ws();
                    store
                        .section_get(&scope, &name)
                        .unwrap_or_else(|e| panic!("gzero ws: {e}"))
                        .map_or(SectionKind::Md, |s| s.kind)
                }
            };
            let mut store = open_ws();
            let existing = store
                .section_get(&scope, &name)
                .unwrap_or_else(|e| panic!("gzero ws: {e}"));
            let body = if let Some(b) = flags.get("body") {
                b.clone()
            } else if let Some(f) = flags.get("file") {
                std::fs::read_to_string(f).unwrap_or_else(|e| panic!("gzero ws: {}: {e}", f))
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
                    eprintln!("gzero ws: --order must be a number: {e}");
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
                .unwrap_or_else(|e| panic!("gzero ws: {e}"));
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
                .unwrap_or_else(|e| panic!("gzero ws: {e}"));
            if gone {
                println!("removed {scope}/{name}");
            } else {
                eprintln!("gzero ws: no section {name:?} in {scope:?}");
                exit(1);
            }
        }
        other => {
            eprintln!("gzero ws: unknown subcommand {other:?} — try list, show, set, rm, scopes");
            exit(2);
        }
    }
}

fn ws_arg(pos: &[String], i: usize, usage: &str) -> String {
    pos.get(i).cloned().unwrap_or_else(|| {
        eprintln!("gzero ws: usage: {usage}");
        exit(2);
    })
}

/// Scope for a ws command that omits it: this repo's identity, else `global`.
fn ws_scope(arg: Option<&String>) -> String {
    arg.cloned()
        .or_else(gzero::repo_identity)
        .unwrap_or_else(|| "global".to_string())
}

/// `gzero claim|park|release [note]` — the work guard: one pinned claim
/// item per scope. Claim = actively working (every session sees it via
/// resolve); park = suspend but keep the guard (may be stale — verify
/// context freshness before obeying); release = done or verified stale.
fn guard_command(args: &[String]) {
    if args.is_empty() {
        eprintln!("gzero: usage: gzero claim|park|release [note]");
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
            eprintln!("gzero {sub}: {e}");
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
    let path = gzero::sections::default_ws_path();
    AutomergeStore::open(Some(&path))
        .unwrap_or_else(|e| panic!("gzero: open {}: {e}", path.display()))
}

/// `gzero watch` — stream semantic change events (items/sections) as JSON
/// lines. Detects external writes by mtime, merges them into a live
/// doc, and drains the resulting patches; events print one per line.
fn watch_loop() {
    use std::io::Write;
    use std::time::{Duration, SystemTime};
    let _path = gzero::sections::default_ws_path();
    let mut store = open_ws();
    let Some(doc_path) = store.path().map(|p| p.to_path_buf()) else {
        eprintln!("gzero: watch needs a doc file (CX_WS_DB)");
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
            eprintln!("gzero: watch: {e}");
            continue;
        }
        for ev in ChangeFeed::drain_events(&mut store) {
            if writeln!(out, "{}", ev.to_line())
                .and_then(|_| out.flush())
                .is_err()
            {
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
        .or_else(gzero::repo_identity)
        .unwrap_or_else(|| "global".to_string());
    let mut store = open_ws();

    let id_of = |pos: &[String], i: usize, usage: &str| -> String {
        let arg = pos.get(i).cloned().unwrap_or_else(|| {
            eprintln!("gzero item: usage: {usage}");
            exit(2);
        });
        store
            .item_resolve(&scope, &arg)
            .unwrap_or_else(|e| die("gzero item", e))
    };

    match sub {
        "help" | "-h" | "--help" => println!("{USAGE}"),
        "add" => {
            let title = pos[1..].join(" ");
            if title.trim().is_empty() {
                eprintln!(
                    "gzero item: usage: item add \"<title>\" [--labels a,b] [--priority N] ..."
                );
                exit(2);
            }
            let n = NewItem {
                title,
                priority: flags
                    .get("priority")
                    .map(|p| {
                        p.parse::<i64>()
                            .unwrap_or_else(|e| die("gzero item: --priority", e.into()))
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
                .unwrap_or_else(|e| die("gzero item", e));
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
                        .unwrap_or_else(|e| die("gzero item", e)),
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
                    .unwrap_or_else(|e| die("gzero item", e));
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
                    .unwrap_or_else(|e| die("gzero item", e));
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
                .unwrap_or_else(|e| die("gzero item", e));
            match it {
                None => die("gzero item", format!("no item {id} in {scope}").into()),
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
                        "gzero item: --status",
                        "must be open|in_progress|closed".into(),
                    )
                })),
                None => None,
            };
            let edit = ItemEdit {
                title: flags.get("title").cloned(),
                priority: flags.get("priority").map(|p| {
                    p.parse::<i64>()
                        .unwrap_or_else(|e| die("gzero item: --priority", e.into()))
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
                .unwrap_or_else(|e| die("gzero item", e));
            println!("edited {} [{}] -> {}", scope, it.id, it.status.as_str());
        }
        "claim" | "close" | "reopen" => {
            let id = id_of(&pos, 1, "item <claim|close|reopen> <id>");
            let it = match sub {
                "claim" => store.item_claim(&scope, &id),
                "close" => store.item_close(&scope, &id),
                _ => store.item_reopen(&scope, &id),
            }
            .unwrap_or_else(|e| die("gzero item", e));
            println!("{} {} -> {}", scope, it.id, it.status.as_str());
        }
        "move" => {
            let id = id_of(
                &pos,
                1,
                "gzero item move <id> top|bottom|before|after [sibling]",
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
                .unwrap_or_else(|e| die("gzero item", e));
            println!("moved {} -> queue position {}", it.id, it.order);
        }
        "gate" => {
            let id = id_of(&pos, 1, "gzero item gate <id> [--met|--unmet] [\"text\"]");
            let met = if flags.contains_key("met") {
                Some(true)
            } else if flags.contains_key("unmet") {
                Some(false)
            } else {
                None
            };
            let text = pos.get(2).map(String::as_str);
            if met.is_none() && text.is_none() {
                eprintln!("gzero item: usage: gzero item gate <id> [--met|--unmet] [\"text\"]");
                exit(2);
            }
            let it = store
                .item_gate(&scope, &id, text, met)
                .unwrap_or_else(|e| die("gzero item", e));
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
            let id = id_of(&pos, 1, "gzero item pin|unpin <id>");
            let it = store
                .item_pin(&scope, &id, sub == "pin")
                .unwrap_or_else(|e| die("gzero item", e));
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
                eprintln!("gzero item: note text is required");
                exit(2);
            }
            let nid = store
                .item_note(&scope, &id, &text)
                .unwrap_or_else(|e| die("gzero item", e));
            println!("noted {scope}/{id} [{nid}]");
        }
        "label" => {
            let id = id_of(&pos, 1, "item label <id> add|rm <label>");
            let op = pos.get(2).map(String::as_str).unwrap_or("");
            let label = pos.get(3).cloned().unwrap_or_default();
            let add = match op {
                "add" => true,
                "rm" => false,
                _ => die("gzero item", "usage: item label <id> add|rm <label>".into()),
            };
            store
                .item_label(&scope, &id, &label, add)
                .unwrap_or_else(|e| die("gzero item", e));
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
                    "gzero item",
                    "edge kind must be blocks|child-of|discovered-from".into(),
                ),
            };
            let add = match op {
                "add" => true,
                "rm" => false,
                _ => die(
                    "gzero item",
                    "usage: item edge <id> add|rm <kind> <target>".into(),
                ),
            };
            let target = pos.get(4).cloned().unwrap_or_default();
            let target = store
                .item_resolve(&scope, &target)
                .unwrap_or_else(|e| die("gzero item", e));
            store
                .item_edge(&scope, &id, kind, &target, add)
                .unwrap_or_else(|e| die("gzero item", e));
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
                .unwrap_or_else(|e| die("gzero item", e))
            {
                println!("deleted {scope}/{id}");
            } else {
                die("gzero item", format!("no item {id} in {scope}").into());
            }
        }
        other => {
            eprintln!("gzero item: unknown subcommand {other:?} — see {USAGE}");
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
        return std::fs::read_to_string(f).unwrap_or_else(|e| die("gzero", e.into()));
    }
    String::new()
}

fn usage_move() -> ! {
    eprintln!("gzero item move <id> top|bottom|before|after <sibling>");
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
