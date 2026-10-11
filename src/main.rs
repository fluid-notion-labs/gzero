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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::exit;

use contextual::hub::{events_for_snapshot, Event, Hub};
use contextual::snapshot::Atom;
use contextual::{source_counts, tag_counts, SqliteStore, Storage};

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
env: CX_DB        bag location (default ~/.pi/agent/context.db)";

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

/// Canonical path used as a stable source identifier.
fn source_path(p: &Path) -> String {
    p.canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
