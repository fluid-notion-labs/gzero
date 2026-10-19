//! Automerge-backed storage for gzero (plan2 L1).
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
use std::os::fd::AsRawFd;
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
    /// Conflict-count signature of the last successful root
    /// reconciliation, persisted in the hashes sidecar. Concurrent root
    /// creation can never be removed from the doc (automerge history),
    /// so reconciliation must not re-fold the losers on every pull —
    /// the fold is idempotent, and the conflict count only changes when
    /// a genuinely new conflicting root object arrives.
    roots_state: Option<[usize; 3]>,
    /// Advisory lock file handle (`<doc>.lock`), open but unlocked.
    /// Held open so `doc_lock`/`doc_unlock` reuse one file description:
    /// flock attaches to the description, so re-locking the same fd is
    /// instant (re-entrant within this store) while other stores and
    /// processes still block. This is what makes gzero-syncd and
    /// sessions safe co-writers of the doc file.
    lock: Option<std::fs::File>,
}

/// Hashes-sidecar key holding the reconciled root conflict counts.
const ROOTS_STATE_KEY: &str = "__roots__";

/// Root keys reconciled after pulls, in signature order.
const ROOT_KEYS: [&str; 3] = ["atoms", "tombs", "sections"];

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
            roots_state: None,
            lock: None,
        };
        if let Some(p) = &store.path {
            store.lock = Some(
                std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .open(Self::lock_path(p))?,
            );
        }
        // Root objects are created lazily (ensure_schema): a cold
        // replica that syncs before writing should adopt the peer's
        // schema from the change log instead of creating its own and
        // losing the concurrent-creation LWW race. Legacy docs (atoms
        // but no sections) still get their sections map here.
        if store.has(&ROOT, "atoms") && !store.has(&ROOT, "sections") {
            store.doc.put_object(ROOT, "sections", ObjType::Map)?;
            store.doc.commit();
        }
        if let Some(p) = &store.path {
            let hp = Self::hash_path(p);
            if hp.exists() {
                store.hashes = serde_json::from_reader(std::fs::File::open(hp)?)?;
            }
        }
        store.roots_state = store.roots_state_from_hashes();
        Ok(store)
    }

    /// Reconciled-root signature previously persisted in the hashes
    /// sidecar, if any.
    fn roots_state_from_hashes(&self) -> Option<[usize; 3]> {
        let raw = self.hashes.get(ROOTS_STATE_KEY)?;
        let mut parts = raw.split(',');
        let mut out = [0usize; 3];
        for v in out.iter_mut() {
            *v = parts.next()?.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        Some(out)
    }

    /// Persist the reconciled-root signature (hashes sidecar).
    fn save_roots_state(&mut self, counts: [usize; 3]) {
        self.roots_state = Some(counts);
        self.hashes.insert(
            ROOTS_STATE_KEY.to_string(),
            counts.map(|c| c.to_string()).join(","),
        );
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
            roots_state: None,
            lock: None,
        })
    }

    /// The doc file this store persists to, if any (`gzero watch` polls it).
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
        let hashes = self.doc.merge(&mut other.doc)?;
        self.reconcile_roots()?;
        Ok(hashes)
    }

    /// The doc's heads — change-transport cursor for the hub (step 3).
    pub fn heads(&mut self) -> Vec<ChangeHash> {
        self.doc.commit();
        self.doc.get_heads()
    }

    /// Apply changes fetched from another replica (step 3 transport).
    pub fn apply_changes(&mut self, changes: Vec<automerge::Change>) -> Result<()> {
        self.doc.apply_changes(changes)?;
        self.reconcile_roots()?;
        self.flush()
    }

    /// Create any missing root objects. Called before local writes;
    /// never before a sync that may deliver a peer's schema.
    fn ensure_schema(&mut self) -> Result<()> {
        if !self.has(&ROOT, "atoms") {
            self.doc.put_object(ROOT, "atoms", ObjType::Map)?;
        }
        if !self.has(&ROOT, "tombs") {
            self.doc.put_object(ROOT, "tombs", ObjType::Map)?;
        }
        if !self.has(&ROOT, "sections") {
            self.doc.put_object(ROOT, "sections", ObjType::Map)?;
        }
        self.doc.commit();
        Ok(())
    }

    /// After applying external changes, resolve concurrent root-object
    /// creation: if a root key holds several conflicting objects (two
    /// replicas that both initialized before first contact), fold every
    /// loser's contents into the winner. The winner is deterministic
    /// (automerge LWW over the merged change graph), so every replica
    /// folds into the same object and the stores converge to a union.
    fn reconcile_roots(&mut self) -> Result<()> {
        // Cheap first step: count the conflicting objects per root key
        // (microseconds). The expensive fold below runs only when the
        // signature changes, i.e. when a pull actually delivered a new
        // conflicting root object.
        let mut counts = [0usize; 3];
        for (i, key) in ROOT_KEYS.into_iter().enumerate() {
            counts[i] = self.doc.get_all(ROOT, key)?.len();
        }
        if self.roots_state == Some(counts) {
            return Ok(());
        }
        for key in ROOT_KEYS {
            let conflicts = self.doc.get_all(ROOT, key)?;
            if conflicts.len() <= 1 {
                continue;
            }
            let winner = match self.doc.get(ROOT, key)? {
                Some((_, id)) => id,
                None => continue,
            };
            let losers: Vec<ObjId> = conflicts
                .iter()
                .map(|(_, id)| id.clone())
                .filter(|id| *id != winner)
                .collect();
            for id in losers {
                self.deep_merge(&id, &winner)?;
            }
        }
        self.doc.commit();
        self.save_roots_state(counts);
        Ok(())
    }

    /// Merge every key of `src` into `dst` that `dst` lacks (maps
    /// recursively, scalars verbatim). Existing `dst` values win —
    /// matching the store's same-key LWW semantics.
    fn deep_merge(&mut self, src: &ObjId, dst: &ObjId) -> Result<()> {
        for k in self.doc.keys(src).collect::<Vec<_>>() {
            let srcv = self.doc.get(src, &k)?;
            let dstv = self.doc.get(dst, &k)?;
            match (dstv, srcv) {
                (Some((Value::Object(_), d)), Some((Value::Object(_), s))) => {
                    self.deep_merge(&s, &d)?;
                }
                (None, Some((Value::Object(ObjType::Map), s))) => {
                    let n = self.doc.put_object(dst, &k, ObjType::Map)?;
                    self.deep_merge(&s, &n)?;
                }
                (None, Some((Value::Scalar(s), _))) => {
                    let v = s.into_owned();
                    self.doc.put(dst, &k, v)?;
                }
                _ => {}
            }
        }
        Ok(())
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

    fn lock_path(path: &Path) -> PathBuf {
        let mut s = path.as_os_str().to_os_string();
        s.push(".lock");
        PathBuf::from(s)
    }

    /// Take the advisory exclusive lock on this store's doc file.
    /// Blocking. Re-entrant within one store (flock attaches to the
    /// open file description held in `self.lock`, so a second call on
    /// an already-held fd returns instantly) — that is what lets sync
    /// transactions call `flush` while holding the lock. No-op for
    /// in-memory stores.
    pub(crate) fn doc_lock(&mut self) {
        if let Some(f) = &self.lock {
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
        }
    }

    /// Release the advisory lock (no-op in memory).
    pub(crate) fn doc_unlock(&mut self) {
        if let Some(f) = &self.lock {
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
        }
    }

    /// Persist doc + hashes sidecar (no-op in memory).
    ///
    /// Under the doc lock, first merge whatever is currently on disk
    /// into the in-memory doc: a long-lived writer (the MCP comms
    /// store) may have loaded long before another writer (gzero-syncd
    /// pulling from the hub) saved new changes. Without the merge this
    /// full-document save would clobber them — with it, every flush is
    /// a merge, and co-writers converge instead of racing.
    pub(crate) fn flush(&mut self) -> Result<()> {
        let Some(p) = self.path.clone() else {
            return Ok(());
        };
        self.doc_lock();
        // Adopt concurrent on-disk changes (best effort: if the file is
        // missing or unreadable, our save simply replaces it).
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(mut disk) = AutoCommit::load(&bytes) {
                if self.doc.merge(&mut disk).is_ok() {
                    if let Ok(disk_hashes) = Self::read_hashes(&p) {
                        for (k, v) in disk_hashes {
                            self.hashes.entry(k).or_insert(v);
                        }
                    }
                    self.doc.commit();
                    self.reconcile_roots()?;
                }
            }
        }
        let doc_bytes = self.doc.save();
        let hash_bytes = serde_json::to_vec(&self.hashes)?;
        Self::atomic_write(&p, &doc_bytes)?;
        Self::atomic_write(&Self::hash_path(&p), &hash_bytes)?;
        self.doc_unlock();
        Ok(())
    }

    fn read_hashes(path: &Path) -> std::io::Result<BTreeMap<String, String>> {
        let bytes = std::fs::read(Self::hash_path(path))?;
        serde_json::from_slice(&bytes).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
        })
    }

    /// Write via a temp file + rename so concurrent readers (another
    /// store's merge-on-flush) never see a torn document.
    fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
        let tmp = path.with_extension(format!(
            "tmp-{}",
            std::process::id()
        ));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    // ---- doc accessors ----

    fn atoms_id(&self) -> Option<ObjId> {
        self.doc.get(ROOT, "atoms").ok().flatten().map(|(_, id)| id)
    }

    fn tombs_id(&self) -> Option<ObjId> {
        self.doc.get(ROOT, "tombs").ok().flatten().map(|(_, id)| id)
    }

    fn texts(&self) -> Vec<String> {
        match self.atoms_id() {
            Some(id) => self.doc.keys(&id).collect(),
            None => Vec::new(),
        }
    }

    fn rec_id(&self, text: &str) -> Option<ObjId> {
        let atoms = self.atoms_id()?;
        self.doc.get(&atoms, text).ok().flatten().map(|(_, id)| id)
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

    /// Write one source payload: replaced wholesale (same-source LWW),
    /// but only when the payload actually differs — a startup reconcile
    /// of unchanged seeds must not generate automerge churn (every
    /// delete+put pair is a new change that gets pushed to the hub).
    fn write_payload(&mut self, sources: &ObjId, source: &str, atom: &ParsedAtom) -> Result<()> {
        if let Some((_, payload)) = self.doc.get(sources, source).ok().flatten() {
            let current = self.read_payload(&payload, &atom.text);
            if current.scope == atom.scope
                && current.node == atom.node
                && current.tags == atom.tags
            {
                return Ok(());
            }
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
        let Some(tombs) = self.tombs_id() else {
            return Ok(false);
        };
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
        self.ensure_schema()?;
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
                self.doc.delete(&sources, source)?;
            }
        }

        // Add/update each atom (records and shadows kept forever).
        let atoms_obj = self
            .atoms_id()
            .expect("ensure_schema created the atoms object");
        for atom in atoms {
            let rec = match self.rec_id(&atom.text) {
                Some(rec) => rec,
                None => {
                    let r = self
                        .doc
                        .put_object(&atoms_obj, atom.text.as_str(), ObjType::Map)?;
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
        let mut out = Vec::new();
        let Some(tombs) = self.tombs_id() else {
            return Ok(out);
        };
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
        let path = dir.join(format!("gzero-automerge-test-{}.doc", std::process::id()));
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
    fn merge_on_flush_preserves_concurrent_writes() {
        // Two writers open the same doc file, then both write without
        // reloading. The second flush must adopt the first's changes
        // (merge-on-flush) instead of clobbering them — this is the
        // gzero-syncd / long-lived-session co-writer scenario.
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "gzero-merge-on-flush-{}.doc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let mut a = AutomergeStore::open(Some(&path)).unwrap();
            let mut b = AutomergeStore::open(Some(&path)).unwrap();
            add_doc(&mut a, "a.md", "## n\n- from-a\n").unwrap();
            // b is stale: it loaded before a's flush
            add_doc(&mut b, "b.md", "## n\n- from-b\n").unwrap();
        }
        let c = AutomergeStore::open(Some(&path)).unwrap();
        let texts: Vec<String> = alive(&c).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"from-a".to_string()), "a's write survived: {texts:?}");
        assert!(texts.contains(&"from-b".to_string()), "b's write survived: {texts:?}");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(AutomergeStore::hash_path(&path));
        let _ = std::fs::remove_file(AutomergeStore::lock_path(&path));
    }

    #[test]
    fn doc_lock_is_reentrant_and_serializes() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("gzero-doclock-{}.doc", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut a = AutomergeStore::open(Some(&path)).unwrap();
            let mut b = AutomergeStore::open(Some(&path)).unwrap();
            a.doc_lock();
            a.doc_lock(); // same store: re-entrant, no deadlock
            // Cross-store serialization is hard to assert without
            // threads; here we just prove a second store can acquire
            // after release (no lock leaks).
            a.doc_unlock();
            b.doc_lock();
            b.doc_unlock();
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(AutomergeStore::lock_path(&path));
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
