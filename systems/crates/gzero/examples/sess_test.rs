use gzero::comms::{CommsLayer, CommsStore};
fn main() {
    let mut store = CommsStore::open(Some(&gzero::comms::comms_db_path())).unwrap();
    let rows = store.all_sessions().unwrap();
    println!("{} sessions", rows.len());
}
