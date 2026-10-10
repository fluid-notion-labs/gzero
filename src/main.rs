//! `cx` — the context bag CLI.
//!
//! `cx`                 print default context (untagged atoms)
//! `cx #tag ...`        default plus tagged atoms
//! `cx add file.md ...` import markdown into the bag (per-source sync)
//! `cx sources`         per-source assertion counts
//! `cx rm <needle>`     remove atoms whose text contains needle
//! `cx tags`            tag vocabulary with counts
//! `cx recommend`       suggest packs for this directory (rust/npm)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::exit;

use contextual::hub::{events_for_snapshot, Event, Hub};
use contextual::snapshot::Atom;
use contextual::{resolve, source_counts, tag_counts, SqliteStore, Storage};

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
cx export file    write this machine's snapshot (merge unit)
cx absorb file... merge other machines' snapshots into this bag
cx pull           fetch merged snapshot from the hub (CX_HUB_URL) and absorb
cx push           post this bag's atoms + tombstones to the hub as events
cx sources        per-source assertion counts
cx rm <needle>    remove matching atoms (records tombstones)
cx tags           tag vocabulary with counts
cx recommend      suggest packs for this directory (rust/npm)
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
                let stats =
                    contextual::add_doc(&mut store, &source, &text).unwrap_or_else(|e| panic!("cx: {e}"));
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
            let hub = Hub::from_env()
                .unwrap_or_else(|| {
                    eprintln!("cx pull: set CX_HUB_URL and CX_TOKEN");
                    exit(2);
                });
            let mut store = open_store();
            let snap = hub.fetch_snapshot().unwrap_or_else(|e| panic!("cx pull: {e}"));
            let stats =
                contextual::absorb_snapshot(&mut store, "hub", &snap).unwrap_or_else(|e| panic!("cx: {e}"));
            println!(
                "hub: +{} -{} kept {} ({} tombstones)",
                stats.added,
                stats.removed,
                stats.kept,
                snap.tombstones.len()
            );
        }
        "push" => {
            let hub = Hub::from_env()
                .unwrap_or_else(|| {
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
                    stats.added, stats.removed, stats.kept, snap.tombstones.len()
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
                        &victims.into_iter().map(|atom| Event::Remove { atom }).collect::<Vec<_>>(),
                    );
                }
                Err(e) => panic!("cx: {e}"),
            }
        }
        "tags" => {
            let store = open_store();
            for (tag, n) in tag_counts(&store).unwrap_or_else(|e| panic!("cx: {e}")) {
                println!("#{tag} {n}");
            }
        }
        "recommend" => exit(recommend()),
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
    let items = resolve(&store, tags).unwrap_or_else(|e| panic!("cx: {e}"));
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
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Suggest context packs for the current directory's ecosystem manifests.
fn recommend() -> i32 {
    let mut tags: Vec<&str> = Vec::new();
    if Path::new("Cargo.toml").exists() {
        tags.push("#rust");
    }
    if Path::new("package.json").exists() {
        tags.push("#npm");
    }
    if tags.is_empty() {
        println!("(no recognized manifest: Cargo.toml, package.json)");
        return 1;
    }
    println!("{}", tags.join(" "));
    0
}
