//! `cx` — the context bag CLI.
//!
//! `cx`                 print default context (untagged atoms)
//! `cx #tag ...`        default plus tagged atoms
//! `cx add file.md ...` import markdown into the bag
//! `cx rm <needle>`     remove atoms whose text contains needle
//! `cx tags`            tag vocabulary with counts
//! `cx recommend`       suggest packs for this directory (rust/npm)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::exit;

use contextual::{add_doc, resolve, tag_counts, SqliteStore, Storage};

const USAGE: &str = "cx — context bag
cx                default context (untagged atoms)
cx #tag ...       default plus tagged atoms
cx add file.md    import context markdown into the bag
cx rm <needle>    remove matching atoms
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
            let mut total = 0;
            for f in &args[1..] {
                let text = std::fs::read_to_string(f)
                    .unwrap_or_else(|e| panic!("cx: {}: {e}", f));
                total += add_doc(&mut store, &text).unwrap_or_else(|e| panic!("cx: {e}"));
            }
            println!("imported {total} atoms (bag: {})", store.all().unwrap().len());
        }
        "rm" => {
            if args.len() < 2 {
                eprintln!("usage: cx rm <needle>");
                exit(2);
            }
            let needle = args[1..].join(" ");
            let mut store = open_store();
            match store.remove_matching(&needle) {
                Ok(0) => println!("(no matches)"),
                Ok(n) => println!("removed {n}"),
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
    for (text, e) in items {
        let key = format!("{}/{}", e.scope, e.node);
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
