//! D1 change transport: sync `AutomergeStore` changes through gzero-hub's
//! per-bag change endpoints.
//!
//! The hub is a change log, not a merge engine — clients push their
//! `changes_for` output and pull by seq cursor; automerge guarantees
//! convergence once both sides have the same changes.
//!
//! Config: `CX_HUB_URL` + `CX_TOKEN` (same vars as the legacy snapshot
//! client in `hub.rs`). Cursor management (which changes pushed, which
//! seqs pulled) is the caller's, since it must persist alongside the
//! store; see the two-replica test for the canonical loop.

use crate::AutomergeStore;
use automerge::ChangeHash;
use base64::Engine;
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const PAGE_LIMIT: u64 = 200;

pub struct HubChanges {
    base: String,
    token: String,
    bag: String,
}

/// One direction of sync for one replica.
#[derive(Default, Clone)]
pub struct SyncCursor {
    /// ChangeHashes already known to be on the hub (push cursor).
    pub pushed_heads: Vec<ChangeHash>,
    /// Highest seq pulled from the hub (pull cursor).
    pub pulled_seq: u64,
}

impl HubChanges {
    pub fn from_env(bag: &str) -> Option<HubChanges> {
        let base = std::env::var("CX_HUB_URL").ok().filter(|u| !u.is_empty())?;
        let token = std::env::var("CX_TOKEN").ok().filter(|t| !t.is_empty())?;
        Some(HubChanges {
            base: base.trim_end_matches('/').to_string(),
            token,
            bag: bag.to_string(),
        })
    }

    /// Push everything the store has that the hub hasn't seen.
    /// Returns the number of changes uploaded (0 when nothing to push).
    pub fn push(
        &self,
        store: &mut AutomergeStore,
        cursor: &mut SyncCursor,
    ) -> Result<usize, String> {
        let changes = store.changes_for(&cursor.pushed_heads);
        if changes.is_empty() {
            return Ok(0);
        }
        let n = changes.len();
        let body = serde_json::json!({
            "changes": changes
                .iter()
                .map(|c| base64::engine::general_purpose::STANDARD.encode(c.raw_bytes()))
                .collect::<Vec<_>>(),
            "machine_id": machine_id(),
        });
        let resp: serde_json::Value = self.post("/changes", &body)?;
        if resp.get("last_seq").and_then(|v| v.as_u64()).is_none() {
            return Err("hub: missing last_seq in push response".to_string());
        }
        cursor.pushed_heads = store.heads();
        Ok(n)
    }

    /// Pull everything after `cursor.pulled_seq` and apply it. Returns
    /// the number of changes applied.
    pub fn pull(
        &self,
        store: &mut AutomergeStore,
        cursor: &mut SyncCursor,
    ) -> Result<usize, String> {
        let mut applied = 0;
        loop {
            let path = format!("/changes?since={}&limit={PAGE_LIMIT}", cursor.pulled_seq);
            let resp: serde_json::Value = self.get(&path)?;
            let last = resp
                .get("last_seq")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "hub: missing last_seq in pull response".to_string())?;
            let b64s = resp
                .get("changes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "hub: missing changes in pull response".to_string())?;
            if b64s.is_empty() {
                cursor.pulled_seq = cursor.pulled_seq.max(last);
                return Ok(applied);
            }
            let mut changes = Vec::with_capacity(b64s.len());
            for v in b64s {
                let s = v
                    .as_str()
                    .ok_or_else(|| "hub: non-string change".to_string())?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(|e| format!("hub: bad base64 change: {e}"))?;
                changes.push(
                    automerge::Change::from_bytes(bytes)
                        .map_err(|e| format!("hub: bad change bytes: {e}"))?,
                );
            }
            let n = changes.len();
            let pulled_hashes: Vec<ChangeHash> = changes.iter().map(|c| c.hash()).collect();
            store
                .apply_changes(changes)
                .map_err(|e| format!("hub: apply_changes: {e}"))?;
            applied += n;
            // Pulled changes are, by definition, already on the hub —
            // record them in the push cursor so we never re-push what
            // another replica already uploaded (the hub does not dedup).
            cursor.pushed_heads.extend(pulled_hashes);
            match resp.get("next").and_then(|v| v.as_u64()) {
                Some(next) => cursor.pulled_seq = next,
                None => {
                    cursor.pulled_seq = cursor.pulled_seq.max(last);
                    return Ok(applied);
                }
            }
        }
    }

    /// The hub's highest change seq for this bag (epoch GC cursor).
    pub fn head_seq(&self) -> Result<u64, String> {
        let resp = self.get("/changes?since=0&limit=1")?;
        resp.get("last_seq")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "hub: missing last_seq in head_seq".to_string())
    }

    /// Epoch GC: drop this bag's change rows with seq < `before`.
    /// Callers must have pushed the new epoch first, with `before`
    /// set to the first seq of the new epoch's changes.
    pub fn truncate_before(&self, before: u64) -> Result<(), String> {
        self.post(
            "/truncate",
            &serde_json::json!({ "before": before, "machine_id": machine_id() }),
        )?;
        Ok(())
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new().timeout(TIMEOUT).build()
    }

    fn post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let resp = Self::agent()
            .post(&format!(
                "{}/bag/{}{}",
                self.base,
                self.bag.trim_matches('/'),
                path
            ))
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body.clone())
            .map_err(|e| format!("hub {path}: {e}"))?;
        parse_json(resp, path)
    }

    fn get(&self, path: &str) -> Result<serde_json::Value, String> {
        let resp = Self::agent()
            .get(&format!(
                "{}/bag/{}{}",
                self.base,
                self.bag.trim_matches('/'),
                path
            ))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| format!("hub {path}: {e}"))?;
        parse_json(resp, path)
    }
}

fn parse_json(resp: ureq::Response, path: &str) -> Result<serde_json::Value, String> {
    let status = resp.status();
    if status >= 400 {
        return Err(format!("hub {path}: HTTP {status}"));
    }
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("hub {path}: {e}"))
}

/// Pull + push in one round; the canonical `gzero sync` step. Pull
/// runs first so a cold replica adopts the peer's schema before it
/// ever creates its own root objects.
pub fn sync_once(
    store: &mut AutomergeStore,
    hub: &HubChanges,
    cursor: &mut SyncCursor,
) -> Result<(usize, usize), String> {
    let pulled = hub.pull(store, cursor)?;
    let pushed = hub.push(store, cursor)?;
    Ok((pushed, pulled))
}

impl SyncCursor {
    /// Persist to a sidecar JSON keyed by bag, so several bags can
    /// share one file next to the store.
    pub fn save(&self, sidecar: &Path, bag: &str) -> Result<(), String> {
        let mut root = if sidecar.exists() {
            serde_json::from_str(
                &std::fs::read_to_string(sidecar)
                    .map_err(|e| format!("sync cursor: {}: {e}", sidecar.display()))?,
            )
            .unwrap_or_else(|_| serde_json::json!({"bags": {}}))
        } else {
            serde_json::json!({"bags": {}})
        };
        root["bags"][bag] = serde_json::json!({
            "pushed_heads": self
                .pushed_heads
                .iter()
                .map(|h| hex::encode(h.as_ref()))
                .collect::<Vec<_>>(),
            "pulled_seq": self.pulled_seq,
        });
        let bytes = serde_json::to_vec_pretty(&root).map_err(|e| format!("sync cursor: {e}"))?;
        std::fs::write(sidecar, bytes)
            .map_err(|e| format!("sync cursor: {}: {e}", sidecar.display()))
    }

    /// Load this bag's cursor from the sidecar (empty when absent).
    pub fn load(sidecar: &Path, bag: &str) -> Result<SyncCursor, String> {
        if !sidecar.exists() {
            return Ok(SyncCursor::default());
        }
        let text = std::fs::read_to_string(sidecar)
            .map_err(|e| format!("sync cursor: {}: {e}", sidecar.display()))?;
        let root: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("sync cursor: {e}"))?;
        let entry = root.get("bags").and_then(|b| b.get(bag));
        let Some(entry) = entry else {
            return Ok(SyncCursor::default());
        };
        let mut pushed_heads = Vec::new();
        for h in entry
            .get("pushed_heads")
            .and_then(|v| v.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[])
        {
            let s = h.as_str().unwrap_or("");
            let bytes = hex::decode(s).map_err(|e| format!("sync cursor: bad hash {s:?}: {e}"))?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| format!("sync cursor: bad hash length {s:?}"))?;
            pushed_heads.push(ChangeHash(arr));
        }
        Ok(SyncCursor {
            pushed_heads,
            pulled_seq: entry
                .get("pulled_seq")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        })
    }
}

/// Sidecar path for a store doc: `<doc>.sync.json`.
pub fn sidecar_path(doc: &Path) -> std::path::PathBuf {
    let mut s = doc.as_os_str().to_os_string();
    s.push(".sync.json");
    std::path::PathBuf::from(s)
}

/// Stable-per-machine id for the hub's registry (best effort).
fn machine_id() -> String {
    std::env::var("CX_MACHINE_ID")
        .unwrap_or_else(|_| hostname().unwrap_or_else(|| "unknown".to_string()))
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{add_doc, alive};

    /// The D1 acceptance: two replicas converge through the hub,
    /// including conflicting edits. Requires a running hub — set
    /// HUB_TEST_URL (see gzero-hub/scripts/two-replica-test.sh).
    /// Skips silently when unset.
    #[test]
    fn two_replicas_converge_through_hub() {
        let Ok(base) = std::env::var("HUB_TEST_URL") else {
            eprintln!("skipping: HUB_TEST_URL not set");
            return;
        };
        std::env::set_var("CX_HUB_URL", &base);
        // Local dev hub uses the fake token from .dev.vars; a real
        // deployment (CX_TOKEN already in env) keeps its secret.
        if std::env::var("CX_TOKEN").map_or(true, |t| t.is_empty()) {
            std::env::set_var("CX_TOKEN", "token");
        }
        // Unique bag per run so reruns start from an empty log.
        let bag = format!(
            "test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let hub = HubChanges::from_env(&bag).expect("hub config");

        // Two replicas starting from the same point.
        let mut a = AutomergeStore::in_memory().unwrap();
        let mut b = AutomergeStore::from_bytes(&a.save_bytes()).unwrap();
        let mut cur_a = SyncCursor::default();
        let mut cur_b = SyncCursor::default();

        // 1. A makes a change and pushes.
        add_doc(&mut a, "a.md", "## n\n- one\n").unwrap();
        hub.push(&mut a, &mut cur_a).unwrap();

        // 2. B pulls and sees it.
        hub.pull(&mut b, &mut cur_b).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"one".to_string()), "B missing A's atom");

        // 3. Conflicting edits: both sides add the same text with
        //    different payloads under the same source, then both push.
        add_doc(&mut a, "shared.md", "## n\n- conflict [tag-a]\n").unwrap();
        add_doc(&mut b, "shared.md", "## n\n- conflict [tag-b]\n").unwrap();
        hub.push(&mut a, &mut cur_a).unwrap();
        hub.push(&mut b, &mut cur_b).unwrap();

        // 4. Mutual pull; both must converge without loss.
        hub.pull(&mut a, &mut cur_a).unwrap();
        hub.pull(&mut b, &mut cur_b).unwrap();

        let ta = alive(&a).unwrap();
        let tb = alive(&b).unwrap();
        assert_eq!(ta, tb, "replicas diverged");
        // Atom text is the full bullet (tags included), so the two
        // concurrent edits produce two atoms; both must survive.
        let texts: Vec<String> = ta.into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"one".to_string()));
        assert!(texts.contains(&"conflict [tag-a]".to_string()));
        assert!(texts.contains(&"conflict [tag-b]".to_string()));

        // 5. Idempotence: a full sync round leaves nothing to move.
        hub.push(&mut a, &mut cur_a).unwrap();
        let n = hub.pull(&mut b, &mut cur_b).unwrap();
        assert_eq!(n, 0, "unexpected extra changes after convergence");
    }

    /// The CLI path: two stores with doc files and cursor sidecars,
    /// driven only by `sync_once` + `SyncCursor::save/load` — exactly
    /// what `gzero sync` does. Requires HUB_TEST_URL (and ambient
    /// CX_TOKEN for a real deployment).
    #[test]
    fn cli_replicas_converge_through_hub() {
        let Ok(base) = std::env::var("HUB_TEST_URL") else {
            eprintln!("skipping: HUB_TEST_URL not set");
            return;
        };
        std::env::set_var("CX_HUB_URL", &base);
        if std::env::var("CX_TOKEN").map_or(true, |t| t.is_empty()) {
            std::env::set_var("CX_TOKEN", "token");
        }
        let bag = format!(
            "cli-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let hub = HubChanges::from_env(&bag).expect("hub config");
        let dir = std::env::temp_dir().join(format!("gzero-cli-sync-{}", bag));
        std::fs::create_dir_all(&dir).unwrap();
        let (doc_a, doc_b) = (dir.join("a.ws"), dir.join("b.ws"));

        let mut a = AutomergeStore::open(Some(&doc_a)).unwrap();
        add_doc(&mut a, "a.md", "## n\n- one\n").unwrap();
        let mut ca = SyncCursor::default();
        sync_once(&mut a, &hub, &mut ca).unwrap();
        ca.save(&sidecar_path(&doc_a), &bag).unwrap();

        // B opens cold, syncs from empty, and sees A's atom.
        let mut b = AutomergeStore::open(Some(&doc_b)).unwrap();
        let mut cb = SyncCursor::load(&sidecar_path(&doc_b), &bag).unwrap();
        assert!(cb.pushed_heads.is_empty() && cb.pulled_seq == 0);
        sync_once(&mut b, &hub, &mut cb).unwrap();
        cb.save(&sidecar_path(&doc_b), &bag).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"one".to_string()), "B missing A's atom");

        // Conflicting concurrent edits, then mutual sync_once rounds.
        // (Cursors are saved after each round, exactly like `gzero sync`.)
        add_doc(&mut a, "shared.md", "## n\n- conflict [tag-a]\n").unwrap();
        add_doc(&mut b, "shared.md", "## n\n- conflict [tag-b]\n").unwrap();
        sync_once(&mut a, &hub, &mut ca).unwrap();
        ca.save(&sidecar_path(&doc_a), &bag).unwrap();
        sync_once(&mut b, &hub, &mut cb).unwrap();
        cb.save(&sidecar_path(&doc_b), &bag).unwrap();
        sync_once(&mut a, &hub, &mut ca).unwrap();
        ca.save(&sidecar_path(&doc_a), &bag).unwrap();
        sync_once(&mut b, &hub, &mut cb).unwrap();
        cb.save(&sidecar_path(&doc_b), &bag).unwrap();

        let ta = alive(&a).unwrap();
        let tb = alive(&b).unwrap();
        assert_eq!(ta, tb, "replicas diverged");

        // Cursor reload from disk must be lossless.
        let ca2 = SyncCursor::load(&sidecar_path(&doc_a), &bag).unwrap();
        assert_eq!(ca2.pulled_seq, ca.pulled_seq);
        assert_eq!(ca2.pushed_heads.len(), ca.pushed_heads.len());

        // Quiet round.
        let (p, n) = sync_once(&mut a, &hub, &mut ca).unwrap();
        assert_eq!((p, n), (0, 0), "unexpected traffic after convergence");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The hard case: two replicas both initialize independently and
    /// write before first contact. Concurrent root-object creation must
    /// be reconciled — every replica converges to the winner's union.
    #[test]
    fn independently_initialized_replicas_converge() {
        let Ok(base) = std::env::var("HUB_TEST_URL") else {
            eprintln!("skipping: HUB_TEST_URL not set");
            return;
        };
        std::env::set_var("CX_HUB_URL", &base);
        if std::env::var("CX_TOKEN").map_or(true, |t| t.is_empty()) {
            std::env::set_var("CX_TOKEN", "token");
        }
        let bag = format!(
            "init-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let hub = HubChanges::from_env(&bag).expect("hub config");
        // Two fully independent stores, each with local data.
        let mut a = AutomergeStore::in_memory().unwrap();
        let mut b = AutomergeStore::in_memory().unwrap();
        add_doc(&mut a, "a.md", "## n\n- from-a\n").unwrap();
        add_doc(&mut b, "b.md", "## n\n- from-b\n").unwrap();
        let mut ca = SyncCursor::default();
        let mut cb = SyncCursor::default();
        // Mutual sync through the hub.
        sync_once(&mut a, &hub, &mut ca).unwrap();
        sync_once(&mut b, &hub, &mut cb).unwrap();
        sync_once(&mut a, &hub, &mut ca).unwrap();
        sync_once(&mut b, &hub, &mut cb).unwrap();
        let ta: Vec<String> = alive(&a).unwrap().into_iter().map(|(t, _)| t).collect();
        let tb: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(ta.contains(&"from-a".to_string()), "A lost its own atom");
        assert!(ta.contains(&"from-b".to_string()), "A missing B's atom");
        assert_eq!(ta, tb, "replicas diverged");
        // A subsequent write stays visible after another sync round.
        add_doc(&mut a, "a.md", "## n\n- from-a\n- later-a\n").unwrap();
        sync_once(&mut a, &hub, &mut ca).unwrap();
        sync_once(&mut b, &hub, &mut cb).unwrap();
        let tb: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(tb.contains(&"later-a".to_string()), "post-merge write lost");
    }
}
