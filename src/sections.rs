//! Workflow sections: keyed, typed documents in the automerge doc.
//!
//! The workflow system's long-form content (plan3 W1): vision,
//! synopsis, architecture, plan, checklists, user stories — any name,
//! any number, per project scope. A section record is
//! `{ scope, name, kind, title, body, order }`; `body` is LWW text
//! (an automerge map put per write), `kind` is `md` or `checklist`.
//! Scopes are repo identities (see `repo_identity_in`) or `global`.
//!
//! Doc shape (inside the bag doc):
//! ```text
//! root
//! └─ sections: Map<scope -> Map<name -> {kind, title, body, order}>>
//! ```
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
/// no leading/trailing dot. Dots nest (`checklist.build`).
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name.split('.').all(|seg| !seg.is_empty())
        && !name.chars().any(char::is_whitespace)
}

/// A checklist body's progress: (done, total) over `- [x]` / `- [ ]` lines.
pub fn checklist_progress(body: &str) -> (usize, usize) {
    let (mut done, mut total) = (0, 0);
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("- [ ] ") {
            if !rest.trim().is_empty() {
                total += 1;
            }
        } else if let Some(rest) = t
            .strip_prefix("- [x] ")
            .or_else(|| t.strip_prefix("- [X] "))
        {
            if !rest.trim().is_empty() {
                done += 1;
                total += 1;
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

    /// Create or replace a section; returns true if it replaced one.
    pub fn section_put(&mut self, s: &Section) -> Result<bool> {
        if !valid_name(&s.name) {
            return Err(format!("ws: bad section name {:?}", s.name).into());
        }
        let existed = self.section_get(&s.scope, &s.name)?.is_some();
        let sections = self.ensure_sections()?;
        let scope_id = match self.doc.get(&sections, s.scope.as_str())? {
            Some((_, id)) => id,
            None => self
                .doc
                .put_object(&sections, s.scope.as_str(), ObjType::Map)?,
        };
        let rec = self
            .doc
            .put_object(&scope_id, s.name.as_str(), ObjType::Map)?;
        self.doc.put(&rec, "kind", s.kind.as_str())?;
        self.doc.put(&rec, "title", s.title.as_str())?;
        self.doc.put(&rec, "body", s.body.as_str())?;
        self.doc.put(&rec, "order", s.order)?;
        self.doc.commit();
        self.flush()?;
        Ok(existed)
    }

    /// Read one section by (scope, name).
    pub fn section_get(&self, scope: &str, name: &str) -> Result<Option<Section>> {
        let Some(sections) = self.sections_opt() else {
            return Ok(None);
        };
        let Some((_, scope_id)) = self.doc.get(&sections, scope)? else {
            return Ok(None);
        };
        let Some((_, rec)) = self.doc.get(&scope_id, name)? else {
            return Ok(None);
        };
        let kind = SectionKind::parse(&self.sval(&rec, "kind")).unwrap_or_default();
        Ok(Some(Section {
            scope: scope.to_string(),
            name: name.to_string(),
            kind,
            title: self.sval(&rec, "title"),
            body: self.sval(&rec, "body"),
            order: self.ival(&rec, "order"),
        }))
    }

    /// All sections in `scope`, ordered by (order, name).
    pub fn section_list(&self, scope: &str) -> Result<Vec<Section>> {
        let mut out = Vec::new();
        if let Some(sections) = self.sections_opt() {
            if let Some((_, scope_id)) = self.doc.get(&sections, scope)? {
                for name in self.doc.keys(&scope_id) {
                    if let Some(s) = self.section_get(scope, &name)? {
                        out.push(s);
                    }
                }
            }
        }
        out.sort_by(|a, b| (a.order, a.name.as_str()).cmp(&(b.order, b.name.as_str())));
        Ok(out)
    }

    /// Scopes that hold at least one section, sorted.
    pub fn section_scopes(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if let Some(sections) = self.sections_opt() {
            for scope in self.doc.keys(&sections) {
                if let Some((_, scope_id)) = self.doc.get(&sections, scope.as_str())? {
                    if self.doc.keys(&scope_id).next().is_some() {
                        out.push(scope);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Delete a section; returns whether it existed.
    pub fn section_delete(&mut self, scope: &str, name: &str) -> Result<bool> {
        let Some(sections) = self.sections_opt() else {
            return Ok(false);
        };
        let Some((_, scope_id)) = self.doc.get(&sections, scope)? else {
            return Ok(false);
        };
        if !self.has(&scope_id, name) {
            return Ok(false);
        }
        self.doc.delete(&scope_id, name)?;
        self.doc.commit();
        self.flush()?;
        Ok(true)
    }

    /// Integer field on a section record (0 when absent).
    fn ival(&self, obj: &ObjId, key: &str) -> i64 {
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
        for name in ["", "a b", ".a", "a.", "a..b"] {
            let mut x = sec("sc", name, SectionKind::Md, 0);
            x.name = name.into();
            assert!(s.section_put(&x).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn survives_save_load() {
        let mut s = AutomergeStore::in_memory().unwrap();
        s.section_put(&sec("sc", "vision", SectionKind::Checklist, 3))
            .unwrap();
        let mut t = AutomergeStore::from_bytes(&s.save_bytes()).unwrap();
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
    fn kind_parse() {
        assert_eq!(SectionKind::parse("md"), Some(SectionKind::Md));
        assert_eq!(
            SectionKind::parse("checklist"),
            Some(SectionKind::Checklist)
        );
        assert_eq!(SectionKind::parse("yaml"), None);
    }
}
