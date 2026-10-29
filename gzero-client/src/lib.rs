//! Read-only Rust client for gzero data: work items, sections, atoms.
//!
//! Opens the local automerge doc (`CX_WS_DB`, default
//! `~/.pi/agent/context.ws`) exactly the way the gzero CLI does and
//! exposes read queries over one scope. Writes stay with the CLI: the
//! client never saves the doc, so an app embedding it can run
//! alongside `gzero` safely (the store's file lock still guards the
//! doc file; reads load a snapshot).
//!
//! Scope resolution matches the CLI: repo identity from the current
//! directory (git origin URL, else repo path), falling back to
//! `global`.

pub use gzero::items::{Status, WorkItem};
pub use gzero::sections::{Section, SectionChild, SectionKind};

use gzero::AutomergeStore;
use std::path::Path;

/// Read handle on the gzero doc for one scope.
pub struct Client {
    store: AutomergeStore,
    scope: String,
}

impl Client {
    /// Open the default doc read-only; scope from the current
    /// directory.
    pub fn open() -> Result<Self, String> {
        Self::open_at(&gzero::sections::default_ws_path())
    }

    /// Open a doc at `path` read-only; scope from the current directory.
    pub fn open_at(path: &Path) -> Result<Self, String> {
        let store = AutomergeStore::open(Some(path)).map_err(|e| e.to_string())?;
        Ok(Self {
            store,
            scope: gzero::repo_identity().unwrap_or_else(|| "global".to_string()),
        })
    }

    /// Override the scope (repo identity is just the default).
    pub fn with_scope(mut self, scope: impl Into<String>) -> Self {
        self.scope = scope.into();
        self
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    /// All items in this client's scope.
    pub fn items(&self) -> Result<Vec<WorkItem>, String> {
        self.store.item_list(&self.scope).map_err(|e| e.to_string())
    }

    /// Resolve an id or id prefix within the scope, then fetch it.
    pub fn item(&self, id: &str) -> Result<Option<WorkItem>, String> {
        let full = self
            .store
            .item_resolve(&self.scope, id)
            .map_err(|e| e.to_string())?;
        self.store
            .item_get(&self.scope, &full)
            .map_err(|e| e.to_string())
    }

    /// Direct children of an item, highest priority first.
    pub fn children(&self, id: &str) -> Result<Vec<WorkItem>, String> {
        self.store
            .item_children(&self.scope, id)
            .map_err(|e| e.to_string())
    }

    /// Open items nothing blocks, ranked for "what next".
    pub fn ready(&self) -> Result<Vec<WorkItem>, String> {
        self.store
            .item_rank(&self.scope)
            .map(|ranked| ranked.into_iter().map(|r| r.item).collect())
            .map_err(|e| e.to_string())
    }

    /// Scopes that have items (across the whole doc).
    pub fn scopes(&self) -> Result<Vec<String>, String> {
        self.store.item_scopes().map_err(|e| e.to_string())
    }

    /// One section by dotted name in this client's scope.
    pub fn section(&self, name: &str) -> Result<Option<Section>, String> {
        self.store
            .section_get(&self.scope, name)
            .map_err(|e| e.to_string())
    }

    /// All sections in this client's scope.
    pub fn sections(&self) -> Result<Vec<Section>, String> {
        self.store
            .section_list(&self.scope)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gzero::items::NewItem;

    fn temp_doc(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "gzero-client-test-{}-{}.ws",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn items_round_trip_and_prefix_resolve() {
        let path = temp_doc("round-trip");
        {
            let mut store = AutomergeStore::open(Some(&path)).unwrap();
            store
                .item_add(
                    "test/scope",
                    NewItem {
                        title: "client crate reads items".into(),
                        priority: 3,
                        assignee: String::new(),
                        labels: vec!["gzero-client".into()],
                        blocks: vec![],
                        discovered_from: vec![],
                        child_of: vec![],
                        acceptance: String::new(),
                        design: String::new(),
                        gate: String::new(),
                    },
                )
                .unwrap();
        }
        let client = Client::open_at(&path).unwrap().with_scope("test/scope");
        let items = client.items().unwrap();
        assert_eq!(items.len(), 1);
        let full_id = items[0].id.clone();
        let by_prefix = client.item(&full_id[..4]).unwrap().unwrap();
        assert_eq!(by_prefix.title, "client crate reads items");
        assert_eq!(client.scope(), "test/scope");
        let _ = std::fs::remove_file(&path);
    }
}
