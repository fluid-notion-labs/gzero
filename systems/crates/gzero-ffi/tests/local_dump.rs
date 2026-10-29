#![cfg(feature = "diagnostics")]

// Manual diagnostic: dump a comms doc's sessions/messages as JSON.
// Run: cargo test --test local_dump -- --nocapture [path]
use gzero_ffi::gz_doc_open_test;

#[test]
fn dump() {
    let Ok(path) = std::env::var("COMMS_DOC") else {
        eprintln!("set COMMS_DOC=<path> to run");
        return;
    };
    let bytes = std::fs::read(&path).expect("read doc");
    println!("{}", gz_doc_open_test(&bytes));
}
