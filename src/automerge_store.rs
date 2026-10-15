//! Automerge-backed storage for contexture (plan2 L1).
//!
//! Design: `research/memory-plane.md` §L1 design. One automerge
//! document is the store; atom identity = text (map keys). We never
//! delete an `atoms` or `tombs` key — only `sources` keys are
//! deletable — so every op is a pure add-or-edit: adds commute,
//! tombstones are permanent by construction, and no concurrent re-add
//! can clobber one.
//!
//! Doc shape:
//! ```text
//! root
//! ├─ atoms: Map<text -> { sources: Map<source -> {scope, node, tags}> }>
//! └─ tombs: Map<text -> {scope, node, tags}>    // presence = dead
//! ```
//!
//! A record whose `sources` map is empty is a shadow: kept, invisible.
//! Harvest hashes are machine-local — a JSON sidecar next to the doc
//! file, never inside it. Tags ride as one `\x1f`-joined scalar per
//! source payload: a source's payload is replaced wholesale on
//! re-import, so per-payload LWW is exactly the semantics we want.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc, Value, ROOT};

use crate::{ParsedAtom, Result, Row, Storage, SyncStats};

/// Tags join character: never valid in markdown-derived strings.
const SEP: &str = "\u{1f}";

pub struct AutomergeStore {
    pub(crate) doc: AutoCommit,
    /// Doc file; `None` = in-memory. Hashes sidecar lives beside it.
    path: Option<PathBuf>,
    /// Machine-local harvest hashes (sidecar JSON, never in the doc).
    hashes: BTreeMap<String, String>,
    /// ChangeFeed subscribers (see events.rs); dead senders are dropped
    /// at drain time.
    pub(crate) subscribers: Vec<std::sync::mpsc::Sender<crate::events::ChangeEvent>>,
}

impl AutomergeStore {
    /// Open (or create) the doc at `path`. The hashes sidecar is a
    /// sibling file. Pass `None` for an in-memory store (tests).
    pub fn open(path: Option<&Path>) -> Result<Self> {
        let doc = match path {
            Some(p) if p.exists() => AutoCommit::load(&std::fs::read(p)?)?,
            _ => AutoCommit::new(),
        };
        let mut store = Self {
            doc,
            path: path.map(Path::to_path_buf),
            hashes: BTreeMap::new(),
            subscribers: Vec::new(),
        };
        if !store.has(&ROOT, "atoms") {
            store.doc.put_object(ROOT, "atoms", ObjType::Map)?;
            store.doc.put_object(ROOT, "tombs", ObjType::Map)?;
            store.doc.put_object(ROOT, "sections", ObjType::Map)?;
            store.doc.commit();
        } else if !store.has(&ROOT, "sections") {
            store.doc.put_object(ROOT, "sections", ObjType::Map)?;
            store.doc.commit();
        }
        if let Some(p) = &store.path {
            let hp = Self::hash_path(p);
            if hp.exists() {
                store.hashes = serde_json::from_reader(std::fs::File::open(hp)?)?;
            }
        }
        Ok(store)
    }

    /// In-memory store for tests.
    pub fn in_memory() -> Result<Self> {
        Self::open(None)
    }

    /// Load from `save_bytes` output (an independent fork).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self {
            doc: AutoCommit::load(bytes)?,
            path: None,
            hashes: BTreeMap::new(),
            subscribers: Vec::new(),
        })
    }

    /// The doc file this store persists to, if any (`cx watch` polls it).
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The whole doc — persistence, transport, offline exchange.
    pub fn save_bytes(&mut self) -> Vec<u8> {
        self.doc.commit();
        self.doc.save()
    }

    /// Merge `other`'s changes in (convergence is automerge's job).
    /// Returns the change hashes we didn't have before.
    pub fn merge(&mut self, other: &mut Self) -> Result<Vec<ChangeHash>> {
        Ok(self.doc.merge(&mut other.doc)?)
    }

    /// The doc's heads — change-transport cursor for the hub (step 3).
    pub fn heads(&mut self) -> Vec<ChangeHash> {
        self.doc.commit();
        self.doc.get_heads()
    }

    /// Apply changes fetched from another replica (step 3 transport).
    pub fn apply_changes(&mut self, changes: Vec<automerge::Change>) -> Result<()> {
        self.doc.apply_changes(changes)?;
        self.flush()
    }

    /// Changes the other replica is missing, given its heads.
    pub fn changes_for(&mut self, have: &[ChangeHash]) -> Vec<automerge::Change> {
        self.doc.commit();
        self.doc.get_changes(have)
    }

    fn hash_path(path: &Path) -> PathBuf {
        let mut s = path.as_os_str().to_os_string();
        s.push(".hashes.json");
        PathBuf::from(s)
    }

    /// Persist doc + hashes sidecar (no-op in memory).
    pub(crate) fn flush(&mut self) -> Result<()> {
        if let Some(p) = &self.path {
            std::fs::write(p, self.doc.save())?;
            std::fs::write(Self::hash_path(p), serde_json::to_string(&self.hashes)?)?;
        }
        Ok(())
    }

    // ---- doc accessors ----

    fn atoms_id(&self) -> ObjId {
        self.doc
            .get(ROOT, "atoms")
            .ok()
            .flatten()
            .expect("atoms object")
            .1
    }

    fn tombs_id(&self) -> ObjId {
        self.doc
            .get(ROOT, "tombs")
            .ok()
            .flatten()
            .expect("tombs object")
            .1
    }

    fn texts(&self) -> Vec<String> {
        self.doc.keys(self.atoms_id()).collect()
    }

    fn rec_id(&self, text: &str) -> Option<ObjId> {
        self.doc
            .get(self.atoms_id(), text)
            .ok()
            .flatten()
            .map(|(_, id)| id)
    }

    fn sources_id(&self, rec: &ObjId) -> Option<ObjId> {
        self.doc
            .get(rec, "sources")
            .ok()
            .flatten()
            .map(|(_, id)| id)
    }

    pub(crate) fn sval(&self, obj: &ObjId, key: &str) -> String {
        match self.doc.get(obj, key) {
            Ok(Some((Value::Scalar(s), _))) => match &*s {
                automerge::ScalarValue::Str(v) => v.to_string(),
                _ => String::new(),
            },
            _ => String::new(),
        }
    }

    /// Key present in `obj`?
    pub(crate) fn has(&self, obj: &ObjId, key: &str) -> bool {
        matches!(self.doc.get(obj, key), Ok(Some(_)))
    }

    /// Read one source payload (the `sources[source]` object).
    fn read_payload(&self, payload: &ObjId, text: &str) -> ParsedAtom {
        ParsedAtom {
            text: text.to_string(),
            scope: self.sval(payload, "scope"),
            node: self.sval(payload, "node"),
            tags: self
                .sval(payload, "tags")
                .split(SEP)
                .filter(|t| !t.is_empty())
                .map(String::from)
                .collect(),
        }
    }

    /// Write one source payload: replaced wholesale (same-source LWW).
    fn write_payload(&mut self, sources: &ObjId, source: &str, atom: &ParsedAtom) -> Result<()> {
        if self.has(sources, source) {
            self.doc.delete(sources, source)?;
        }
        let p = self.doc.put_object(sources, source, ObjType::Map)?;
        self.doc.put(&p, "scope", atom.scope.as_str())?;
        self.doc.put(&p, "node", atom.node.as_str())?;
        let tags: Vec<String> = atom.tags.iter().cloned().collect();
        self.doc.put(&p, "tags", tags.join(SEP))?;
        Ok(())
    }

    /// Add `tombs[text]` if absent (idempotent); returns whether added.
    fn write_tomb(&mut self, atom: &crate::snapshot::Atom) -> Result<bool> {
        let tombs = self.tombs_id();
        if self.has(&tombs, atom.text.as_str()) {
            return Ok(false);
        }
        let t = self
            .doc
            .put_object(&tombs, atom.text.as_str(), ObjType::Map)?;
        self.doc.put(&t, "scope", atom.scope.as_str())?;
        self.doc.put(&t, "node", atom.node.as_str())?;
        let tags: Vec<String> = atom.tags.iter().cloned().collect();
        self.doc.put(&t, "tags", tags.join(SEP))?;
        Ok(true)
    }
}

impl Storage for AutomergeStore {
    fn sync_source(&mut self, source: &str, atoms: &[ParsedAtom]) -> Result<SyncStats> {
        // Before: texts this source currently asserts.
        let mut before: HashSet<String> = HashSet::new();
        for text in self.texts() {
            if let Some(rec) = self.rec_id(&text) {
                if let Some(sources) = self.sources_id(&rec) {
                    if self.has(&sources, source) {
                        before.insert(text);
                    }
                }
            }
        }
        let now: HashSet<&str> = atoms.iter().map(|a| a.text.as_str()).collect();

        // Drop this source from records not in the new set. Never
        // touches `tombs` — file edits retract locally only, as ever.
        for text in &before {
            if !now.contains(text.as_str()) {
                let rec = self.rec_id(text).expect("record was just there");
                let sources = self.sources_id(&rec).expect("sources");
                self.doc.delete(&sources, source)?;
            }
        }

        // Add/update each atom (records and shadows kept forever).
        for atom in atoms {
            let rec = match self.rec_id(&atom.text) {
                Some(rec) => rec,
                None => {
                    let r =
                        self.doc
                            .put_object(self.atoms_id(), atom.text.as_str(), ObjType::Map)?;
                    self.doc.put_object(&r, "sources", ObjType::Map)?;
                    r
                }
            };
            let sources = self.sources_id(&rec).expect("sources");
            self.write_payload(&sources, source, atom)?;
        }
        self.doc.commit();
        self.flush()?;

        let now_owned: HashSet<String> = now.iter().map(|s| s.to_string()).collect();
        let kept = before.intersection(&now_owned).count();
        Ok(SyncStats {
            added: now.len() - kept,
            removed: before.len() - kept,
            kept,
        })
    }

    fn all(&self) -> Result<Vec<Row>> {
        let mut out = Vec::new();
        for text in self.texts() {
            let Some(rec) = self.rec_id(&text) else {
                continue;
            };
            let Some(sources) = self.sources_id(&rec) else {
                continue;
            };
            for source in self.doc.keys(&sources) {
                let Ok(Some((_, payload))) = self.doc.get(&sources, source.as_str()) else {
                    continue;
                };
                let a = self.read_payload(&payload, &text);
                out.push(Row {
                    text: text.clone(),
                    source,
                    scope: a.scope,
                    node: a.node,
                    tags: a.tags,
                });
            }
        }
        out.sort_by(|a, b| (&a.source, &a.text).cmp(&(&b.source, &b.text)));
        Ok(out)
    }

    fn remove_matching(&mut self, needle: &str) -> Result<usize> {
        // Capture the merged representation, as the tombstone atom must
        // match what other machines hold for this text.
        let victims: Vec<crate::snapshot::Atom> = crate::alive(self)?
            .into_iter()
            .filter(|(text, _)| text.contains(needle))
            .map(|(text, r)| crate::snapshot::Atom {
                text,
                scope: r.scope,
                node: r.node,
                tags: r.tags,
            })
            .collect();
        self.tombstone(&victims)?;
        Ok(victims.len())
    }

    fn tombstones(&self) -> Result<Vec<crate::snapshot::Atom>> {
        let tombs = self.tombs_id();
        let mut out = Vec::new();
        for text in self.doc.keys(&tombs) {
            if let Ok(Some((_, id))) = self.doc.get(&tombs, text.as_str()) {
                let a = self.read_payload(&id, &text);
                out.push(crate::snapshot::Atom {
                    text,
                    scope: a.scope,
                    node: a.node,
                    tags: a.tags,
                });
            }
        }
        out.sort_by(|a, b| a.text.cmp(&b.text));
        Ok(out)
    }

    fn tombstone(&mut self, atoms: &[crate::snapshot::Atom]) -> Result<usize> {
        let mut added = 0;
        for atom in atoms {
            if self.write_tomb(atom)? {
                added += 1;
            }
        }
        self.doc.commit();
        self.flush()?;
        Ok(added)
    }

    fn source_hash(&self, source: &str) -> Result<Option<String>> {
        Ok(self.hashes.get(source).cloned().filter(|h| !h.is_empty()))
    }

    fn set_source_hash(&mut self, source: &str, hash: Option<&str>) -> Result<()> {
        match hash {
            Some(h) => {
                self.hashes.insert(source.to_string(), h.to_string());
            }
            None => {
                self.hashes.remove(source);
            }
        }
        self.flush()
    }

    fn forget_source(&mut self, source: &str) -> Result<Vec<crate::snapshot::Atom>> {
        // Merged view for the frozen tombstone records.
        let merged: BTreeMap<String, Row> = crate::alive(self)?.into_iter().collect();
        let mut dying = Vec::new();
        for text in self.texts() {
            let Some(rec) = self.rec_id(&text) else {
                continue;
            };
            let Some(sources) = self.sources_id(&rec) else {
                continue;
            };
            let source_keys: Vec<String> = self.doc.keys(&sources).collect();
            if !source_keys.iter().any(|s| s == source) {
                continue; // nothing of ours here
            }
            self.doc.delete(&sources, source)?;
            let other = source_keys.iter().any(|s| s != source);
            if !other {
                // Texts asserted only by this source die with it.
                if let Some(r) = merged.get(&text) {
                    dying.push(crate::snapshot::Atom {
                        text: text.clone(),
                        scope: r.scope.clone(),
                        node: r.node.clone(),
                        tags: r.tags.clone(),
                    });
                }
            }
        }
        self.tombstone(&dying)?;
        Ok(dying)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{add_doc, alive};
    use std::collections::BTreeSet;

    fn tags(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tombstones_exclude_and_survive() {
        let mut store = AutomergeStore::in_memory().unwrap();
        add_doc(&mut store, "s", "## n\n- visible\n- doomed\n").unwrap();
        assert_eq!(alive(&store).unwrap().len(), 2);
        assert_eq!(store.remove_matching("doomed").unwrap(), 1);
        assert_eq!(alive(&store).unwrap().len(), 1);
        let tombs = store.tombstones().unwrap();
        assert_eq!(tombs.len(), 1);
        assert_eq!(tombs[0].text, "doomed");
        assert_eq!(tombs[0].node, "n");
        // tombstone is idempotent
        assert_eq!(store.tombstone(&tombs).unwrap(), 0);
        // re-asserting the text (alongside the survivor) does not
        // resurrect or duplicate the tombstone
        store
            .sync_source(
                "s",
                &[
                    ParsedAtom {
                        text: "visible".into(),
                        scope: "g".into(),
                        node: "n".into(),
                        tags: BTreeSet::new(),
                    },
                    ParsedAtom {
                        text: "doomed".into(),
                        scope: "g".into(),
                        node: "n".into(),
                        tags: BTreeSet::new(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(store.tombstones().unwrap().len(), 1);
        let rows = alive(&store).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "visible");
    }

    #[test]
    fn roundtrip_row_and_stats() {
        let mut store = AutomergeStore::in_memory().unwrap();
        let atoms = vec![ParsedAtom {
            text: "keep it terse".into(),
            scope: "global".into(),
            node: "style".into(),
            tags: tags(&["rust"]),
        }];
        let stats = store.sync_source("a.md", &atoms).unwrap();
        assert_eq!(stats.added, 1);
        let all = store.all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].text, "keep it terse");
        assert_eq!(all[0].source, "a.md");
        assert_eq!(all[0].tags, tags(&["rust"]));
        // re-sync same set: no adds, one kept
        let stats = store.sync_source("a.md", &atoms).unwrap();
        assert_eq!(stats.added, 0);
        assert_eq!(stats.kept, 1);
        assert_eq!(stats.removed, 0);
    }

    #[test]
    fn sync_dedup_same_text_two_sources() {
        let mut store = AutomergeStore::in_memory().unwrap();
        add_doc(&mut store, "a", "## a\n- x\n- y\n").unwrap();
        add_doc(&mut store, "b", "## a\n- x\n").unwrap();
        assert_eq!(store.all().unwrap().len(), 3);
        assert_eq!(alive(&store).unwrap().len(), 2);
    }

    #[test]
    fn per_source_replace_drops_and_shadow_keeps_other_source() {
        let mut store = AutomergeStore::in_memory().unwrap();
        add_doc(&mut store, "a", "## n\n- shared\n- only-a\n").unwrap();
        add_doc(&mut store, "b", "## n\n- shared\n").unwrap();
        assert_eq!(alive(&store).unwrap().len(), 2);
        // a edits its file: only-a gone, no tombstone (local retraction)
        add_doc(&mut store, "a", "## n\n- shared\n").unwrap();
        let rows = alive(&store).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "shared");
        assert!(store.tombstones().unwrap().is_empty());
        // no tombstone (local retraction); only-a is a shadow record —
        // all() holds one row per (text, source): shared from a and b
        let all = store.all().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|r| r.text == "shared"));
    }

    #[test]
    fn forget_source_tombstones_only_own() {
        let mut store = AutomergeStore::in_memory().unwrap();
        add_doc(&mut store, "a", "## n\n- shared\n- only-a\n").unwrap();
        add_doc(&mut store, "b", "## n\n- shared\n").unwrap();
        let dying = store.forget_source("a").unwrap();
        assert_eq!(dying.len(), 1);
        assert_eq!(dying[0].text, "only-a");
        let rows = alive(&store).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "shared");
        assert_eq!(store.tombstones().unwrap().len(), 1);
    }

    #[test]
    fn persistence_roundtrip() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("cx-automerge-test-{}.doc", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut store = AutomergeStore::open(Some(&path)).unwrap();
            add_doc(&mut store, "a.md", "## n\n- persisted\n").unwrap();
            store.set_source_hash("a.md", Some("h1")).unwrap();
        }
        let store = AutomergeStore::open(Some(&path)).unwrap();
        assert_eq!(alive(&store).unwrap().len(), 1);
        assert_eq!(store.source_hash("a.md").unwrap().as_deref(), Some("h1"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(AutomergeStore::hash_path(&path));
    }

    #[test]
    fn two_machines_merge_and_tombstone_propagates() {
        // machine A starts alone
        let mut a = AutomergeStore::in_memory().unwrap();
        add_doc(&mut a, "a.md", "## n\n- from-a\n- also-b\n").unwrap();
        // machine B forks from A's published state
        let mut b = AutomergeStore::from_bytes(&a.save_bytes()).unwrap();
        // both work concurrently
        add_doc(&mut a, "a.md", "## n\n- from-a\n- also-b\n- extra-a\n").unwrap();
        add_doc(&mut b, "b.md", "## n\n- also-b\n- from-b\n").unwrap();
        // sync: B merges A's changes (and vice versa)
        let mut a2 = AutomergeStore::from_bytes(&a.save_bytes()).unwrap();
        b.merge(&mut a2).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"from-a".to_string()));
        assert!(texts.contains(&"from-b".to_string()));
        assert!(texts.contains(&"extra-a".to_string()));
        // A removes a text: the tombstone wins on B after merge
        a.remove_matching("extra-a").unwrap();
        let mut a3 = AutomergeStore::from_bytes(&a.save_bytes()).unwrap();
        b.merge(&mut a3).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(!texts.contains(&"extra-a".to_string()));
    }

    #[test]
    fn changes_transport_incremental() {
        let mut a = AutomergeStore::in_memory().unwrap();
        add_doc(&mut a, "a.md", "## n\n- one\n").unwrap();
        let mut b = AutomergeStore::from_bytes(&a.save_bytes()).unwrap();
        // A adds; B fetches only what it's missing (its heads)
        add_doc(&mut a, "a.md", "## n\n- one\n- two\n").unwrap();
        let have = b.heads();
        let changes = a.changes_for(&have);
        assert!(!changes.is_empty());
        b.apply_changes(changes).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"two".to_string()));
    }
}
