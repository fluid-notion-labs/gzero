//! Debug: print the section tree of a ws store as nested structure.
//! Usage: cargo run --example ws_inspect -- [path] [scope]
use contextual::AutomergeStore;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).cloned();
    let scope = args.get(2).cloned().unwrap_or_default();
    let store = match path.as_deref() {
        Some(p) => AutomergeStore::open(Some(std::path::Path::new(p))).unwrap(),
        None => AutomergeStore::open(None).unwrap(),
    };
    let scopes = store.section_scopes().unwrap();
    let scope = if scope.is_empty() {
        scopes.first().cloned().unwrap_or_default()
    } else {
        scope
    };
    println!("scope: {scope} (all: {scopes:?})");
    fn walk(
        s: &AutomergeStore,
        scope: &str,
        prefix: &str,
        depth: usize,
    ) {
        for c in s.section_children(scope, prefix).unwrap() {
            let kind = if c.is_section { "●" } else { "○" };
            println!("{}{kind} {}", "  ".repeat(depth), c.seg);
            if c.has_children {
                walk(s, scope, &c.path, depth + 1);
            }
        }
    }
    walk(&store, &scope, "", 0);
}
