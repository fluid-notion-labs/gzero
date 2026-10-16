//! Workflow sections: keyed, typed documents in the automerge doc.
//!
//! The workflow system's long-form content (plan3 W1): vision,
//! synopsis, architecture, plan, checklists, user stories — any name,
//! any number, per project scope. A section record is
//! `{ scope, name, kind, title, body, order }`; `body` is LWW text
//! (an automerge map put per write), `kind` is `md` or `checklist`.
//! Scopes are repo identities (see `repo_identity_in`) or `global`.
//!
//! Doc shape (inside the contexted doc) — nested, mkdir -p semantics:
//! ```text
//! root
//! └─ sections: Map<scope -> Node>
//!      Node = Map { kind, title, body, order  // payload: present ⇒ section
//!                 , ch: Map<seg -> Node> }    // children; dots are levels
//! ```
//! A dotted name is a path: `a.b.c` lives at scope → ch a → ch b → ch c.
//! Writes create missing ancestors as bare containers (no payload);
//! `section_ensure` is the explicit mkdir -p. A node may carry a payload
//! AND children (a section with sub-sections). The segment `ch` is
//! reserved (it names the children map); the pre-nesting layout stored
//! dotted names as flat keys — those are read through until the next
//! write in the scope migrates them into the tree.
//!
//! Deletion removes the key — no tombstone for now: sections are
//! single-machine until D1, and concurrent delete-vs-edit
//! reconciliation is a D2 concern.

use automerge::transaction::Transactable;
use automerge::{ObjId, ObjType, ReadDoc, ROOT};

use crate::automerge_store::AutomergeStore;
use crate::Result;

/// Default ws doc location, mirroring `CX_DB`/`context.db` naming.
pub fn default_ws_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("CX_WS_DB") {
        return p.into();
    }
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::Path::new(&home).join(".pi/agent/context.ws");
    }
    std::path::PathBuf::from("context.ws")
}

/// Section kinds. A `checklist` body uses `- [ ]` / `- [x]` lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SectionKind {
    #[default]
    Md,
    Checklist,
}

impl SectionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SectionKind::Md => "md",
            SectionKind::Checklist => "checklist",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "md" => Some(SectionKind::Md),
            "checklist" => Some(SectionKind::Checklist),
            _ => None,
        }
    }
}

/// One workflow section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// Project scope (repo identity) or `global`.
    pub scope: String,
    /// Section name: a slug (`vision`, `plan`, `checklist.build`).
    pub name: String,
    pub kind: SectionKind,
    pub title: String,
    /// The body text (markdown). LWW per write.
    pub body: String,
    /// Sort key within the scope; list order is (order, name).
    pub order: i64,
}

/// Names are slugs: non-empty, no whitespace, no empty dot segments,
/// no leading/trailing dot. Dots nest (`checklist.build`). The
/// segment `ch` is reserved — it holds a node's children map.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .split('.')
            .all(|seg| !seg.is_empty() && seg != "ch")
        && !name.chars().any(char::is_whitespace)
}

/// One child of a namespace node (see `section_children`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionChild {
    /// Full dotted path of the child.
    pub path: String,
    /// The child's own segment.
    pub seg: String,
    /// The child carries a payload (is itself a section).
    pub is_section: bool,
    /// The child has further children below it.
    pub has_children: bool,
}

/// A checklist body's progress: (done, total) over `- [x]` / `- [ ]`
/// lines. Nesting-aware (two spaces per level): a checkbox with a
/// deeper checkbox beneath it is a parent — its progress is its
/// children's, so only leaves are counted.
pub fn checklist_progress(body: &str) -> (usize, usize) {
    let mut checks: Vec<(usize, bool)> = Vec::new(); // (level, done)
    for line in body.lines() {
        let level = (line.len() - line.trim_start().len()) / 2;
        let t = line.trim_start();
        let (rest, done) = if let Some(rest) = t.strip_prefix("- [ ] ") {
            (rest, false)
        } else if let Some(rest) = t
            .strip_prefix("- [x] ")
            .or_else(|| t.strip_prefix("- [X] "))
        {
            (rest, true)
        } else {
            continue;
        };
        if !rest.trim().is_empty() {
            checks.push((level, done));
        }
    }
    let (mut done, mut total) = (0, 0);
    for (i, (level, d)) in checks.iter().enumerate() {
        let is_leaf = checks[i + 1..]
            .iter()
            .take_while(|(deeper, _)| *deeper > *level)
            .count()
            == 0;
        if is_leaf {
            total += 1;
            if *d {
                done += 1;
            }
        }
    }
    (done, total)
}

impl AutomergeStore {
    /// The `sections` root map, if the doc has one.
    fn sections_opt(&self) -> Option<ObjId> {
        self.doc
            .get(ROOT, "sections")
            .ok()
            .flatten()
            .map(|(_, id)| id)
    }

    fn ensure_sections(&mut self) -> Result<ObjId> {
        if let Some(id) = self.sections_opt() {
            return Ok(id);
        }
        let id = self.doc.put_object(ROOT, "sections", ObjType::Map)?;
        self.doc.commit();
        Ok(id)
    }

    /// The scope node, creating it (and the sections map) if needed.
    fn ensure_scope_node(&mut self, scope: &str) -> Result<ObjId> {
        let sections = self.ensure_sections()?;
        Ok(match self.doc.get(&sections, scope)? {
            Some((_, id)) => id,
            None => self.doc.put_object(&sections, scope, ObjType::Map)?,
        })
    }

    /// A node's children map (`ch`), if it has one.
    fn children_of(&self, node: &ObjId) -> Result<Option<ObjId>> {
        Ok(self.doc.get(node, "ch")?.map(|(_, id)| id))
    }

    fn children_nonempty(&self, node: &ObjId) -> Result<bool> {
        Ok(self
            .children_of(node)?
            .is_some_and(|ch| self.doc.keys(&ch).next().is_some()))
    }

    /// Walk the dotted path below `node`; None if any level is missing.
    fn node_at(&self, node: &ObjId, segs: &[&str]) -> Result<Option<ObjId>> {
        let mut cur = node.clone();
        for seg in segs {
            let Some(ch) = self.children_of(&cur)? else {
                return Ok(None);
            };
            let Some((_, id)) = self.doc.get(&ch, *seg)? else {
                return Ok(None);
            };
            cur = id;
        }
        Ok(Some(cur))
    }

    /// mkdir -p: create the container chain below `scope_node` for
    /// `name`, returning the leaf node. Missing ancestors become bare
    /// containers (no payload).
    fn ensure_node_path(&mut self, scope_node: &ObjId, name: &str) -> Result<ObjId> {
        let mut cur = scope_node.clone();
        for seg in name.split('.') {
            let ch = match self.children_of(&cur)? {
                Some(id) => id,
                None => self.doc.put_object(&cur, "ch", ObjType::Map)?,
            };
            cur = match self.doc.get(&ch, seg)? {
                Some((_, id)) => id,
                None => self.doc.put_object(&ch, seg, ObjType::Map)?,
            };
        }
        Ok(cur)
    }

    fn read_section_at(&self, scope: &str, name: &str, node: &ObjId) -> Section {
        Section {
            scope: scope.to_string(),
            name: name.to_string(),
            kind: SectionKind::parse(&self.sval(node, "kind")).unwrap_or_default(),
            title: self.sval(node, "title"),
            body: self.sval(node, "body"),
            order: self.ival(node, "order"),
        }
    }

    fn write_section_payload(&mut self, node: &ObjId, s: &Section) -> Result<()> {
        self.doc.put(node, "kind", s.kind.as_str())?;
        self.doc.put(node, "title", s.title.as_str())?;
        self.doc.put(node, "body", s.body.as_str())?;
        self.doc.put(node, "order", s.order)?;
        Ok(())
    }

    /// Migrate pre-nesting sections in `scope`: names were stored as
    /// flat keys on the scope node; move them into the node tree.
    /// Idempotent; runs before any write in the scope.
    fn migrate_scope(&mut self, scope: &str) -> Result<()> {
        let Some(sections) = self.sections_opt() else {
            return Ok(());
        };
        let Some((_, scope_node)) = self.doc.get(&sections, scope)? else {
            return Ok(());
        };
        // Legacy keys: every direct key except `ch` that carries a payload.
        let legacy: Vec<String> = self
            .doc
            .keys(&scope_node)
            .filter(|k| k != "ch")
            .collect();
        let mut migrated = false;
        for name in legacy {
            let Some((_, rec)) = self.doc.get(&scope_node, name.as_str())? else {
                continue;
            };
            if !self.has(&rec, "kind") {
                continue;
            }
            let s = self.read_section_at(scope, &name, &rec);
            self.doc.delete(&scope_node, name.as_str())?;
            let node = self.ensure_node_path(&scope_node, &s.name)?;
            // A tree write may already be newer; only fill empty nodes.
            if !self.has(&node, "kind") {
                self.write_section_payload(&node, &s)?;
            }
            migrated = true;
        }
        if migrated {
            self.doc.commit();
            self.flush()?;
        }
        Ok(())
    }

    /// Create or replace a section; returns true if it replaced one.
    /// Dots nest: missing ancestors are created as bare containers.
    pub fn section_put(&mut self, s: &Section) -> Result<bool> {
        if !valid_name(&s.name) {
            return Err(format!("ws: bad section name {:?}", s.name).into());
        }
        self.migrate_scope(&s.scope)?;
        let existed = self.section_get(&s.scope, &s.name)?.is_some();
        let scope_node = self.ensure_scope_node(&s.scope)?;
        let node = self.ensure_node_path(&scope_node, &s.name)?;
        self.write_section_payload(&node, s)?;
        self.doc.commit();
        self.flush()?;
        Ok(existed)
    }

    /// mkdir -p for a nested namespace: create the container chain for
    /// `name` without content. Returns true if anything was created.
    pub fn section_ensure(&mut self, scope: &str, name: &str) -> Result<bool> {
        if !valid_name(name) {
            return Err(format!("ws: bad section name {:?}", name).into());
        }
        self.migrate_scope(scope)?;
        let scope_node = self.ensure_scope_node(scope)?;
        let segs: Vec<&str> = name.split('.').collect();
        let existed = self.node_at(&scope_node, &segs)?.is_some();
        if !existed {
            self.ensure_node_path(&scope_node, name)?;
            self.doc.commit();
            self.flush()?;
        }
        Ok(!existed)
    }

    /// Read one section by (scope, name). Bare containers read as None.
    pub fn section_get(&self, scope: &str, name: &str) -> Result<Option<Section>> {
        let Some(sections) = self.sections_opt() else {
            return Ok(None);
        };
        let Some((_, scope_node)) = self.doc.get(&sections, scope)? else {
            return Ok(None);
        };
        let segs: Vec<&str> = name.split('.').collect();
        if let Some(node) = self.node_at(&scope_node, &segs)? {
            if self.has(&node, "kind") {
                return Ok(Some(self.read_section_at(scope, name, &node)));
            }
            return Ok(None);
        }
        // Pre-nesting layout: the name as one flat key on the scope node.
        if self.has(&scope_node, name) {
            if let Some((_, rec)) = self.doc.get(&scope_node, name)? {
                if self.has(&rec, "kind") {
                    return Ok(Some(self.read_section_at(scope, name, &rec)));
                }
            }
        }
        Ok(None)
    }

    /// All sections in `scope`, ordered by (order, name). Walks the
    /// node tree; pre-nesting flat keys are read through.
    pub fn section_list(&self, scope: &str) -> Result<Vec<Section>> {
        let mut out: Vec<Section> = Vec::new();
        if let Some(sections) = self.sections_opt() {
            if let Some((_, scope_node)) = self.doc.get(&sections, scope)? {
                let mut stack: Vec<(ObjId, Vec<String>)> = vec![(scope_node.clone(), Vec::new())];
                while let Some((node, path)) = stack.pop() {
                    if self.has(&node, "kind") {
                        out.push(self.read_section_at(scope, &path.join("."), &node));
                    }
                    if let Some(ch) = self.children_of(&node)? {
                        for seg in self.doc.keys(&ch) {
                            if let Some((_, id)) = self.doc.get(&ch, seg.as_str())? {
                                let mut p = path.clone();
                                p.push(seg);
                                stack.push((id, p));
                            }
                        }
                    }
                }
                // Pre-nesting flat keys, not yet migrated.
                for name in self.doc.keys(&scope_node) {
                    if name != "ch" {
                        if let Some(s) = self.section_get(scope, &name)? {
                            if !out.iter().any(|x| x.name == s.name) {
                                out.push(s);
                            }
                        }
                    }
                }
            }
        }
        out.sort_by(|a, b| (a.order, a.name.as_str()).cmp(&(b.order, b.name.as_str())));
        Ok(out)
    }

    /// Scopes that hold at least one node (section or container), sorted.
    pub fn section_scopes(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if let Some(sections) = self.sections_opt() {
            for scope in self.doc.keys(&sections) {
                if let Some((_, scope_node)) = self.doc.get(&sections, scope.as_str())? {
                    if self.has(&scope_node, "kind") || self.children_nonempty(&scope_node)? {
                        out.push(scope);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Delete a section; returns whether it existed. Empty bare
    /// ancestors are pruned up to (and including) an empty scope node.
    pub fn section_delete(&mut self, scope: &str, name: &str) -> Result<bool> {
        if !valid_name(name) {
            return Err(format!("ws: bad section name {:?}", name).into());
        }
        self.migrate_scope(scope)?;
        let Some(sections) = self.sections_opt() else {
            return Ok(false);
        };
        let Some((_, scope_node)) = self.doc.get(&sections, scope)? else {
            return Ok(false);
        };
        let segs: Vec<&str> = name.split('.').collect();
        // Walk to the leaf, remembering each level's node.
        let mut nodes: Vec<ObjId> = Vec::with_capacity(segs.len());
        let mut cur = scope_node.clone();
        for seg in &segs {
            let Some(ch) = self.children_of(&cur)? else {
                return Ok(false);
            };
            let Some((_, id)) = self.doc.get(&ch, *seg)? else {
                return Ok(false);
            };
            cur = id;
            nodes.push(cur.clone());
        }
        if !self.has(&nodes[segs.len() - 1], "kind") {
            return Ok(false);
        }
        // Remove the leaf from its parent's ch map.
        let parent = if segs.len() == 1 {
            scope_node.clone()
        } else {
            nodes[segs.len() - 2].clone()
        };
        let ch = self
            .children_of(&parent)?
            .expect("parent has ch: node_at found the leaf");
        self.doc.delete(&ch, segs[segs.len() - 1])?;
        // Prune bare, childless containers upward.
        for i in (0..segs.len() - 1).rev() {
            let node = &nodes[i];
            if self.has(node, "kind") || self.children_nonempty(node)? {
                break;
            }
            let p_node = if i == 0 {
                scope_node.clone()
            } else {
                nodes[i - 1].clone()
            };
            let p_ch = self
                .children_of(&p_node)?
                .expect("parent has ch: node_at found the child");
            self.doc.delete(&p_ch, segs[i])?;
        }
        // An empty bare scope node goes too.
        if !self.has(&scope_node, "kind") && !self.children_nonempty(&scope_node)? {
            self.doc.delete(&sections, scope)?;
        }
        self.doc.commit();
        self.flush()?;
        Ok(true)
    }

    /// Direct children of `prefix` in `scope` (empty prefix = the scope
    /// root), for hierarchy views. Sorted by segment.
    pub fn section_children(&self, scope: &str, prefix: &str) -> Result<Vec<SectionChild>> {
        let mut out = Vec::new();
        let Some(sections) = self.sections_opt() else {
            return Ok(out);
        };
        let Some((_, scope_node)) = self.doc.get(&sections, scope)? else {
            return Ok(out);
        };
        let node = if prefix.is_empty() {
            scope_node
        } else {
            let segs: Vec<&str> = prefix.split('.').collect();
            match self.node_at(&scope_node, &segs)? {
                Some(id) => id,
                None => return Ok(out),
            }
        };
        let Some(ch) = self.children_of(&node)? else {
            return Ok(out);
        };
        for seg in self.doc.keys(&ch) {
            let Some((_, id)) = self.doc.get(&ch, seg.as_str())? else {
                continue;
            };
            let path = if prefix.is_empty() {
                seg.clone()
            } else {
                format!("{prefix}.{seg}")
            };
            out.push(SectionChild {
                path,
                seg: seg.clone(),
                is_section: self.has(&id, "kind"),
                has_children: self.children_nonempty(&id)?,
            });
        }
        out.sort_by(|a, b| a.seg.cmp(&b.seg));
        Ok(out)
    }

    /// Integer field on a record (0 when absent).
    pub(crate) fn ival(&self, obj: &ObjId, key: &str) -> i64 {
        match self.doc.get(obj, key) {
            Ok(Some((automerge::Value::Scalar(s), _))) => match &*s {
                automerge::ScalarValue::Int(v) => *v,
                _ => 0,
            },
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automerge_store::AutomergeStore;

    fn sec(scope: &str, name: &str, kind: SectionKind, order: i64) -> Section {
        Section {
            scope: scope.into(),
            name: name.into(),
            kind,
            title: name.to_uppercase(),
            body: format!("body of {name}"),
            order,
        }
    }

    #[test]
    fn put_get_replace() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let a = sec("owner/repo", "vision", SectionKind::Md, 0);
        assert!(!s.section_put(&a).unwrap());
        assert_eq!(s.section_get("owner/repo", "vision").unwrap(), Some(a));
        let mut b = sec("owner/repo", "vision", SectionKind::Md, 0);
        b.body = "revised".into();
        assert!(s.section_put(&b).unwrap());
        assert_eq!(
            s.section_get("owner/repo", "vision").unwrap().unwrap().body,
            "revised"
        );
    }

    #[test]
    fn list_orders_by_order_then_name() {
        let mut s = AutomergeStore::in_memory().unwrap();
        for (name, order) in [("zeta", 1), ("alpha", 1), ("mid", 0)] {
            s.section_put(&sec("sc", name, SectionKind::Md, order))
                .unwrap();
        }
        let names: Vec<String> = s
            .section_list("sc")
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert_eq!(names, ["mid", "alpha", "zeta"]);
    }

    #[test]
    fn scopes_are_isolated() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("a", "vision", SectionKind::Md, 0))
            .unwrap();
        s.section_put(&sec("b", "plan", SectionKind::Md, 0))
            .unwrap();
        assert!(s.section_get("a", "plan").unwrap().is_none());
        assert_eq!(s.section_list("a").unwrap().len(), 1);
        assert_eq!(s.section_scopes().unwrap(), ["a", "b"]);
    }

    #[test]
    fn delete_and_missing() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("sc", "vision", SectionKind::Md, 0))
            .unwrap();
        assert!(s.section_delete("sc", "vision").unwrap());
        assert!(!s.section_delete("sc", "vision").unwrap());
        assert!(!s.section_delete("nope", "vision").unwrap());
        assert!(s.section_scopes().unwrap().is_empty());
    }

    #[test]
    fn bad_names_rejected() {
        let mut s = AutomergeStore::in_memory().unwrap();
        for name in ["", "a b", ".a", "a.", "a..b", "ch", "a.ch"] {
            let mut x = sec("sc", name, SectionKind::Md, 0);
            x.name = name.into();
            assert!(s.section_put(&x).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn nested_put_get_list() {
        let mut s = AutomergeStore::in_memory().unwrap();
        let name = "docs.tech-debt.cas-document-system";
        assert!(!s.section_put(&sec("sc", name, SectionKind::Md, 3)).unwrap());
        assert_eq!(s.section_get("sc", name).unwrap().unwrap().order, 3);
        // Bare ancestors are containers, not sections.
        assert!(s.section_get("sc", "docs").unwrap().is_none());
        assert!(s.section_get("sc", "docs.tech-debt").unwrap().is_none());
        // A node can carry a payload AND children.
        assert!(!s
            .section_put(&sec("sc", "docs.tech-debt", SectionKind::Md, 1))
            .unwrap());
        assert!(s.section_get("sc", "docs.tech-debt").unwrap().is_some());
        assert!(s.section_get("sc", name).unwrap().is_some());
        let names: Vec<String> = s
            .section_list("sc")
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert_eq!(names, ["docs.tech-debt", name]);
    }

    #[test]
    fn ensure_is_mkdir_p() {
        let mut s = AutomergeStore::in_memory().unwrap();
        assert!(s.section_ensure("sc", "a.b.c").unwrap());
        assert!(!s.section_ensure("sc", "a.b.c").unwrap());
        assert!(!s.section_ensure("sc", "a.b").unwrap());
        assert!(s.section_get("sc", "a.b.c").unwrap().is_none());
        // A section in the created chain lands in place.
        assert!(!s.section_put(&sec("sc", "a.b", SectionKind::Md, 0)).unwrap());
        assert_eq!(s.section_list("sc").unwrap().len(), 1);
        assert!(s.section_ensure("sc", "bad name").is_err());
    }

    #[test]
    fn delete_prunes_bare_ancestors() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("sc", "a.b.c", SectionKind::Md, 0))
            .unwrap();
        assert!(s.section_delete("sc", "a.b.c").unwrap());
        assert!(s.section_get("sc", "a.b.c").unwrap().is_none());
        assert!(s.section_list("sc").unwrap().is_empty());
        assert!(s.section_scopes().unwrap().is_empty());
        // But a payload-carrying ancestor keeps its chain.
        s.section_put(&sec("sc", "a.b.c", SectionKind::Md, 0))
            .unwrap();
        s.section_put(&sec("sc", "a", SectionKind::Md, 0)).unwrap();
        assert!(s.section_delete("sc", "a.b.c").unwrap());
        assert_eq!(
            s.section_list("sc")
                .unwrap()
                .into_iter()
                .map(|x| x.name)
                .collect::<Vec<_>>(),
            ["a"]
        );
    }

    #[test]
    fn children_lists_segments() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("sc", "a.b.one", SectionKind::Md, 0))
            .unwrap();
        s.section_put(&sec("sc", "a.two", SectionKind::Md, 0))
            .unwrap();
        s.section_ensure("sc", "a.b.three").unwrap();
        let kids = s.section_children("sc", "a").unwrap();
        assert_eq!(
            kids.iter().map(|k| (k.seg.as_str(), k.is_section, k.has_children)).collect::<Vec<_>>(),
            [
                ("b", false, true),
                ("two", true, false)
            ]
        );
        assert_eq!(s.section_children("sc", "a.b").unwrap().len(), 2);
        assert!(s.section_children("sc", "nope").unwrap().is_empty());
    }

    #[test]
    fn legacy_flat_names_read_and_migrate() {
        use automerge::transaction::Transactable;
        use automerge::{ObjType, ROOT};
        let mut s = AutomergeStore::in_memory().unwrap();
        // Build the pre-nesting layout by hand: flat dotted key.
        let sections = s.doc.put_object(ROOT, "sections", ObjType::Map).unwrap();
        let scope = s.doc.put_object(&sections, "sc", ObjType::Map).unwrap();
        let rec = s
            .doc
            .put_object(&scope, "a.b", ObjType::Map)
            .unwrap();
        s.doc.put(&rec, "kind", "md").unwrap();
        s.doc.put(&rec, "title", "old").unwrap();
        s.doc.put(&rec, "body", "legacy body").unwrap();
        s.doc.put(&rec, "order", 2i64).unwrap();
        s.doc.commit();
        // Reads work through the flat key.
        let got = s.section_get("sc", "a.b").unwrap().unwrap();
        assert_eq!((got.title.as_str(), got.order), ("old", 2));
        assert_eq!(s.section_list("sc").unwrap().len(), 1);
        // The next write in the scope migrates it into the tree.
        s.section_put(&sec("sc", "a.b.c", SectionKind::Md, 0))
            .unwrap();
        let got = s.section_get("sc", "a.b").unwrap().unwrap();
        assert_eq!(got.title, "old");
        assert!(!s.has(&scope, "a.b"));
        assert_eq!(s.section_list("sc").unwrap().len(), 2);
    }

    #[test]
    fn survives_save_load() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("sc", "vision", SectionKind::Checklist, 3))
            .unwrap();
        let t = AutomergeStore::from_bytes(&s.save_bytes()).unwrap();
        let got = t.section_get("sc", "vision").unwrap().unwrap();
        assert_eq!(got.kind, SectionKind::Checklist);
        assert_eq!(got.order, 3);
        assert_eq!(got.title, "VISION");
    }

    #[test]
    fn checklist_progress_counts() {
        let body = "- [ ] todo\n- [x] done\n- [X] also done\nnot a task\n- [ ] \n";
        assert_eq!(checklist_progress(body), (2, 3));
    }

    #[test]
    fn checklist_progress_counts_leaves_only() {
        let body = "\
- [ ] big task\n  - [x] done sub\n  - [ ] open sub\n\
- [x] finished parent\n  - [x] sub one\n  - [x] sub two\n\
- [x] leaf task\n";
        // leaves: done sub, open sub, sub one, sub two, leaf task
        assert_eq!(checklist_progress(body), (4, 5));
    }

    #[test]
    fn kind_parse() {
        assert_eq!(SectionKind::parse("md"), Some(SectionKind::Md));
        assert_eq!(
            SectionKind::parse("checklist"),
            Some(SectionKind::Checklist)
        );
        assert_eq!(SectionKind::parse("yaml"), None);
    }
}
