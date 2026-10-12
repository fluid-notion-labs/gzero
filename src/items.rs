//! Work items: the workflow system's state layer (plan3 W2).
//!
//! A `work_item` is a named record with a lifecycle — tasks, bugs,
//! epics. Fields follow plan2's schema:
//!
//! - **LWW fields** (single current truth, latest write wins):
//!   `title`, `priority`, `status`, `assignee`, `acceptance`, `design`
//! - **OR-sets** (accumulate; a concurrent add is never lost):
//!   `labels`, `notes` (append-only, id-keyed), and the typed edges
//!   `blocks` / `discovered_from` / `child_of`
//!
//! Identity is a short random id with collision remap — items are
//! *named*, not content-keyed (unlike atoms). History is the automerge
//! change log itself: every mutation is an op with actor and
//! timestamp, so attributability is inherent, not built. `ready` is a
//! fold: an open item whose `blocks`-blockers are all closed (missing
//! targets count as closed — deletions never wedge the graph).
//!
//! Doc shape (inside the bag doc):
//! ```text
//! root
//! └─ items: Map<scope -> Map<id -> item>>
//! ```
//! where item is
//! ```text
//! { title, priority, status, assignee, acceptance, design, created,
//!   labels: Map<label -> true>, notes: Map<note_id -> text>,
//!   blocks: Map<id -> true>, discovered_from: Map<id -> true>,
//!   child_of: Map<id -> true> }
//! ```
//!
//! Item deletion removes the key and leaves dangling edge references
//! in other items (OR-set semantics: removals don't propagate); folds
//! tolerate them. Status transitions: `open ↔ in_progress`, any →
//! `closed`, `closed → open` (reopen) — `closed → in_progress` is
//! rejected.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::hash::{Hash, Hasher};

use automerge::transaction::Transactable;
use automerge::{ObjId, ObjType, ReadDoc, ROOT};

use crate::automerge_store::AutomergeStore;
use crate::Result;

/// Item status with legal transitions (see module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    Open,
    InProgress,
    Closed,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::InProgress => "in_progress",
            Status::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Status::Open),
            "in_progress" => Some(Status::InProgress),
            "closed" => Some(Status::Closed),
            _ => None,
        }
    }

    /// Whether the transition `from -> to` is legal.
    pub fn transition(from: Status, to: Status) -> bool {
        use Status::*;
        match (from, to) {
            (a, b) if a == b => true,
            (Closed, Open) => true,                        // reopen
            (Open, InProgress) => true,                    // claim
            (Open, Closed) | (InProgress, Closed) => true, // close
            (InProgress, Open) => true,                    // unclaim
            _ => false,                                    // closed -> in_progress
        }
    }
}

/// Edge kinds. `blocks` on item A means A blocks its targets; an item
/// is ready when every item whose `blocks` set contains it is closed.
/// `child_of` builds hierarchies (epics are items with children);
/// `discovered_from` records where noticed work came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Blocks,
    DiscoveredFrom,
    ChildOf,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Blocks => "blocks",
            EdgeKind::DiscoveredFrom => "discovered_from",
            EdgeKind::ChildOf => "child_of",
        }
    }
}

/// One work item, fully materialized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkItem {
    pub scope: String,
    pub id: String,
    pub title: String,
    /// Larger = more important. Default 0.
    pub priority: i64,
    pub status: Status,
    pub assignee: String,
    pub acceptance: String,
    pub design: String,
    /// Creation time, millis since the epoch.
    pub created: u64,
    pub labels: BTreeSet<String>,
    /// Append-only notes: note id -> text.
    pub notes: BTreeMap<String, String>,
    pub blocks: BTreeSet<String>,
    pub discovered_from: BTreeSet<String>,
    pub child_of: BTreeSet<String>,
}

impl WorkItem {
    pub fn is_open(&self) -> bool {
        self.status != Status::Closed
    }
}

/// Fields for `item_add` (defaults via `Default`).
#[derive(Debug, Clone, Default)]
pub struct NewItem {
    pub title: String,
    pub priority: i64,
    pub assignee: String,
    pub labels: Vec<String>,
    pub blocks: Vec<String>,
    pub discovered_from: Vec<String>,
    pub child_of: Vec<String>,
    pub acceptance: String,
    pub design: String,
}

/// LWW field edits for `item_edit`.
#[derive(Debug, Clone, Default)]
pub struct ItemEdit {
    pub title: Option<String>,
    pub priority: Option<i64>,
    pub assignee: Option<String>,
    pub acceptance: Option<String>,
    pub design: Option<String>,
    pub status: Option<Status>,
}

impl AutomergeStore {
    // ---- creation / read ----

    /// Create an item with a fresh id. Edge targets must already exist
    /// in the same scope.
    pub fn item_add(&mut self, scope: &str, new: NewItem) -> Result<WorkItem> {
        if new.title.trim().is_empty() {
            return Err("item: title is required".into());
        }
        let items = self.ensure_items()?;
        let scope_id = match self.doc.get(&items, scope)? {
            Some((_, id)) => id,
            None => {
                let sid = self.doc.put_object(&items, scope, ObjType::Map)?;
                self.doc.commit();
                sid
            }
        };
        let existing: HashSet<String> = self.doc.keys(&scope_id).collect();
        let id = fresh_id(&existing);
        let rec = self.doc.put_object(&scope_id, &id, ObjType::Map)?;
        self.doc.put(&rec, "title", new.title.trim())?;
        self.doc.put(&rec, "priority", new.priority)?;
        self.doc.put(&rec, "status", Status::Open.as_str())?;
        self.doc.put(&rec, "assignee", new.assignee.as_str())?;
        self.doc.put(&rec, "acceptance", new.acceptance.as_str())?;
        self.doc.put(&rec, "design", new.design.as_str())?;
        self.doc.put(&rec, "created", created_millis())?;
        for sub in ["labels", "notes", "blocks", "discovered_from", "child_of"] {
            self.doc.put_object(&rec, sub, ObjType::Map)?;
        }
        self.doc.commit();
        self.flush()?;

        // Edge validation and set population go through the public
        // mutators (one code path; they re-fetch the record).
        for label in &new.labels {
            self.item_label(scope, &id, label, true)?;
        }
        for t in &new.blocks {
            self.item_edge(scope, &id, EdgeKind::Blocks, t, true)?;
        }
        for t in &new.discovered_from {
            self.item_edge(scope, &id, EdgeKind::DiscoveredFrom, t, true)?;
        }
        for t in &new.child_of {
            self.item_edge(scope, &id, EdgeKind::ChildOf, t, true)?;
        }
        Ok(self.item_get(scope, &id)?.expect("item was just created"))
    }

    /// Resolve an id or id *prefix* to the full id (exact match first;
    /// a unique prefix match wins; ambiguity errors with candidates).
    pub fn item_resolve(&self, scope: &str, id: &str) -> Result<String> {
        if self.item_get(scope, id)?.is_some() {
            return Ok(id.to_string());
        }
        let matches: Vec<String> = self
            .item_list(scope)?
            .into_iter()
            .map(|it| it.id)
            .filter(|full| full.starts_with(id))
            .collect();
        match matches.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(format!("item: no item matches {id:?} in {scope:?}").into()),
            many => Err(format!("item: {id:?} is ambiguous: {}", many.join(", ")).into()),
        }
    }

    /// Read one item.
    pub fn item_get(&self, scope: &str, id: &str) -> Result<Option<WorkItem>> {
        let Some(rec) = self.item_rec(scope, id)? else {
            return Ok(None);
        };
        Ok(Some(self.read_item(scope, id, &rec)))
    }

    /// All items in a scope, ordered by id.
    pub fn item_list(&self, scope: &str) -> Result<Vec<WorkItem>> {
        let mut out = Vec::new();
        if let Some(items) = self.items_opt() {
            if let Some((_, scope_id)) = self.doc.get(&items, scope)? {
                for id in self.doc.keys(&scope_id) {
                    if let Some(it) = self.item_get(scope, &id)? {
                        out.push(it);
                    }
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// Scopes that hold at least one item, sorted.
    pub fn item_scopes(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if let Some(items) = self.items_opt() {
            for scope in self.doc.keys(&items) {
                if let Some((_, scope_id)) = self.doc.get(&items, scope.as_str())? {
                    if self.doc.keys(&scope_id).next().is_some() {
                        out.push(scope);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Delete an item. Dangling references in other items are left
    /// (folds treat missing targets as closed).
    pub fn item_delete(&mut self, scope: &str, id: &str) -> Result<bool> {
        let Some(items) = self.items_opt() else {
            return Ok(false);
        };
        let Some((_, scope_id)) = self.doc.get(&items, scope)? else {
            return Ok(false);
        };
        if !self.has(&scope_id, id) {
            return Ok(false);
        }
        self.doc.delete(&scope_id, id)?;
        self.doc.commit();
        self.flush()?;
        Ok(true)
    }

    // ---- LWW edits ----

    /// Apply LWW field edits; rejects illegal status transitions.
    pub fn item_edit(&mut self, scope: &str, id: &str, edit: ItemEdit) -> Result<WorkItem> {
        let Some(item) = self.item_get(scope, id)? else {
            return Err(format!("item: no item {id:?} in {scope:?}").into());
        };
        if let Some(to) = edit.status {
            if !Status::transition(item.status, to) {
                return Err(format!(
                    "item: illegal transition {} -> {}",
                    item.status.as_str(),
                    to.as_str()
                )
                .into());
            }
        }
        let rec = self.item_rec(scope, id)?.expect("item exists");
        if let Some(t) = &edit.title {
            if t.trim().is_empty() {
                return Err("item: title cannot be empty".into());
            }
            self.doc.put(&rec, "title", t.trim())?;
        }
        if let Some(p) = edit.priority {
            self.doc.put(&rec, "priority", p)?;
        }
        if let Some(a) = &edit.assignee {
            self.doc.put(&rec, "assignee", a.as_str())?;
        }
        if let Some(a) = &edit.acceptance {
            self.doc.put(&rec, "acceptance", a.as_str())?;
        }
        if let Some(d) = &edit.design {
            self.doc.put(&rec, "design", d.as_str())?;
        }
        if let Some(s) = edit.status {
            self.doc.put(&rec, "status", s.as_str())?;
        }
        self.doc.commit();
        self.flush()?;
        Ok(self.item_get(scope, id)?.expect("item exists"))
    }

    /// `open -> in_progress`.
    pub fn item_claim(&mut self, scope: &str, id: &str) -> Result<WorkItem> {
        self.item_edit(
            scope,
            id,
            ItemEdit {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
    }

    /// Any non-closed -> `closed`.
    pub fn item_close(&mut self, scope: &str, id: &str) -> Result<WorkItem> {
        self.item_edit(
            scope,
            id,
            ItemEdit {
                status: Some(Status::Closed),
                ..Default::default()
            },
        )
    }

    /// `closed -> open`.
    pub fn item_reopen(&mut self, scope: &str, id: &str) -> Result<WorkItem> {
        self.item_edit(
            scope,
            id,
            ItemEdit {
                status: Some(Status::Open),
                ..Default::default()
            },
        )
    }

    // ---- OR-sets ----

    /// Add or remove a label. Removal is a map delete; a concurrent
    /// add elsewhere still wins (OR-set).
    pub fn item_label(&mut self, scope: &str, id: &str, label: &str, add: bool) -> Result<()> {
        let l = normalize_label(label);
        if l.is_empty() {
            return Err("item: empty label".into());
        }
        let rec = self
            .item_rec(scope, id)?
            .ok_or_else(|| "item: no such item".to_string())?;
        let labels = self.submap(&rec, "labels")?;
        if add {
            self.doc.put(&labels, &l, true)?;
        } else {
            self.doc.delete(&labels, &l)?;
        }
        self.doc.commit();
        self.flush()
    }

    /// Append a note (never removed); returns the note id.
    pub fn item_note(&mut self, scope: &str, id: &str, text: &str) -> Result<String> {
        if text.trim().is_empty() {
            return Err("item: empty note".into());
        }
        let rec = self
            .item_rec(scope, id)?
            .ok_or_else(|| "item: no such item".to_string())?;
        let notes = self.submap(&rec, "notes")?;
        let existing: HashSet<String> = self.doc.keys(&notes).collect();
        let nid = fresh_id(&existing);
        self.doc.put(&notes, &nid, text)?;
        self.doc.commit();
        self.flush()?;
        Ok(nid)
    }

    /// Add or remove a typed edge. Adding requires the target to
    /// exist in the same scope; self-edges are rejected.
    pub fn item_edge(
        &mut self,
        scope: &str,
        id: &str,
        kind: EdgeKind,
        target: &str,
        add: bool,
    ) -> Result<()> {
        if target == id {
            return Err("item: self-edge".into());
        }
        if add && self.item_get(scope, target)?.is_none() {
            return Err(format!("item: edge target {target:?} does not exist in {scope:?}").into());
        }
        let rec = self
            .item_rec(scope, id)?
            .ok_or_else(|| "item: no such item".to_string())?;
        let edges = self.submap(&rec, kind.as_str())?;
        if add {
            self.doc.put(&edges, target, true)?;
        } else {
            self.doc.delete(&edges, target)?;
        }
        self.doc.commit();
        self.flush()
    }

    // ---- folds ----

    /// Open items whose blockers are all closed (or gone), sorted by
    /// priority (descending) then id.
    pub fn item_ready(&self, scope: &str) -> Result<Vec<WorkItem>> {
        let all = self.item_list(scope)?;
        let mut out: Vec<WorkItem> = all
            .iter()
            .filter(|it| it.is_open())
            .filter(|it| {
                !all.iter()
                    .any(|other| other.blocks.contains(&it.id) && other.status != Status::Closed)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    // ---- pinned (W3: "put task X in my context") ----

    fn pinned_opt(&self) -> Option<ObjId> {
        self.doc.get(ROOT, "pinned").ok().flatten().map(|(_, id)| id)
    }

    fn ensure_pinned(&mut self) -> Result<ObjId> {
        if let Some(id) = self.pinned_opt() {
            return Ok(id);
        }
        let id = self.doc.put_object(ROOT, "pinned", ObjType::Map)?;
        self.doc.commit();
        Ok(id)
    }

    /// Pin or unpin an item for injection. Pinning is the user's
    /// explicit "put task X in my context": resolve renders open pinned
    /// items every session. Nothing is ever pinned automatically, so
    /// the injected block stays small and stable.
    pub fn item_pin(&mut self, scope: &str, id: &str, pinned: bool) -> Result<WorkItem> {
        let full = self.item_resolve(scope, id)?;
        let item = self
            .item_get(scope, &full)?
            .ok_or_else(|| format!("item: {full} not found"))?;
        let pinned_map = self.ensure_pinned()?;
        let scope_id = match self.doc.get(&pinned_map, scope)? {
            Some((_, id)) => id,
            None => self.doc.put_object(&pinned_map, scope, ObjType::Map)?,
        };
        if pinned {
            self.doc.put(&scope_id, full.as_str(), true)?;
        } else if self.doc.get(&scope_id, &full)?.is_some() {
            self.doc.delete(&scope_id, &full)?;
        }
        self.flush()?;
        Ok(item)
    }

    /// Pinned items for a scope, ready-style order. Items deleted
    /// while pinned are skipped (and drop out on the next write).
    pub fn item_pinned(&self, scope: &str) -> Result<Vec<WorkItem>> {
        let ids = self.item_pinned_ids(scope)?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(it) = self.item_get(scope, &id)? {
                out.push(it);
            }
        }
        out.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    /// Just the pinned ids, for marking lists.
    pub fn item_pinned_ids(&self, scope: &str) -> Result<BTreeSet<String>> {
        let mut out = BTreeSet::new();
        if let Some(pinned) = self.pinned_opt() {
            if let Some((_, scope_id)) = self.doc.get(&pinned, scope)? {
                out.extend(self.doc.keys(&scope_id));
            }
        }
        Ok(out)
    }

    /// plan_next fold: top ready items ranked, each with human-readable
    /// evidence of why it is ready (unblocked, priority, labels,
    /// notes, subtasks).
    pub fn item_plan_next(&self, scope: &str, limit: usize) -> Result<Vec<(WorkItem, String)>> {
        let all = self.item_list(scope)?;
        Ok(self
            .item_ready(scope)?
            .into_iter()
            .take(limit)
            .map(|it| {
                let mut parts = vec!["unblocked".to_string()];
                if it.status == Status::InProgress {
                    parts.push("in progress".to_string());
                }
                parts.push(format!("p{}", it.priority));
                if !it.labels.is_empty() {
                    parts.push(
                        it.labels
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(","),
                    );
                }
                let notes = it.notes.len();
                if notes > 0 {
                    parts.push(format!("{notes} notes"));
                }
                let kids = all
                    .iter()
                    .filter(|other| other.child_of.contains(&it.id))
                    .count();
                if kids > 0 {
                    parts.push(format!("{kids} subtasks"));
                }
                (it, parts.join(" · "))
            })
            .collect())
    }

    /// Items that are children of `id` (reverse `child_of` lookup).
    pub fn item_children(&self, scope: &str, id: &str) -> Result<Vec<WorkItem>> {
        let mut out: Vec<WorkItem> = self
            .item_list(scope)?
            .into_iter()
            .filter(|it| it.child_of.contains(id))
            .collect();
        out.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    // ---- internal ----

    fn items_opt(&self) -> Option<ObjId> {
        self.doc.get(ROOT, "items").ok().flatten().map(|(_, id)| id)
    }

    fn ensure_items(&mut self) -> Result<ObjId> {
        if let Some(id) = self.items_opt() {
            return Ok(id);
        }
        let id = self.doc.put_object(ROOT, "items", ObjType::Map)?;
        self.doc.commit();
        Ok(id)
    }

    fn item_rec(&self, scope: &str, id: &str) -> Result<Option<ObjId>> {
        let Some(items) = self.items_opt() else {
            return Ok(None);
        };
        let Some((_, scope_id)) = self.doc.get(&items, scope)? else {
            return Ok(None);
        };
        Ok(self.doc.get(&scope_id, id)?.map(|(_, id)| id))
    }

    fn submap_opt(&self, rec: &ObjId, key: &str) -> Option<ObjId> {
        self.doc.get(rec, key).ok().flatten().map(|(_, id)| id)
    }

    fn submap(&self, rec: &ObjId, key: &str) -> Result<ObjId> {
        self.submap_opt(rec, key)
            .ok_or_else(|| format!("item: missing {key} map").into())
    }

    fn read_item(&self, scope: &str, id: &str, rec: &ObjId) -> WorkItem {
        let set_of = |key: &str| -> BTreeSet<String> {
            match self.submap_opt(rec, key) {
                Some(m) => self.doc.keys(&m).collect(),
                None => BTreeSet::new(),
            }
        };
        let notes: BTreeMap<String, String> = match self.submap_opt(rec, "notes") {
            Some(m) => self
                .doc
                .keys(&m)
                .map(|nid| {
                    let text = self.sval(&m, &nid);
                    (nid, text)
                })
                .collect(),
            None => BTreeMap::new(),
        };
        WorkItem {
            scope: scope.to_string(),
            id: id.to_string(),
            title: self.sval(rec, "title"),
            priority: self.ival(rec, "priority"),
            status: Status::parse(&self.sval(rec, "status")).unwrap_or_default(),
            assignee: self.sval(rec, "assignee"),
            acceptance: self.sval(rec, "acceptance"),
            design: self.sval(rec, "design"),
            created: self.ival(rec, "created").max(0) as u64,
            labels: set_of("labels"),
            notes,
            blocks: set_of("blocks"),
            discovered_from: set_of("discovered_from"),
            child_of: set_of("child_of"),
        }
    }
}

fn normalize_label(label: &str) -> String {
    label.trim().to_lowercase()
}

fn created_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Short random hex id: starts at 4 chars, widens on collision. Items
/// are named, so ids only need to be unique within a scope.
fn fresh_id(existing: &HashSet<String>) -> String {
    for len in [4usize, 6, 8, 12] {
        for salt in 0..64u64 {
            let id = hashed_hex(len, salt);
            if !existing.contains(&id) {
                return id;
            }
        }
    }
    hashed_hex(16, u64::MAX)
}

fn hashed_hex(len: usize, salt: u64) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (nanos, salt, std::process::id()).hash(&mut h);
    format!("{:016x}", h.finish())[..len].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automerge_store::AutomergeStore;

    fn new(title: &str) -> NewItem {
        NewItem {
            title: title.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn add_get_list_delete() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("first")).unwrap();
        assert_eq!(a.status, Status::Open);
        assert_eq!(a.id.len(), 4);
        let b = s.item_add("sc", new("second")).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(s.item_list("sc").unwrap().len(), 2);
        assert!(s.item_delete("sc", &a.id).unwrap());
        assert!(!s.item_delete("sc", &a.id).unwrap());
        assert!(s.item_get("sc", &a.id).unwrap().is_none());
        assert_eq!(s.item_list("sc").unwrap().len(), 1);
    }

    #[test]
    fn lifecycle_transitions() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let it = s.item_add("sc", new("t")).unwrap();
        let claimed = s.item_claim("sc", &it.id).unwrap();
        assert_eq!(claimed.status, Status::InProgress);
        let closed = s.item_close("sc", &it.id).unwrap();
        assert_eq!(closed.status, Status::Closed);
        // closed -> in_progress is illegal
        assert!(s.item_claim("sc", &it.id).is_err());
        let reopened = s.item_reopen("sc", &it.id).unwrap();
        assert_eq!(reopened.status, Status::Open);
    }

    #[test]
    fn ready_fold_respects_blocks() {
        let mut s = AutomergeStore::in_memory().unwrap();
        // An item's `blocks` set lists the ids *it* blocks, so the
        // blocker is created second, pointing at the blocked item.
        let mut n = new("blocked");
        n.priority = 5;
        let blocked = s.item_add("sc", n).unwrap();
        let mut b = new("blocker");
        b.blocks = vec![blocked.id.clone()];
        let blocker = s.item_add("sc", b).unwrap();
        // blocked is not ready while blocker is open
        let ready: Vec<String> = s
            .item_ready("sc")
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ready, vec![blocker.id.clone()]);
        s.item_close("sc", &blocker.id).unwrap();
        let ready: Vec<String> = s
            .item_ready("sc")
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ready, vec![blocked.id.clone()]);
    }

    #[test]
    fn dangling_blocker_is_ignored() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let blocked = s.item_add("sc", new("blocked")).unwrap();
        let mut b = new("blocker");
        b.blocks = vec![blocked.id.clone()];
        let blocker = s.item_add("sc", b).unwrap();
        s.item_delete("sc", &blocker.id).unwrap();
        // the deleted blocker no longer wedges anything
        let ready = s.item_ready("sc").unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].title, "blocked");
    }

    #[test]
    fn pin_roundtrip_and_ordering() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let mut a = new("a");
        a.priority = 1;
        let a = s.item_add("sc", a).unwrap();
        let mut b = new("b");
        b.priority = 9;
        let b = s.item_add("sc", b).unwrap();
        assert!(s.item_pinned("sc").unwrap().is_empty());
        s.item_pin("sc", &a.id, true).unwrap();
        s.item_pin("sc", &b.id, true).unwrap();
        let pinned: Vec<String> = s.item_pinned("sc").unwrap().into_iter().map(|i| i.id).collect();
        // priority order, not pin order
        assert_eq!(pinned, vec![b.id.clone(), a.id.clone()]);
        // idempotent-ish: unpin by full id works
        s.item_pin("sc", &a.id, false).unwrap();
        assert_eq!(s.item_pinned("sc").unwrap().len(), 1);
        // unpinned ids do not linger
        assert!(!s.item_pinned_ids("sc").unwrap().contains("a"));
    }

    #[test]
    fn pinned_skips_deleted_items() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        s.item_pin("sc", &a.id, true).unwrap();
        s.item_delete("sc", &a.id).unwrap();
        assert!(s.item_pinned("sc").unwrap().is_empty());
    }

    #[test]
    fn plan_next_ranks_and_explains() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let mut a = new("alpha");
        a.priority = 4;
        let a = s.item_add("sc", a).unwrap();
        s.item_note("sc", &a.id, "hello").unwrap();
        let mut b = new("blocked");
        b.priority = 9;
        let blocked = s.item_add("sc", b).unwrap();
        let mut r = new("root");
        r.blocks = vec![blocked.id.clone()];
        let root = s.item_add("sc", r).unwrap();
        let pairs = s.item_plan_next("sc", 5).unwrap();
        // alpha and the (unblocked) blocker are ready; blocked is not
        assert_eq!(pairs.len(), 2, "blocked item is not ready");
        assert_eq!(pairs[0].0.id, a.id, "higher priority ranks first");
        assert!(pairs[0].1.contains("unblocked"));
        assert!(pairs[0].1.contains("p4"));
        assert!(pairs[0].1.contains("1 notes"));
        assert_eq!(pairs[1].0.id, root.id);
    }

    #[test]
    fn edges_validate_targets_and_self() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        assert!(s
            .item_edge("sc", &a.id, EdgeKind::Blocks, "zzzz", true)
            .is_err());
        assert!(s
            .item_edge("sc", &a.id, EdgeKind::Blocks, &a.id, true)
            .is_err());
        let b = s.item_add("sc", new("b")).unwrap();
        s.item_edge("sc", &b.id, EdgeKind::ChildOf, &a.id, true)
            .unwrap();
        assert_eq!(s.item_children("sc", &a.id).unwrap()[0].id, b.id);
        s.item_edge("sc", &b.id, EdgeKind::ChildOf, &a.id, false)
            .unwrap();
        assert!(s.item_children("sc", &a.id).unwrap().is_empty());
    }

    #[test]
    fn labels_and_notes_accumulate() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let it = s.item_add("sc", new("t")).unwrap();
        s.item_label("sc", &it.id, "Bug", true).unwrap();
        s.item_label("sc", &it.id, "bug", true).unwrap(); // normalized, idempotent
        let got = s.item_get("sc", &it.id).unwrap().unwrap();
        assert_eq!(got.labels.len(), 1);
        s.item_label("sc", &it.id, "bug", false).unwrap();
        assert!(s.item_get("sc", &it.id).unwrap().unwrap().labels.is_empty());
        let n1 = s.item_note("sc", &it.id, "first").unwrap();
        let n2 = s.item_note("sc", &it.id, "second").unwrap();
        assert_ne!(n1, n2);
        let got = s.item_get("sc", &it.id).unwrap().unwrap();
        assert_eq!(got.notes.len(), 2);
    }

    #[test]
    fn edit_lww_fields() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let it = s.item_add("sc", new("t")).unwrap();
        let edited = s
            .item_edit(
                "sc",
                &it.id,
                ItemEdit {
                    title: Some("renamed".into()),
                    priority: Some(3),
                    assignee: Some("nick".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(edited.title, "renamed");
        assert_eq!(edited.priority, 3);
        assert_eq!(edited.assignee, "nick");
        assert!(s
            .item_edit(
                "sc",
                &it.id,
                ItemEdit {
                    title: Some("  ".into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(s.item_edit("sc", "zzzz", ItemEdit::default()).is_err());
    }

    #[test]
    fn scope_isolation_and_empty_title_rejected() {
        let mut s = AutomergeStore::in_memory().unwrap();
        assert!(s.item_add("sc", new("  ")).is_err());
        let a = s.item_add("one", new("t")).unwrap();
        assert!(s.item_get("two", &a.id).unwrap().is_none());
        assert_eq!(s.item_scopes().unwrap(), ["one"]);
    }

    #[test]
    fn survives_save_load() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let mut n = new("persisted");
        n.priority = 2;
        n.labels = vec!["x".into()];
        let it = s.item_add("sc", n).unwrap();
        s.item_note("sc", &it.id, "note").unwrap();
        let mut t = AutomergeStore::from_bytes(&s.save_bytes()).unwrap();
        let got = t.item_get("sc", &it.id).unwrap().unwrap();
        assert_eq!(got.title, "persisted");
        assert_eq!(got.priority, 2);
        assert_eq!(got.labels, BTreeSet::from(["x".to_string()]));
        assert_eq!(got.notes.len(), 1);
        assert_eq!(got.status, Status::Open);
    }

    #[test]
    fn status_parse() {
        assert_eq!(Status::parse("open"), Some(Status::Open));
        assert_eq!(Status::parse("in_progress"), Some(Status::InProgress));
        assert_eq!(Status::parse("closed"), Some(Status::Closed));
        assert_eq!(Status::parse("done"), None);
    }
}
