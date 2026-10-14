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
    /// Position in the scope's display queue. Explicit data, not a
    /// sort heuristic: consumers walk this, nothing re-sorts by status
    /// or priority. Legacy records (field absent) fall back to
    /// `created`, which preserves their creation order.
    pub order: u64,
    /// When the item was closed (millis), set on the close transition
    /// and cleared on reopen. None for legacy closes.
    pub closed_at: Option<u64>,
    pub labels: BTreeSet<String>,
    /// Append-only notes: note id -> text.
    pub notes: BTreeMap<String, String>,
    pub blocks: BTreeSet<String>,
    pub discovered_from: BTreeSet<String>,
    pub child_of: BTreeSet<String>,
    /// W4 gate: what must pass before this item can close. Empty = no
    /// gate. Later the resident's annotations set `gate_met` for us.
    pub gate: String,
    pub gate_met: bool,
}

impl WorkItem {
    pub fn is_open(&self) -> bool {
        self.status != Status::Closed
    }
}

/// W4 scheduler ranking over one item: score plus human-readable
/// evidence. Stable: the same doc state always yields the same order.
#[derive(Debug, Clone)]
pub struct Ranked {
    pub item: WorkItem,
    pub score: f64,
    pub why: Vec<String>,
}

/// W4 admission policy: max items in progress per scope. Evaluated
/// locally at write time — capacity is a rule, not merged state.
pub const WIP_LIMIT: usize = 3;

/// Gap between fresh positions in a scope's display queue. Midpoint
/// inserts shrink gaps; `item_move` rebalances the queue when one is
/// exhausted.
pub const QUEUE_STEP: u64 = 1024;

/// Queue move targets for `item_move`. `Before`/`After` name a sibling
/// by id or unique prefix.
#[derive(Debug, Clone)]
pub enum MoveTarget {
    Top,
    Bottom,
    Before(String),
    After(String),
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
    pub gate: String,
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
    pub gate: Option<String>,
    pub gate_met: Option<bool>,
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
        // Queue position before the record exists, so the scan sees only
        // prior items.
        let order = self.queue_next_order(scope)?;
        let rec = self.doc.put_object(&scope_id, &id, ObjType::Map)?;
        self.doc.put(&rec, "title", new.title.trim())?;
        self.doc.put(&rec, "priority", new.priority)?;
        self.doc.put(&rec, "status", Status::Open.as_str())?;
        self.doc.put(&rec, "assignee", new.assignee.as_str())?;
        self.doc.put(&rec, "acceptance", new.acceptance.as_str())?;
        self.doc.put(&rec, "design", new.design.as_str())?;
        self.doc.put(&rec, "gate", new.gate.as_str())?;
        self.doc.put(&rec, "created", created_millis())?;
        self.doc.put(&rec, "order", order as i64)?;
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
        if let Some(g) = &edit.gate {
            self.doc.put(&rec, "gate", g.as_str())?;
        }
        if let Some(m) = edit.gate_met {
            self.doc
                .put(&rec, "gate_met", if m { 1i64 } else { 0i64 })?;
        }
        if let Some(d) = &edit.design {
            self.doc.put(&rec, "design", d.as_str())?;
        }
        if let Some(s) = edit.status {
            self.doc.put(&rec, "status", s.as_str())?;
            // Track completion time for recency (recent-finished views);
            // cleared on reopen so a re-close gets a fresh stamp.
            if s == Status::Closed {
                self.doc.put(&rec, "closed_at", created_millis())?;
            } else if item.status == Status::Closed {
                self.doc.delete(&rec, "closed_at").ok();
            }
        }
        self.doc.commit();
        self.flush()?;
        Ok(self.item_get(scope, id)?.expect("item exists"))
    }

    /// `open -> in_progress`, subject to the WIP limit (W4). The item
    /// being claimed doesn't count against its own claim.
    pub fn item_claim(&mut self, scope: &str, id: &str) -> Result<WorkItem> {
        let full = self.item_resolve(scope, id)?;
        let in_prog = self
            .item_list(scope)?
            .iter()
            .filter(|it| it.status == Status::InProgress && it.id != full)
            .count();
        if in_prog >= WIP_LIMIT {
            return Err(format!(
                "capacity: {} item(s) already in progress (wip limit {}) — close or park one first",
                in_prog, WIP_LIMIT
            )
            .into());
        }
        self.item_edit(
            scope,
            &full,
            ItemEdit {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
    }

    // ---- display queue ----

    /// Next append position: past the end of the scope's queue.
    fn queue_next_order(&self, scope: &str) -> Result<u64> {
        Ok(self
            .item_list(scope)?
            .iter()
            .map(|it| it.order)
            .max()
            .unwrap_or(0)
            + QUEUE_STEP)
    }

    /// The scope's queue: items ordered by `order`, id as tiebreak.
    fn queue_sorted(&self, scope: &str) -> Result<Vec<WorkItem>> {
        let mut items = self.item_list(scope)?;
        items.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        Ok(items)
    }

    /// Write `order` for one item (record must exist).
    fn queue_put_order(&mut self, scope: &str, id: &str, order: u64) -> Result<()> {
        let rec = self
            .item_rec(scope, id)?
            .ok_or_else(|| format!("item: {id:?} not found"))?;
        self.doc.put(&rec, "order", order as i64)?;
        Ok(())
    }

    /// Renumber the whole queue `0, STEP, 2*STEP, …` in the given order.
    /// Self-healing: fixes exhausted gaps and normalizes legacy items.
    fn queue_rebalance(&mut self, scope: &str, ids: &[String]) -> Result<()> {
        for (i, id) in ids.iter().enumerate() {
            self.queue_put_order(scope, id, (i as u64) * QUEUE_STEP)?;
        }
        self.doc.commit();
        self.flush()?;
        Ok(())
    }

    /// Move an item within its scope's display queue. Position is
    /// explicit data (`order`), never re-derived from status or
    /// priority — completed items stay where they are. Insertion takes
    /// the midpoint of the target gap; a whole-queue rebalance only
    /// when the gap is exhausted.
    pub fn item_move(&mut self, scope: &str, id: &str, target: MoveTarget) -> Result<WorkItem> {
        let full = self.item_resolve(scope, id)?;
        let target = match target {
            MoveTarget::Top | MoveTarget::Bottom => target,
            MoveTarget::Before(sib) => MoveTarget::Before(self.queued_sibling(scope, &sib, &full)?),
            MoveTarget::After(sib) => MoveTarget::After(self.queued_sibling(scope, &sib, &full)?),
        };
        let queue = self.queue_sorted(scope)?;
        let without: Vec<String> = queue
            .iter()
            .filter(|it| it.id != full)
            .map(|it| it.id.clone())
            .collect();

        // Target slot in `without` (0..=len).
        let slot = match &target {
            MoveTarget::Top => 0,
            MoveTarget::Bottom => without.len(),
            MoveTarget::Before(sib) => without
                .iter()
                .position(|x| x == sib)
                .ok_or_else(|| format!("item: sibling {sib:?} not in queue"))?,
            MoveTarget::After(sib) => {
                without
                    .iter()
                    .position(|x| x == sib)
                    .ok_or_else(|| format!("item: sibling {sib:?} not in queue"))?
                    + 1
            }
        };

        // Try a midpoint insert; rebalance only when the gap is gone.
        let prev: Option<u64> = match slot.checked_sub(1) {
            Some(i) => Some(self.item_get(scope, &without[i])?.expect("in queue").order),
            None => None,
        };
        let next: Option<u64> = match without.get(slot) {
            Some(nid) => Some(self.item_get(scope, nid)?.expect("in queue").order),
            None => None,
        };
        let inserted: Option<u64> = match (prev, next) {
            (None, None) => Some(QUEUE_STEP), // empty queue
            (None, Some(n)) if n >= QUEUE_STEP => Some(n - QUEUE_STEP),
            (Some(p), None) => Some(p + QUEUE_STEP),
            (Some(p), Some(n)) if n >= p + 2 => Some(p + (n - p) / 2),
            _ => None, // gap exhausted → rebalance
        };
        match inserted {
            Some(order) => {
                self.queue_put_order(scope, &full, order)?;
                self.doc.commit();
                self.flush()?;
            }
            None => {
                let mut ids = without;
                ids.insert(slot, full.clone());
                self.queue_rebalance(scope, &ids)?;
            }
        }
        Ok(self.item_get(scope, &full)?.expect("just moved"))
    }

    /// Resolve a move sibling: must exist in the scope and not be the
    /// item being moved.
    fn queued_sibling(&self, scope: &str, sib: &str, moving: &str) -> Result<String> {
        let full = self.item_resolve(scope, sib)?;
        if full == moving {
            return Err("item: cannot move relative to itself".into());
        }
        Ok(full)
    }

    /// Any non-closed -> `closed`. Refused while a gate is set and not
    /// met (W4): the gate text says what must pass. Later, resident
    /// annotations mark gates met automatically.
    pub fn item_close(&mut self, scope: &str, id: &str) -> Result<WorkItem> {
        let full = self.item_resolve(scope, id)?;
        let item = self
            .item_get(scope, &full)?
            .ok_or_else(|| format!("item: {full} not found"))?;
        if !item.gate.trim().is_empty() && !item.gate_met {
            return Err(format!(
                "gate not met on {}: {} — mark it met first (`cx item gate {} --met`)",
                full, item.gate, full
            )
            .into());
        }
        let closed = self.item_edit(
            scope,
            &full,
            ItemEdit {
                status: Some(Status::Closed),
                ..Default::default()
            },
        )?;
        // Closed items leave the pinned set: the guard/story rides only
        // while open, so release/finalize lifts it automatically.
        if self.item_pinned_ids(scope)?.contains(&full) {
            self.item_pin(scope, &full, false)?;
        }
        Ok(closed)
    }

    /// W4 gate: set the gate description and/or mark it met/unmet.
    /// Closing is refused while a gate is set and unmet.
    pub fn item_gate(
        &mut self,
        scope: &str,
        id: &str,
        gate: Option<&str>,
        met: Option<bool>,
    ) -> Result<WorkItem> {
        if let Some(g) = gate {
            self.item_edit(
                scope,
                id,
                ItemEdit {
                    gate: Some(g.trim().to_string()),
                    ..Default::default()
                },
            )?;
        }
        if let Some(m) = met {
            self.item_edit(
                scope,
                id,
                ItemEdit {
                    gate_met: Some(m),
                    ..Default::default()
                },
            )?;
        }
        self.item_get(scope, id)?
            .ok_or_else(|| "item: vanished".into())
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
        self.doc
            .get(ROOT, "pinned")
            .ok()
            .flatten()
            .map(|(_, id)| id)
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

    /// Just the pinned ids, for marking lists. Includes closed items
    /// still in the set (close unpins, but old data may linger).
    pub fn item_pinned_ids(&self, scope: &str) -> Result<BTreeSet<String>> {
        let mut out = BTreeSet::new();
        if let Some(pinned) = self.pinned_opt() {
            if let Some((_, scope_id)) = self.doc.get(&pinned, scope)? {
                out.extend(self.doc.keys(&scope_id));
            }
        }
        Ok(out)
    }

    // ---- park / claim work guard ----

    /// Label marking claim items (one open claim per scope).
    pub const CLAIM_LABEL: &str = "claim";

    /// The open claim item in a scope, if any.
    pub fn open_claim(&self, scope: &str) -> Result<Option<WorkItem>> {
        Ok(self
            .item_list(scope)?
            .into_iter()
            .find(|it| it.labels.contains(Self::CLAIM_LABEL) && it.is_open()))
    }

    /// Claim the scope for active work: creates a pinned claim item in
    /// progress. Every later session in this repo sees it via resolve.
    /// Refuses while a claim is open — a parked claim may be stale
    /// (context syncs lazily), so verify and `release` first.
    pub fn claim_repo(&mut self, scope: &str, note: &str) -> Result<WorkItem> {
        if let Some(existing) = self.open_claim(scope)? {
            let state = if existing.status == Status::InProgress {
                "CLAIMED (active work in progress)"
            } else {
                "PARKED — verify context freshness first; `release` if stale"
            };
            return Err(format!(
                "claim: scope already {} — item {} ({})",
                state, existing.id, existing.title
            )
            .into());
        }
        let note = note.trim();
        let title = format!(
            "🔒 claim: {}",
            if note.is_empty() {
                "working in this repo"
            } else {
                note
            }
        );
        let it = self.item_add(
            scope,
            NewItem {
                title,
                labels: vec![Self::CLAIM_LABEL.to_string()],
                ..Default::default()
            },
        )?;
        let it = self.item_claim(scope, &it.id)?;
        self.item_pin(scope, &it.id, true)
    }

    /// Park: suspend but keep the guard up. The claim item stays pinned
    /// and open; a note records when and why. Anyone encountering a
    /// parked claim should check for newer context (it may have been
    /// released elsewhere) before respecting it.
    pub fn park_repo(&mut self, scope: &str, note: &str) -> Result<WorkItem> {
        let claim = self
            .open_claim(scope)?
            .ok_or_else(|| "park: no open claim in this scope".to_string())?;
        self.item_edit(
            scope,
            &claim.id,
            ItemEdit {
                status: Some(Status::Open),
                ..Default::default()
            },
        )?;
        let msg = format!(
            "parked at {} — {}",
            created_millis().max(0) as u64,
            if note.trim().is_empty() {
                "paused"
            } else {
                note.trim()
            }
        );
        self.item_note(scope, &claim.id, &msg)?;
        Ok(self.item_get(scope, &claim.id)?.expect("claim exists"))
    }

    /// Release the guard: work is done, or a parked claim was verified
    /// stale. Closing unpins automatically.
    pub fn release_repo(&mut self, scope: &str, note: &str) -> Result<WorkItem> {
        let claim = self
            .open_claim(scope)?
            .ok_or_else(|| "release: no open claim in this scope".to_string())?;
        if !note.trim().is_empty() {
            self.item_note(
                scope,
                &claim.id,
                &format!(
                    "released at {} — {}",
                    created_millis().max(0) as u64,
                    note.trim()
                ),
            )?;
        }
        self.item_close(scope, &claim.id)
    }

    /// W4 scheduler: score every ready (open, unblocked) item.
    ///
    /// Weights: priority dominates (×1000), then how many open items
    /// it unblocks (×100), then already-in-progress (+50), then a
    /// gentle age tie-breaker capped at 30 days. Same doc state → same
    /// order (age is the only time-varying term and is capped).
    pub fn item_rank(&self, scope: &str) -> Result<Vec<Ranked>> {
        let all = self.item_list(scope)?;
        let now_ms = created_millis().max(0) as u64;
        let mut out: Vec<Ranked> = all
            .iter()
            .filter(|it| it.is_open())
            .filter(|it| {
                !all.iter()
                    .any(|other| other.blocks.contains(&it.id) && other.status != Status::Closed)
            })
            .map(|it| {
                let unblocks = all
                    .iter()
                    .filter(|other| it.blocks.contains(&other.id) && other.status != Status::Closed)
                    .count();
                let age_days = if it.created > 0 && now_ms > it.created {
                    (now_ms - it.created) as f64 / 86_400_000.0
                } else {
                    0.0
                };
                let started = it.status == Status::InProgress;
                let score = it.priority as f64 * 1000.0
                    + unblocks as f64 * 100.0
                    + if started { 50.0 } else { 0.0 }
                    + age_days.min(30.0);
                let mut why = vec!["unblocked".to_string()];
                why.push(format!("priority {}", it.priority));
                if unblocks > 0 {
                    why.push(format!("unblocks {unblocks}"));
                }
                if started {
                    why.push("in progress".to_string());
                }
                if age_days >= 1.0 {
                    why.push(format!("open {:.0}d", age_days));
                }
                if !it.gate.trim().is_empty() && !it.gate_met {
                    why.push("gate pending".to_string());
                }
                Ranked {
                    item: it.clone(),
                    score,
                    why,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.item.id.cmp(&b.item.id))
        });
        Ok(out)
    }

    /// plan_next fold: top ranked items with their evidence.
    pub fn item_plan_next(&self, scope: &str, limit: usize) -> Result<Vec<Ranked>> {
        Ok(self.item_rank(scope)?.into_iter().take(limit).collect())
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
            order: {
                let o = self.ival(rec, "order");
                if o > 0 {
                    o as u64
                } else {
                    self.ival(rec, "created").max(0) as u64
                }
            },
            closed_at: {
                let ca = self.ival(rec, "closed_at");
                if ca > 0 {
                    Some(ca as u64)
                } else {
                    None
                }
            },
            labels: set_of("labels"),
            notes,
            blocks: set_of("blocks"),
            discovered_from: set_of("discovered_from"),
            child_of: set_of("child_of"),
            gate: self.sval(rec, "gate"),
            gate_met: self.ival(rec, "gate_met") != 0,
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
        let pinned: Vec<String> = s
            .item_pinned("sc")
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect();
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
        let ranked = s.item_plan_next("sc", 5).unwrap();
        // alpha and the (unblocked) blocker are ready; blocked is not
        assert_eq!(ranked.len(), 2, "blocked item is not ready");
        assert_eq!(ranked[0].item.id, a.id, "higher priority ranks first");
        assert!(ranked[0].why.iter().any(|w| w == "unblocked"));
        assert!(ranked[0].why.iter().any(|w| w == "priority 4"));
        assert_eq!(ranked[1].item.id, root.id);
        // unblocks is counted: root blocks one open item
        assert!(
            ranked[1].why.iter().any(|w| w == "unblocks 1"),
            "root's evidence names the unblocked count"
        );
    }

    #[test]
    fn ranking_is_stable() {
        // equal priority: ranking is deterministic, older item first
        // (gentle aging tie-breaker); repeated calls give the same order
        let mut s = AutomergeStore::in_memory().unwrap();
        let x = s.item_add("sc", new("x")).unwrap();
        let y = s.item_add("sc", new("y")).unwrap();
        let first: Vec<String> = s
            .item_plan_next("sc", 10)
            .unwrap()
            .into_iter()
            .map(|r| r.item.id)
            .collect();
        let second: Vec<String> = s
            .item_plan_next("sc", 10)
            .unwrap()
            .into_iter()
            .map(|r| r.item.id)
            .collect();
        assert_eq!(first, second, "same doc state, same order");
        assert_eq!(first, vec![x.id, y.id], "older item ranks first on ties");
    }

    #[test]
    fn wip_limit_blocks_excess_claims() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let mut ids = Vec::new();
        for n in 0..4 {
            ids.push(s.item_add("sc", new(&format!("item{n}"))).unwrap().id);
        }
        for id in &ids[..3] {
            s.item_claim("sc", id).unwrap();
        }
        assert!(
            s.item_claim("sc", &ids[3]).is_err(),
            "fourth claim hits the wip limit"
        );
        // reclaiming an in-progress item is fine (doesn't count itself)
        s.item_claim("sc", &ids[0]).unwrap();
        s.item_close("sc", &ids[1]).unwrap();
        s.item_claim("sc", &ids[3]).unwrap();
    }

    #[test]
    fn gate_blocks_close_until_met() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let mut n = new("gated");
        n.gate = "tests green".into();
        let it = s.item_add("sc", n).unwrap();
        assert!(s.item_close("sc", &it.id).is_err());
        s.item_gate("sc", &it.id, None, Some(true)).unwrap();
        s.item_close("sc", &it.id).unwrap();
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

    #[test]
    fn queue_append_and_order() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        let b = s.item_add("sc", new("b")).unwrap();
        let c = s.item_add("sc", new("c")).unwrap();
        assert!(a.order < b.order && b.order < c.order);
        assert_eq!(c.order - a.order, 2 * QUEUE_STEP);
    }

    #[test]
    fn queue_move_before_after_midpoint() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        let b = s.item_add("sc", new("b")).unwrap();
        let c = s.item_add("sc", new("c")).unwrap();
        // c between a and b: midpoint of (a.order, b.order)
        let moved = s
            .item_move("sc", &c.id, MoveTarget::Before(b.id.clone()))
            .unwrap();
        let q = s.queue_sorted("sc").unwrap();
        let ids: Vec<String> = q.iter().map(|it| it.id.clone()).collect();
        assert_eq!(ids, vec![a.id.clone(), c.id.clone(), b.id.clone()]);
        assert!(moved.order > a.order && moved.order < b.order);
        // after a: back between a and b
        s.item_move("sc", &c.id, MoveTarget::After(a.id.clone()))
            .unwrap();
        let q = s.queue_sorted("sc").unwrap();
        let ids: Vec<String> = q.iter().map(|it| it.id.clone()).collect();
        assert_eq!(ids, vec![a.id.clone(), c.id, b.id]);
    }

    #[test]
    fn queue_move_top_bottom() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        let b = s.item_add("sc", new("b")).unwrap();
        let c = s.item_add("sc", new("c")).unwrap();
        s.item_move("sc", &a.id, MoveTarget::Bottom).unwrap();
        let ids: Vec<String> = s
            .queue_sorted("sc")
            .unwrap()
            .iter()
            .map(|it| it.id.clone())
            .collect();
        assert_eq!(ids, vec![b.id.clone(), c.id.clone(), a.id.clone()]);
        s.item_move("sc", &a.id, MoveTarget::Top).unwrap();
        let ids: Vec<String> = s
            .queue_sorted("sc")
            .unwrap()
            .iter()
            .map(|it| it.id.clone())
            .collect();
        assert_eq!(ids, vec![a.id.clone(), b.id, c.id]);
    }

    #[test]
    fn queue_rebalance_on_exhausted_gap() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        let b = s.item_add("sc", new("b")).unwrap();
        // Repeatedly move c between a and b: gaps shrink until a
        // rebalance fires, which must keep the order valid.
        let c = s.item_add("sc", new("c")).unwrap();
        for _ in 0..12 {
            s.item_move("sc", &c.id, MoveTarget::Before(b.id.clone()))
                .unwrap();
        }
        let q = s.queue_sorted("sc").unwrap();
        for w in q.windows(2) {
            assert!(
                w[1].order > w[0].order,
                "queue not strictly increasing after rebalance"
            );
        }
    }

    #[test]
    fn closed_at_set_on_close_cleared_on_reopen() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = s.item_add("sc", new("a")).unwrap();
        assert_eq!(a.closed_at, None);
        let closed = s.item_close("sc", &a.id).unwrap();
        assert!(closed.closed_at.is_some());
        let reopened = s.item_reopen("sc", &a.id).unwrap();
        assert_eq!(reopened.closed_at, None);
        let reclosed = s.item_close("sc", &a.id).unwrap();
        assert!(reclosed.closed_at.unwrap() >= closed.closed_at.unwrap());
    }

    #[test]
    fn guard_claim_park_release_cycle() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let c = s.claim_repo("sc", "upgrading X").unwrap();
        assert_eq!(c.status, Status::InProgress);
        assert!(s.item_pinned_ids("sc").unwrap().contains(&c.id));
        // second claim refused while one is open
        assert!(s.claim_repo("sc", "again").is_err());
        // park: guard stays up, suspended, note records the time
        let p = s.park_repo("sc", "stepping away").unwrap();
        assert_eq!(p.status, Status::Open);
        assert!(p.notes.values().any(|t| t.contains("parked at")));
        assert!(s.item_pinned_ids("sc").unwrap().contains(&c.id));
        assert!(s.claim_repo("sc", "again").is_err());
        // release: closes => unpins, scope free again
        let r = s.release_repo("sc", "done").unwrap();
        assert_eq!(r.status, Status::Closed);
        assert!(!s.item_pinned_ids("sc").unwrap().contains(&c.id));
        assert!(s.claim_repo("sc", "new session").is_ok());
    }

    #[test]
    fn guard_isolated_per_scope() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.claim_repo("a", "x").unwrap();
        s.claim_repo("b", "y").unwrap();
        assert!(s.open_claim("a").unwrap().is_some());
        assert!(s.open_claim("b").unwrap().is_some());
    }
}
