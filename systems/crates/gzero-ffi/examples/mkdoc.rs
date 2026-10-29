//! Generates small fixture documents for the Dart FFI tests.
//!
//!     cargo run --example mkdoc -- <out.bin>            # trivial doc
//!     cargo run --example mkdoc -- <out.bin> --items    # items/projects doc
//!
//! The trivial doc is one change (ROOT.hello = world). The items doc
//! carries the context doc's project schema (src/items.rs) so the Dart
//! projects parser can be tested against real automerge bytes via FFI.

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjType, ROOT};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .expect("usage: mkdoc <out-path> [--items]")
        .clone();
    let with_items = args.iter().any(|a| a == "--items");

    let mut doc = AutoCommit::new();
    doc.put(ROOT, "hello", "world").expect("put");
    if with_items {
        let items = doc
            .put_object(ROOT, "items", ObjType::Map)
            .expect("put items");
        let scope = doc
            .put_object(&items, "project/tablet", ObjType::Map)
            .expect("put scope");
        let a = doc
            .put_object(&scope, "itm_1", ObjType::Map)
            .expect("put item");
        doc.put(&a, "title", "wire up projects").expect("title");
        doc.put(&a, "status", "in_progress").expect("status");
        doc.put(&a, "priority", 5i64).expect("priority");
        let b = doc
            .put_object(&scope, "itm_2", ObjType::Map)
            .expect("put item");
        doc.put(&b, "title", "done thing").expect("title");
        doc.put(&b, "status", "closed").expect("status");
        // a second scope, empty — renders as a project with 0 items
        doc.put_object(&items, "comms", ObjType::Map)
            .expect("put scope");
    }
    doc.commit();
    std::fs::write(&path, doc.save()).expect("write fixture");
    println!("wrote {}", path);
}
