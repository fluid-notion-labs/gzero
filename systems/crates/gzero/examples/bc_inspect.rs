//! Debug: print every broadcast in a comms doc (no TTL filter, no
//! sender exclusion). Usage: cargo run --example bc_inspect -- [path]
use gzero::comms::CommsStore;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = match args.get(1) {
        Some(p) => std::path::PathBuf::from(p),
        None => gzero::comms::comms_db_path(),
    };
    let store = CommsStore::open(Some(&path)).unwrap();
    let bcs = store.debug_broadcasts().unwrap();
    if bcs.is_empty() {
        println!("no broadcasts on record");
        return;
    }
    for (id, sender, text, created) in bcs {
        println!("{created}  {id}  {sender}: {text}");
    }
}
