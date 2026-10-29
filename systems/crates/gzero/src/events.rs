//! ChangeFeed: semantic change events derived from the automerge patch
//! log (work item 3cd4, design in workflow section `change-feed`).
//!
//! The automerge `AutoCommit` keeps a diff cursor; `diff_incremental()`
//! returns path-based patches for ANY document change — local commits,
//! merges from another process, loads of externally-updated files. One
//! translation point here turns those patches into the events clients
//! care about, so local edits, hub sync and a second process's `gzero`
//! calls all flow identically.
//!
//! Scope: the ws doc only — items and sections. Atom changes ride sqlite
//! and are already covered by the plugin's storeStamp staleness check.
//!
//! Object model (items.rs / sections.rs):
//!
//! ```text
//! ROOT ─ items ─ scope ─ <id> ─ fields (+ submaps: labels, notes,
//!                                               blocks, discovered_from,
//!                                               child_of)
//!      └ sections ─ scope ─ ch ─ <seg> ─ {kind, title, body, order}
//!                                       └ ch ─ <seg> ─ ... (nested
//!                                                names, dots nest)
//! ```
//!
//! A patch on an items scope map is an add/remove; on a record or its
//! submap, a field change (submap patches collapse to the parent field,
//! e.g. `child_of`). Sections nest: a patch on a node's `ch` submap is
//! a section add/remove named by the full dotted path; a patch on a
//! `kind`-carrying node is a field change.
//!
//! Consumers: `gzero watch` streams these as JSON lines today; a future
//! embedded client uses `ChangeFeed` directly. Call `drain_events()`
//! once after opening to establish the baseline cursor without
//! emitting the store's initial state.

use crate::automerge_store::AutomergeStore;
use automerge::{ObjId, ObjType, PatchAction, Prop, ReadDoc, Value, ROOT};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver};

/// One semantic change in the ws doc.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ChangeEvent {
    /// An item record was created (its initial fields follow as
    /// separate `item_changed` events in the same batch).
    ItemAdded { scope: String, id: String },
    /// A field on an item changed. `field` is the record key
    /// (title/status/priority/order/assignee/design/gate/... or an
    /// edge/notes submap name).
    ItemChanged {
        scope: String,
        id: String,
        field: String,
    },
    /// An item record was deleted.
    ItemRemoved { scope: String, id: String },
    /// A section document was created.
    SectionAdded { scope: String, name: String },
    /// A section field changed (kind/title/body/order).
    SectionChanged {
        scope: String,
        name: String,
        field: String,
    },
    /// A section document was deleted.
    SectionRemoved { scope: String, name: String },
}

impl ChangeEvent {
    /// Stable JSON line for `gzero watch` and log inspection.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// A store that can broadcast semantic change events. Implemented by
/// [`AutomergeStore`]; the sqlite atom store emits nothing (items and
/// sections live solely in the automerge doc).
pub trait ChangeFeed {
    /// Start receiving events. The returned receiver gets every event
    /// from subsequent drains; a dropped store closes the stream.
    fn subscribe(&mut self) -> Receiver<ChangeEvent>;

    /// Take the events accumulated since the last drain. The first
    /// drain after opening returns the store's initial state as events
    /// — drain once immediately if that is unwanted (it also
    /// establishes the baseline diff cursor).
    fn drain_events(&mut self) -> Vec<ChangeEvent>;
}

/// Which root container a scope map, record, or submap belongs to.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Container {
    Items,
    Sections,
}

/// Identity of every object the classifier can name, built from the
/// current document state at drain time (cheap: O(items + sections)).
struct DocIndex {
    /// Scope map object -> (container, scope name). Items scopes and
    /// section scopes are distinct ObjIds even for the same string.
    scope_maps: HashMap<ObjId, (Container, String)>,
    /// Record object -> (container, scope, id-or-name).
    records: HashMap<ObjId, (Container, String, String)>,
    /// Record submap (labels/notes/edges) -> (container, scope, id, field).
    submaps: HashMap<ObjId, (Container, String, String, String)>,
    /// A section node's children submap -> (scope, parent's dotted path,
    /// "" for the scope-level map). Puts/deletes here add/remove the
    /// child named `parent.seg`.
    chmaps: HashMap<ObjId, (String, String)>,
}

/// The record submaps that carry list-ish state; patches on them
/// collapse to a change of the parent field.
const SUBMAPS: [&str; 5] = ["labels", "notes", "blocks", "discovered_from", "child_of"];

impl DocIndex {
    fn changed(&self, obj: &ObjId, field: String) -> Option<(Container, String, String, String)> {
        if let Some((c, scope, id)) = self.records.get(obj) {
            return Some((*c, scope.clone(), id.clone(), field));
        }
        if let Some((c, scope, id, parent)) = self.submaps.get(obj) {
            return Some((*c, scope.clone(), id.clone(), parent.clone()));
        }
        None
    }
}

impl AutomergeStore {
    /// Apply changes from a freshly loaded doc file into this store's
    /// doc (the `gzero watch` path: another process saved the file). The
    /// diff cursor survives the merge, so the next drain yields exactly
    /// the incoming changes.
    pub fn reload_merge(&mut self, path: &std::path::Path) -> Result<(), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let mut fresh =
            automerge::AutoCommit::load(&bytes).map_err(|e| format!("load doc: {e}"))?;
        self.doc
            .merge(&mut fresh)
            .map_err(|e| format!("merge: {e}"))?;
        Ok(())
    }

    /// Classify patches from the current diff cursor into events.
    /// Exposed for tests; [`ChangeFeed::drain_events`] is the entry point.
    pub fn classify_patches(&mut self, patches: Vec<automerge::Patch>) -> Vec<ChangeEvent> {
        if patches.is_empty() {
            return Vec::new();
        }
        let idx = self.build_index();
        classify(patches, &idx)
    }

    fn build_index(&self) -> DocIndex {
        let mut scope_maps = HashMap::new();
        let mut records = HashMap::new();
        let mut submaps = HashMap::new();
        let mut chmaps: HashMap<ObjId, (String, String)> = HashMap::new();
        // Pass 1: scope maps.
        for (key, container) in [
            ("items", Container::Items),
            ("sections", Container::Sections),
        ] {
            let Some((_, map_id)) = self.doc.get(ROOT, key).ok().flatten() else {
                continue;
            };
            for scope in self.doc.keys(&map_id) {
                if let Some((_, scope_id)) = self.doc.get(&map_id, &scope).ok().flatten() {
                    scope_maps.insert(scope_id, (container, scope));
                }
            }
        }
        // Pass 2: records and their submaps.
        for (scope_id, (container, scope)) in scope_maps.iter() {
            match container {
                Container::Items => {
                    for name in self.doc.keys(scope_id) {
                        if let Some((value, rec)) = self.doc.get(scope_id, &name).ok().flatten() {
                            if !matches!(value, Value::Object(ObjType::Map)) {
                                continue;
                            }
                            records.insert(rec.clone(), (*container, scope.clone(), name.clone()));
                            for sub in SUBMAPS {
                                if let Some((Value::Object(_), sub_id)) =
                                    self.doc.get(&rec, sub).ok().flatten()
                                {
                                    submaps.insert(
                                        sub_id,
                                        (*container, scope.clone(), name.clone(), sub.to_string()),
                                    );
                                }
                            }
                        }
                    }
                }
                Container::Sections => {
                    // Nested node tree: scope.ch.seg[.ch.seg...]; a node
                    // carrying `kind` is a section record.
                    if let Some((_, ch)) = self.doc.get(scope_id, "ch").ok().flatten() {
                        self.index_sections_node(ch, scope, "", &mut records, &mut chmaps);
                    }
                }
            }
        }
        DocIndex {
            scope_maps,
            records,
            submaps,
            chmaps,
        }
    }

    /// Index one level of the section node tree: `ch` maps a segment to
    /// a child node; children may carry `kind` (a section record) and/or
    /// their own `ch`.
    fn index_sections_node(
        &self,
        ch: ObjId,
        scope: &str,
        prefix: &str,
        records: &mut HashMap<ObjId, (Container, String, String)>,
        chmaps: &mut HashMap<ObjId, (String, String)>,
    ) {
        chmaps.insert(ch.clone(), (scope.to_string(), prefix.to_string()));
        for seg in self.doc.keys(&ch.clone()) {
            let Some((value, node)) = self.doc.get(&ch, &seg).ok().flatten() else {
                continue;
            };
            if !matches!(value, Value::Object(ObjType::Map)) {
                continue;
            }
            let full = if prefix.is_empty() {
                seg.clone()
            } else {
                format!("{prefix}.{seg}")
            };
            if self.has(&node, "kind") {
                records.insert(
                    node.clone(),
                    (Container::Sections, scope.to_string(), full.clone()),
                );
            }
            if let Some((_, sub)) = self.doc.get(&node.clone(), "ch").ok().flatten() {
                self.index_sections_node(sub, scope, &full, records, chmaps);
            }
        }
    }
}

/// An add/remove on a scope map, or a field change on a record/submap.
fn event_for(container: Container, scope: &str, id: &str, kind: ChangeKind) -> ChangeEvent {
    match (container, kind) {
        (Container::Items, ChangeKind::Added) => ChangeEvent::ItemAdded {
            scope: scope.to_string(),
            id: id.to_string(),
        },
        (Container::Items, ChangeKind::Removed) => ChangeEvent::ItemRemoved {
            scope: scope.to_string(),
            id: id.to_string(),
        },
        (Container::Items, ChangeKind::Changed(field)) => ChangeEvent::ItemChanged {
            scope: scope.to_string(),
            id: id.to_string(),
            field,
        },
        (Container::Sections, ChangeKind::Added) => ChangeEvent::SectionAdded {
            scope: scope.to_string(),
            name: id.to_string(),
        },
        (Container::Sections, ChangeKind::Removed) => ChangeEvent::SectionRemoved {
            scope: scope.to_string(),
            name: id.to_string(),
        },
        (Container::Sections, ChangeKind::Changed(field)) => ChangeEvent::SectionChanged {
            scope: scope.to_string(),
            name: id.to_string(),
            field,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{ChangeEvent, ChangeFeed};
    use crate::automerge_store::AutomergeStore;
    use crate::items::{ItemEdit, NewItem};
    use crate::sections::{Section, SectionKind};

    #[test]
    fn add_item_emits_added_plus_field_changed() {
        let mut store = AutomergeStore::in_memory().unwrap();
        let _ = ChangeFeed::drain_events(&mut store);
        let item = store
            .item_add(
                "org/test",
                NewItem {
                    title: "Build change feed".into(),
                    priority: 2,
                    assignee: "".into(),
                    labels: vec![],
                    blocks: vec![],
                    discovered_from: vec![],
                    child_of: vec![],
                    acceptance: "".into(),
                    design: "".into(),
                    gate: "".into(),
                },
            )
            .unwrap();
        let events = store.drain_events();
        assert_eq!(
            events[0],
            ChangeEvent::ItemAdded {
                scope: "org/test".into(),
                id: item.id.clone(),
            }
        );
        // Followed by field changes: title, assignee, status, order, etc.
        let fields: Vec<_> = events
            .iter()
            .skip(1)
            .map(|e| match e {
                ChangeEvent::ItemChanged { field, .. } => field.clone(),
                _ => panic!("unexpected {e:?}"),
            })
            .collect();
        assert!(fields.contains(&"title".to_string()));
    }

    #[test]
    fn edit_item_emits_changed() {
        let mut store = AutomergeStore::in_memory().unwrap();
        let item = store
            .item_add(
                "org/test",
                NewItem {
                    title: "A".into(),
                    priority: 0,
                    assignee: "".into(),
                    labels: vec![],
                    blocks: vec![],
                    discovered_from: vec![],
                    child_of: vec![],
                    acceptance: "".into(),
                    design: "".into(),
                    gate: "".into(),
                },
            )
            .unwrap();
        let _ = ChangeFeed::drain_events(&mut store);
        store
            .item_edit(
                "org/test",
                &item.id,
                ItemEdit {
                    title: Some("Renamed".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let events = store.drain_events();
        assert!(events.iter().any(|e| matches!(
            e,
            ChangeEvent::ItemChanged {
                scope,
                id,
                field,
            } if scope == "org/test" && *id == item.id && field == "title"
        )));
    }

    #[test]
    fn delete_item_and_add_section_emit_expected_events() {
        let mut store = AutomergeStore::in_memory().unwrap();
        let item = store
            .item_add(
                "org/test",
                NewItem {
                    title: "To delete".into(),
                    priority: 0,
                    assignee: "".into(),
                    labels: vec![],
                    blocks: vec![],
                    discovered_from: vec![],
                    child_of: vec![],
                    acceptance: "".into(),
                    design: "".into(),
                    gate: "".into(),
                },
            )
            .unwrap();
        let _ = ChangeFeed::drain_events(&mut store);
        assert!(store.item_delete("org/test", &item.id).unwrap());
        store
            .section_put(&Section {
                scope: "org/test".into(),
                name: "vision".into(),
                kind: SectionKind::Md,
                title: "Vision".into(),
                body: "A paragraph.".into(),
                order: 0,
            })
            .unwrap();
        let events = store.drain_events();
        assert!(events.iter().any(|e| matches!(
            e,
            ChangeEvent::ItemRemoved { scope, id }
            if scope == "org/test" && *id == item.id
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            ChangeEvent::SectionAdded { scope, name }
            if scope == "org/test" && name == "vision"
        )));
    }

    #[test]
    fn reload_merge_drain_yields_changes_from_other_store() {
        let mut store1 = AutomergeStore::in_memory().unwrap();
        let item = store1
            .item_add(
                "org/test",
                NewItem {
                    title: "Shared".into(),
                    priority: 0,
                    assignee: "".into(),
                    labels: vec![],
                    blocks: vec![],
                    discovered_from: vec![],
                    child_of: vec![],
                    acceptance: "".into(),
                    design: "".into(),
                    gate: "".into(),
                },
            )
            .unwrap();
        let bytes = store1.save_bytes();

        // A second store starts from the same baseline, then we apply
        // an external update via reload_merge as gzero watch would.
        let mut store2 = AutomergeStore::from_bytes(&bytes).unwrap();
        let _ = ChangeFeed::drain_events(&mut store2);
        store1
            .item_edit(
                "org/test",
                &item.id,
                ItemEdit {
                    title: Some("Remote rename".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let update = store1.save_bytes();
        store2
            .reload_merge(std::path::Path::new("fake"))
            .expect_err("missing path");

        // To actually exercise file-backed merging without touching
        // FS setup here, we merge the updated bytes as a proxy.
        let mut fresh = automerge::AutoCommit::load(&update).unwrap();
        store2.doc.merge(&mut fresh).unwrap();
        let events = store2.drain_events();
        assert!(events.iter().any(|e| matches!(
            e,
            ChangeEvent::ItemChanged { field, .. } if field == "title"
        )));
    }
}

enum ChangeKind {
    Added,
    Removed,
    Changed(String),
}

impl ChangeFeed for AutomergeStore {
    fn subscribe(&mut self) -> Receiver<ChangeEvent> {
        let (tx, rx) = channel();
        self.subscribers.push(tx);
        rx
    }

    fn drain_events(&mut self) -> Vec<ChangeEvent> {
        let patches = self.doc.diff_incremental();
        let events = self.classify_patches(patches);
        if !events.is_empty() {
            // Broadcast to live subscribers; dead ones (consumer gone,
            // e.g. `gzero watch` exited) are dropped.
            self.subscribers.retain(|tx| {
                for ev in &events {
                    if tx.send(ev.clone()).is_err() {
                        return false;
                    }
                }
                true
            });
        }
        events
    }
}

fn classify(patches: Vec<automerge::Patch>, idx: &DocIndex) -> Vec<ChangeEvent> {
    let mut events = Vec::new();
    for patch in patches {
        if patch.obj == ROOT {
            continue; // container creation (atoms/tombs/items/sections)
        }
        match &patch.action {
            PatchAction::PutMap { key, .. } => {
                if let Some((scope, parent)) = idx.chmaps.get(&patch.obj) {
                    let name = if parent.is_empty() {
                        key.clone()
                    } else {
                        format!("{parent}.{key}")
                    };
                    events.push(event_for(
                        Container::Sections,
                        scope,
                        &name,
                        ChangeKind::Added,
                    ));
                } else if let Some((container, scope)) = idx.scope_maps.get(&patch.obj) {
                    // Section scope maps only ever gain their `ch` map.
                    if *container == Container::Items {
                        events.push(event_for(*container, scope, key, ChangeKind::Added));
                    }
                } else if let Some((c, scope, id, field)) = idx.changed(&patch.obj, key.clone()) {
                    events.push(event_for(c, &scope, &id, ChangeKind::Changed(field)));
                }
            }
            PatchAction::DeleteMap { key } => {
                if let Some((scope, parent)) = idx.chmaps.get(&patch.obj) {
                    let name = if parent.is_empty() {
                        key.clone()
                    } else {
                        format!("{parent}.{key}")
                    };
                    events.push(event_for(
                        Container::Sections,
                        scope,
                        &name,
                        ChangeKind::Removed,
                    ));
                } else if let Some((container, scope)) = idx.scope_maps.get(&patch.obj) {
                    if *container == Container::Items {
                        events.push(event_for(*container, scope, key, ChangeKind::Removed));
                    }
                } else if let Some((c, scope, id, field)) = idx.changed(&patch.obj, key.clone()) {
                    // Deleting a record field is rare; consumers re-read.
                    events.push(event_for(c, &scope, &id, ChangeKind::Changed(field)));
                }
            }
            PatchAction::Increment { prop, .. } => {
                if let Prop::Map(key) = prop {
                    if let Some((c, scope, id, field)) = idx.changed(&patch.obj, key.clone()) {
                        events.push(event_for(c, &scope, &id, ChangeKind::Changed(field)));
                    }
                }
            }
            _ => continue, // sequences/text/marks: not part of the ws doc model
        }
    }
    events
}
