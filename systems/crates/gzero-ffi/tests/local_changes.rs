#![cfg(feature = "diagnostics")]

// Diagnostic: how many changes does a saved doc's history contain?
#[cfg(feature = "diagnostics")]
use gzero_ffi::gz_doc_changes_test;

#[test]
fn count_changes() {
    let Ok(path) = std::env::var("COMMS_DOC") else {
        eprintln!("set COMMS_DOC=<path>");
        return;
    };
    let bytes = std::fs::read(&path).expect("read doc");
    let (count, heads) = gz_doc_changes_test(&bytes);
    println!("changes in history: {count}, heads: {heads}");
}
