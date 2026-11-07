//! Comms store (Track S v1): messages, broadcasts and session presence
//! on their **own** automerge doc, synced through the hub under a
//! separate stream (`comms`) — design in `research/comms.md`.
//!
//! Why a separate doc instead of the context doc or hub-native rows:
//! chat is high-churn and ephemeral — it must not slow `resolve`, bloat
//! the durable store, or require being online at send time. The
//! automerge doc queues offline and converges through the same
//! change-log transport as everything else.
//!
//! Ephemeral semantics on an append-only store: TTL is **client-side**
//! (expired entries are filtered out of every view), and garbage
//! collection is an **epoch roll** — a replica periodically mints a
//! fresh doc holding only live data and asks the hub to truncate the
//! stream's change log below it (`StreamSync::truncate_before`,
//! best-effort: a hub without the endpoint simply skips GC, and
//! expired rows keep being filtered locally until then).
//!
//! Doc layout (all under ROOT):
//! ```text
//! ROOT ─ messages ─ <id> ─ {dest, sender, text, created}
//!      └ reads     ─ <msg id> ─ read_at          (absent = unread)
//!      └ broadcasts ─ <id> ─ {sender, text, created}
//!      └ broadcast_reads ─ <broadcast id> ─ <session> ─ read_at
//!      └ sessions ─ <session id> ─ {machine, scope, cwd, pid, label,
//!                                    workspace, started_at, last_seen}
//!      └ epoch ─ {n, base_seq}
//! ```

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use automerge::transaction::Transactable;
use automerge::{ObjId, ObjType, ReadDoc, ROOT, Value};

use crate::automerge_store::AutomergeStore;
use crate::stream_sync::{self, StreamSync, SyncCursor};
use crate::messages::{Broadcast, BroadcastState, Inbox, Message, MESSAGE_TTL_SECS};
use crate::sessions::{SessionInfo, PRESENCE_TTL_SECS};
use crate::{items::fresh_id, Result};

/// How much dead weight a comms stream accumulates before a replica rolls
/// the epoch. Sweeping at every resolve only counts; the roll happens
/// when this many expired messages are visible (`CX_EPOCH_ROLL_THRESHOLD`
/// overrides, for test runs that exercise the roll).
fn epoch_roll_threshold() -> usize {
    std::env::var("CX_EPOCH_ROLL_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(64)
}

/// Presence rows older than this are dropped at epoch roll (client-side
/// staleness already hides them long before).
const PRESENCE_ARCHIVE_TTL_SECS: i64 = 30 * 24 * 3600;

pub const COMMS_STREAM: &str = "comms";

/// The stream this machine's comms doc syncs under (`CX_COMMS_STREAM`
/// overrides, for isolated test runs against a shared hub).
pub fn comms_stream() -> String {
    std::env::var("CX_COMMS_STREAM")
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| COMMS_STREAM.to_string())
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The conversation layer as the MCP tools see it. Implemented by the
/// automerge [`CommsStore`] (default) and the legacy SQLite tables
/// (`CX_LEGACY_DB=1` rollback hatch, and in-memory tests).
pub trait CommsLayer {
    fn send_message(&mut self, dest: &str, sender: &str, text: &str) -> Result<Message>;
    fn unread_messages(&mut self, dest: &str) -> Result<Vec<Message>>;
    fn mark_messages_read(&mut self, dest: &str) -> Result<usize>;
    fn post_broadcast(&mut self, sender: &str, text: &str) -> Result<Broadcast>;
    fn unseen_broadcasts(&mut self, session_id: &str) -> Result<Vec<Broadcast>>;
    fn mark_broadcasts_seen(&mut self, session_id: &str, ids: &[String]) -> Result<()>;
    /// Read-only inspection: the session's full inbox (messages with
    /// read state, broadcasts with the session's seen time). Drains
    /// nothing — `msg_read` and resolve delivery do that.
    fn inbox(&mut self, session_id: &str) -> Result<Inbox>;
    fn heartbeat(&mut self, s: &SessionInfo) -> Result<()>;
    fn active_peers(&mut self, scope: &str, exclude: &str, ttl: i64) -> Result<Vec<SessionInfo>>;
    fn all_sessions(&mut self) -> Result<Vec<SessionInfo>>;
    /// Expire old rows. On the doc store this may trigger an epoch
    /// roll; on SQLite it deletes. Returns how many entries expired.
    fn sweep(&mut self) -> Result<usize>;
    /// Push + pull through the hub. No-op offline.
    fn sync(&mut self) -> Result<(usize, usize)>;
}

/// Default comms doc location (`CX_COMMS_DB` overrides).
pub fn comms_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("CX_COMMS_DB") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".pi/agent/comms.ws")
}

/// The automerge comms store: one doc per machine, merged through the
/// hub's change log (stream `comms`).
pub struct CommsStore {
    pub(crate) store: AutomergeStore,
    sidecar: Option<PathBuf>,
}

impl CommsStore {
    /// Open (or create) the comms doc. `None` = in-memory (tests).
    pub fn open(path: Option<&Path>) -> Result<Self> {
        let store = AutomergeStore::open(path)?;
        let sidecar = path.map(stream_sync::sidecar_path);
        Ok(Self { store, sidecar })
    }

    pub fn in_memory() -> Result<Self> {
        Self::open(None)
    }

    /// Root map for `key`, creating it on first use. Sync may deliver
    /// a peer's schema before any local write, so check before create.
    fn map(&mut self, key: &str) -> Result<ObjId> {
        if let Some(id) = self.root_map(key) {
            return Ok(id);
        }
        let id = self.store.doc.put_object(ROOT, key, ObjType::Map)?;
        Ok(id)
    }

    fn root_map(&self, key: &str) -> Option<ObjId> {
        match self.store.doc.get(ROOT, key) {
            Ok(Some((_, id))) => Some(id),
            _ => None,
        }
    }

    fn ival(obj: &ObjId, key: &str, doc: &automerge::AutoCommit) -> i64 {
        match doc.get(obj, key) {
            Ok(Some((Value::Scalar(s), _))) => match &*s {
                automerge::ScalarValue::Int(v) => *v,
                _ => 0,
            },
            _ => 0,
        }
    }

    fn sval(obj: &ObjId, key: &str, doc: &automerge::AutoCommit) -> String {
        match doc.get(obj, key) {
            Ok(Some((Value::Scalar(s), _))) => match &*s {
                automerge::ScalarValue::Str(v) => v.to_string(),
                _ => String::new(),
            },
            _ => String::new(),
        }
    }

    fn put_i64(obj: &ObjId, key: &str, v: i64, doc: &mut automerge::AutoCommit) -> Result<()> {
        doc.put(obj, key, v)?;
        Ok(())
    }

    /// Record object under a map key; `None` when absent.
    fn rec_of(map: &ObjId, doc: &automerge::AutoCommit, key: &str) -> Option<ObjId> {
        match doc.get(map, key) {
            Ok(Some((_, id))) => Some(id),
            _ => None,
        }
    }

    /// Read one message record; `None` when the id is unknown.
    fn read_message(&self, id: &str) -> Option<Message> {
        let m = self.root_map("messages")?;
        let rec = Self::rec_of(&m, &self.store.doc, id)?;
        Some(Message {
            id: id.to_string(),
            dest: Self::sval(&rec, "dest", &self.store.doc),
            sender: Self::sval(&rec, "sender", &self.store.doc),
            text: Self::sval(&rec, "text", &self.store.doc),
            created: Self::ival(&rec, "created", &self.store.doc),
            read_at: self.read_at(id),
        })
    }

    fn read_at(&self, msg_id: &str) -> i64 {
        let Some(r) = self.root_map("reads") else {
            return 0;
        };
        match self.store.doc.get(&r, msg_id) {
            Ok(Some((Value::Scalar(s), _))) => match &*s {
                automerge::ScalarValue::Int(v) => *v,
                _ => 0,
            },
            _ => 0,
        }
    }

    /// Messages addressed to `dest`, oldest first, unfiltered by TTL.
    fn all_messages_to(&self, dest: &str) -> Vec<Message> {
        let Some(m) = self.root_map("messages") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for id in self.store.doc.keys(&m) {
            if let Some(msg) = self.read_message(&id) {
                if msg.dest == dest {
                    out.push(msg);
                }
            }
        }
        out.sort_by_key(|m| m.created);
        out
    }

    /// Count of expired (past-TTL) messages — the epoch roll trigger.
    fn expired_count(&self) -> usize {
        let cutoff = now() - MESSAGE_TTL_SECS;
        self.all_messages()
            .iter()
            .filter(|m| m.created < cutoff)
            .count()
    }

    fn all_messages(&self) -> Vec<Message> {
        let Some(m) = self.root_map("messages") else {
            return Vec::new();
        };
        self.store
            .doc
            .keys(&m)
            .filter_map(|id| self.read_message(&id))
            .collect()
    }

    /// Live broadcasts with per-session seen state, oldest first
    /// (sender excluded). Companion to `unseen_broadcasts` for
    /// read-only inspection: seen, not unseen.
    fn broadcast_states(&self, session_id: &str) -> Result<Vec<BroadcastState>> {
        let cutoff = now() - MESSAGE_TTL_SECS;
        let Some(b) = self.root_map("broadcasts") else {
            return Ok(Vec::new());
        };
        let br = self.root_map("broadcast_reads");
        let mut out = Vec::new();
        for id in self.store.doc.keys(&b) {
            let Some(rec) = Self::rec_of(&b, &self.store.doc, &id) else {
                continue;
            };
            let created = Self::ival(&rec, "created", &self.store.doc);
            if created < cutoff {
                continue;
            }
            let sender = Self::sval(&rec, "sender", &self.store.doc);
            if sender == session_id {
                continue;
            }
            let seen_at = br
                .as_ref()
                .and_then(|br| Self::rec_of(br, &self.store.doc, &id))
                .map(|per| Self::ival(&per, session_id, &self.store.doc))
                .unwrap_or(0);
            out.push(BroadcastState {
                id,
                sender,
                text: Self::sval(&rec, "text", &self.store.doc),
                created,
                seen_at,
            });
        }
        out.sort_by_key(|b| b.created);
        Ok(out)
    }

    /// Epoch number (0 before the first roll).
    /// Debug: every broadcast record (id, sender, text, created) with no
    /// TTL filter and no sender exclusion. Inspection aid for the board.
    pub fn debug_broadcasts(&self) -> Result<Vec<(String, String, String, i64)>> {
        let Some(b) = self.root_map("broadcasts") else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for id in self.store.doc.keys(&b) {
            let Some(rec) = Self::rec_of(&b, &self.store.doc, &id) else {
                continue;
            };
            out.push((
                id,
                Self::sval(&rec, "sender", &self.store.doc),
                Self::sval(&rec, "text", &self.store.doc),
                Self::ival(&rec, "created", &self.store.doc),
            ));
        }
        out.sort_by_key(|b| b.3);
        Ok(out)
    }

    /// Epoch number (0 before the first roll).

    pub fn epoch_n(&self) -> u64 {
        match self.root_map("epoch") {
            Some(id) => Self::ival(&id, "n", &self.store.doc) as u64,
            None => 0,
        }
    }

    /// Epoch roll: replace the doc with one holding only live data
    /// (messages/broadcasts inside TTL, presence inside the archive
    /// window), push it, and ask the hub to truncate the superseded
    /// log. Returns the new epoch number.
    pub fn roll_epoch(&mut self) -> Result<u64> {
        // 1. Drain live data into owned structs (drops all doc borrows).
        let cutoff = now() - MESSAGE_TTL_SECS;
        let presence_cutoff = now() - PRESENCE_ARCHIVE_TTL_SECS;

        let live_msgs: Vec<Message> = self
            .all_messages()
            .into_iter()
            .filter(|m| m.created >= cutoff)
            .collect();
        let live_bcasts: Vec<Broadcast> = match self.root_map("broadcasts") {
            Some(b) => self
                .store
                .doc
                .keys(&b)
                .filter_map(|id| {
                    let rec = Self::rec_of(&b, &self.store.doc, &id)?;
                    Some(Broadcast {
                        id,
                        sender: Self::sval(&rec, "sender", &self.store.doc),
                        text: Self::sval(&rec, "text", &self.store.doc),
                        created: Self::ival(&rec, "created", &self.store.doc),
                    })
                })
                .filter(|b| b.created >= cutoff)
                .collect(),
            None => Vec::new(),
        };
        let live_breads: Vec<(String, Vec<(String, i64)>)> = match self.root_map("broadcast_reads")
        {
            Some(br) => self
                .store
                .doc
                .keys(&br)
                .filter_map(|bid| {
                    let per = Self::rec_of(&br, &self.store.doc, &bid)?;
                    let entries: Vec<(String, i64)> = self
                        .store
                        .doc
                        .keys(&per)
                        .filter_map(|s| {
                            let at = Self::ival(&per, &s, &self.store.doc);
                            (at > 0).then(|| (s, at))
                        })
                        .collect();
                    (!entries.is_empty()).then(|| (bid, entries))
                })
                .collect(),
            None => Vec::new(),
        };
        let live_sessions: Vec<SessionInfo> = self
            .all_sessions()?
            .into_iter()
            .filter(|s| s.last_seen >= presence_cutoff)
            .collect();
        let live_b_ids: HashSet<&str> = live_bcasts.iter().map(|b| b.id.as_str()).collect();
        let live_breads: Vec<(String, Vec<(String, i64)>)> = live_breads
            .into_iter()
            .filter(|(bid, _)| live_b_ids.contains(bid.as_str()))
            .collect();

        // 2. Build the fresh epoch doc.
        let mut fresh = AutomergeStore::open(None)?;
        let msgs = fresh
            .doc
            .put_object(ROOT, "messages", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let reads = fresh
            .doc
            .put_object(ROOT, "reads", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let bcasts = fresh
            .doc
            .put_object(ROOT, "broadcasts", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let breads = fresh
            .doc
            .put_object(ROOT, "broadcast_reads", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let sess = fresh
            .doc
            .put_object(ROOT, "sessions", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let epoch = fresh
            .doc
            .put_object(ROOT, "epoch", ObjType::Map)
            .map_err(|e| e.to_string())?;
        let epoch_n = self.epoch_n() + 1;
        fresh.doc.put(&epoch, "n", epoch_n as i64).map_err(|e| e.to_string())?;

        for m in &live_msgs {
            let rec = fresh
                .doc
                .put_object(&msgs, &m.id, ObjType::Map)
                .map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "dest", m.dest.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "sender", m.sender.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "text", m.text.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "created", m.created).map_err(|e| e.to_string())?;
            if m.read_at > 0 {
                fresh.doc.put(&reads, &m.id, m.read_at).map_err(|e| e.to_string())?;
            }
        }
        for b in &live_bcasts {
            let rec = fresh
                .doc
                .put_object(&bcasts, &b.id, ObjType::Map)
                .map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "sender", b.sender.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "text", b.text.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "created", b.created).map_err(|e| e.to_string())?;
        }
        for (bid, entries) in &live_breads {
            let per = fresh
                .doc
                .put_object(&breads, bid, ObjType::Map)
                .map_err(|e| e.to_string())?;
            for (s, at) in entries {
                fresh.doc.put(&per, s, *at).map_err(|e| e.to_string())?;
            }
        }
        for s in &live_sessions {
            let rec = fresh
                .doc
                .put_object(&sess, &s.session_id, ObjType::Map)
                .map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "machine", s.machine.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "scope", s.scope.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "cwd", s.cwd.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "pid", s.pid).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "label", s.label.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "workspace", s.workspace.as_str()).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "started_at", s.started_at).map_err(|e| e.to_string())?;
            fresh.doc.put(&rec, "last_seen", s.last_seen).map_err(|e| e.to_string())?;
        }
        fresh.doc.commit();

        // 3. Swap in the fresh doc and push it as the new epoch.
        let bytes = fresh.save_bytes();
        self.store = if let Some(p) = self.store.path().map(|p| p.to_path_buf()) {
            std::fs::write(&p, &bytes).map_err(|e| format!("epoch roll: write: {e}"))?;
            AutomergeStore::open(Some(&p))?
        } else {
            AutomergeStore::from_bytes(&bytes)?
        };

        // Push the new epoch; truncate the superseded log. Only
        // file-backed replicas talk to the hub: an in-memory store is
        // ephemeral (tests), has no cursor to resume from, and must
        // never reach a production hub just because the ambient
        // environment has credentials (this actually truncated the
        // production comms log once).
        if self.sidecar.is_some() {
            if let Some(hub) = StreamSync::from_env(&comms_stream()) {
                let sidecar = self.sidecar.as_ref().unwrap();
                let mut cursor = SyncCursor::load(sidecar, &comms_stream())?;
                cursor.pushed_heads = Vec::new();
                let pushed = hub.push(&mut self.store, &mut cursor)?;
                cursor.save(sidecar, &comms_stream())?;
                if pushed > 0 {
                    if let Ok(head) = hub.head_seq() {
                        let before = head.saturating_sub(pushed as u64);
                        if before > 0 {
                            // GC is best-effort: a hub without the
                            // truncate endpoint just skips it.
                            let _ = hub.truncate_before(before);
                        }
                    }
                }
            }
        }
        Ok(epoch_n)
    }
}

impl CommsStore {
    /// Best-effort sync after a mutating call: the sender's process may
    /// exit right after, so the write must reach the hub now or wait
    /// for the next session start. Offline failures are ignored —
    /// the change log queues locally (automerge's job).
    fn after_write(&mut self) {
        let _ = self.sync();
    }
}

impl CommsLayer for CommsStore {
    fn send_message(&mut self, dest: &str, sender: &str, text: &str) -> Result<Message> {
        let text = text.trim();
        if dest.is_empty() || sender.is_empty() || text.is_empty() {
            return Err("message: dest, sender and text are required".into());
        }
        let m = self.map("messages")?;
        let existing: HashSet<String> = self.store.doc.keys(&m).collect();
        let msg = Message {
            id: fresh_id(&existing),
            dest: dest.to_string(),
            sender: sender.to_string(),
            text: text.to_string(),
            created: now(),
            read_at: 0,
        };
        let rec = self.store.doc.put_object(&m, &msg.id, ObjType::Map)?;
        self.store.doc.put(&rec, "dest", msg.dest.as_str())?;
        self.store.doc.put(&rec, "sender", msg.sender.as_str())?;
        self.store.doc.put(&rec, "text", msg.text.as_str())?;
        Self::put_i64(&rec, "created", msg.created, &mut self.store.doc)?;
        self.store.doc.commit();
        self.store.flush()?;
        self.after_write();
        Ok(msg)
    }

    fn unread_messages(&mut self, dest: &str) -> Result<Vec<Message>> {
        Ok(self
            .all_messages_to(dest)
            .into_iter()
            .filter(|m| m.read_at == 0 && m.created >= now() - MESSAGE_TTL_SECS)
            .collect())
    }

    fn mark_messages_read(&mut self, dest: &str) -> Result<usize> {
        let unread: Vec<String> = self
            .all_messages_to(dest)
            .into_iter()
            .filter(|m| m.read_at == 0)
            .map(|m| m.id)
            .collect();
        if unread.is_empty() {
            return Ok(0);
        }
        let r = self.map("reads")?;
        let t = now();
        for id in &unread {
            Self::put_i64(&r, id, t, &mut self.store.doc)?;
        }
        self.store.doc.commit();
        self.store.flush()?;
        self.after_write();
        Ok(unread.len())
    }

    fn post_broadcast(&mut self, sender: &str, text: &str) -> Result<Broadcast> {
        let text = text.trim();
        if sender.is_empty() || text.is_empty() {
            return Err("broadcast: sender and text are required".into());
        }
        let b = self.map("broadcasts")?;
        let existing: HashSet<String> = self.store.doc.keys(&b).collect();
        let bc = Broadcast {
            id: fresh_id(&existing),
            sender: sender.to_string(),
            text: text.to_string(),
            created: now(),
        };
        let rec = self.store.doc.put_object(&b, &bc.id, ObjType::Map)?;
        self.store.doc.put(&rec, "sender", bc.sender.as_str())?;
        self.store.doc.put(&rec, "text", bc.text.as_str())?;
        Self::put_i64(&rec, "created", bc.created, &mut self.store.doc)?;
        self.store.doc.commit();
        self.store.flush()?;
        self.after_write();
        Ok(bc)
    }

    fn unseen_broadcasts(&mut self, session_id: &str) -> Result<Vec<Broadcast>> {
        let cutoff = now() - MESSAGE_TTL_SECS;
        let Some(b) = self.root_map("broadcasts") else {
            return Ok(Vec::new());
        };
        let br = self.root_map("broadcast_reads");
        let mut out = Vec::new();
        for id in self.store.doc.keys(&b) {
            let Some(rec) = Self::rec_of(&b, &self.store.doc, &id) else {
                continue;
            };
            let created = Self::ival(&rec, "created", &self.store.doc);
            if created < cutoff {
                continue;
            }
            let sender = Self::sval(&rec, "sender", &self.store.doc);
            if sender == session_id {
                continue;
            }
            let seen = br
                .as_ref()
                .and_then(|br| Self::rec_of(br, &self.store.doc, &id))
                .map(|per| {
                    matches!(
                        self.store.doc.get(&per, session_id),
                        Ok(Some(_))
                    )
                })
                .unwrap_or(false);
            if seen {
                continue;
            }
            out.push(Broadcast {
                id,
                sender,
                text: Self::sval(&rec, "text", &self.store.doc),
                created,
            });
        }
        out.sort_by_key(|b| b.created);
        Ok(out)
    }

    fn mark_broadcasts_seen(&mut self, session_id: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let br = self.map("broadcast_reads")?;
        let t = now();
        for id in ids {
            let per = self.store.doc.put_object(&br, id, ObjType::Map)?;
            Self::put_i64(&per, session_id, t, &mut self.store.doc)?;
        }
        self.store.doc.commit();
        self.store.flush()?;
        self.after_write();
        Ok(())
    }

    fn inbox(&mut self, session_id: &str) -> Result<Inbox> {
        // Adopt co-writers' on-disk changes before reading: a long-lived
        // reader (the plugin's poller child) never flushes, so without
        // this it would stay stale until its next write.
        let _ = self.store.refresh();
        let cutoff = now() - MESSAGE_TTL_SECS;
        let messages: Vec<Message> = self
            .all_messages_to(session_id)
            .into_iter()
            .filter(|m| m.created >= cutoff)
            .collect();
        let broadcasts = self.broadcast_states(session_id)?;
        Ok(Inbox { messages, broadcasts })
    }

    fn heartbeat(&mut self, s: &SessionInfo) -> Result<()> {
        let sess = self.map("sessions")?;
        let existing = Self::rec_of(&sess, &self.store.doc, &s.session_id);
        let rec = match existing {
            Some(ref rec) => rec.clone(),
            None => self
                .store
                .doc
                .put_object(&sess, &s.session_id, ObjType::Map)?,
        };
        let started_prev = existing
            .as_ref()
            .map(|rec| Self::ival(rec, "started_at", &self.store.doc));
        let doc = &mut self.store.doc;
        doc.put(&rec, "machine", s.machine.as_str())?;
        doc.put(&rec, "scope", s.scope.as_str())?;
        doc.put(&rec, "cwd", s.cwd.as_str())?;
        Self::put_i64(&rec, "pid", s.pid, doc)?;
        doc.put(&rec, "label", s.label.as_str())?;
        doc.put(&rec, "workspace", s.workspace.as_str())?;
        // started_at survives updates (first-seen); last_seen always moves.
        let started = match started_prev {
            Some(v) if v > 0 => v,
            _ => s.last_seen,
        };
        Self::put_i64(&rec, "started_at", started, doc)?;
        Self::put_i64(&rec, "last_seen", s.last_seen, doc)?;
        self.store.doc.commit();
        self.store.flush()?;
        self.after_write();
        Ok(())
    }

    fn active_peers(&mut self, scope: &str, exclude: &str, ttl: i64) -> Result<Vec<SessionInfo>> {
        let cutoff = now() - ttl;
        let mut all = self.all_sessions()?;
        all.retain(|s| s.scope == scope && s.session_id != exclude && s.last_seen >= cutoff);
        Ok(all)
    }

    fn all_sessions(&mut self) -> Result<Vec<SessionInfo>> {
        let Some(sess) = self.root_map("sessions") else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for id in self.store.doc.keys(&sess) {
            let Some(rec) = Self::rec_of(&sess, &self.store.doc, &id) else {
                continue;
            };
            out.push(SessionInfo {
                session_id: id.clone(),
                machine: Self::sval(&rec, "machine", &self.store.doc),
                scope: Self::sval(&rec, "scope", &self.store.doc),
                cwd: Self::sval(&rec, "cwd", &self.store.doc),
                pid: Self::ival(&rec, "pid", &self.store.doc) as i64,
                label: Self::sval(&rec, "label", &self.store.doc),
                workspace: Self::sval(&rec, "workspace", &self.store.doc),
                started_at: Self::ival(&rec, "started_at", &self.store.doc),
                last_seen: Self::ival(&rec, "last_seen", &self.store.doc),
            });
        }
        out.sort_by_key(|s| s.started_at);
        Ok(out)
    }

    fn sweep(&mut self) -> Result<usize> {
        let expired = self.expired_count();
        if expired >= epoch_roll_threshold() {
            self.roll_epoch()?;
        }
        Ok(expired)
    }

    fn sync(&mut self) -> Result<(usize, usize)> {
        let Some(path) = self.store.path().map(|p| p.to_path_buf()) else {
            return Ok((0, 0));
        };
        let Some(hub) = StreamSync::from_env(&comms_stream()) else {
            return Ok((0, 0));
        };
        stream_sync::sync_store(&mut self.store, &hub, &stream_sync::sidecar_path(&path), &comms_stream())
            .map_err(|e| e.into())
    }
}

// The legacy SQLite path keeps serving `CX_LEGACY_DB=1` (and in-memory
// tests); it already implements every operation — adapt it to the trait.
impl CommsLayer for crate::sqlite::SqliteStore {
    fn send_message(&mut self, dest: &str, sender: &str, text: &str) -> Result<Message> {
        crate::sqlite::SqliteStore::send_message(self, dest, sender, text)
    }
    fn unread_messages(&mut self, dest: &str) -> Result<Vec<Message>> {
        crate::sqlite::SqliteStore::unread_messages(self, dest)
    }
    fn mark_messages_read(&mut self, dest: &str) -> Result<usize> {
        crate::sqlite::SqliteStore::mark_messages_read(self, dest)
    }
    fn post_broadcast(&mut self, sender: &str, text: &str) -> Result<Broadcast> {
        crate::sqlite::SqliteStore::post_broadcast(self, sender, text)
    }
    fn unseen_broadcasts(&mut self, session_id: &str) -> Result<Vec<Broadcast>> {
        crate::sqlite::SqliteStore::unseen_broadcasts(self, session_id)
    }
    fn mark_broadcasts_seen(&mut self, session_id: &str, ids: &[String]) -> Result<()> {
        crate::sqlite::SqliteStore::mark_broadcasts_seen(self, session_id, ids)
    }
    fn inbox(&mut self, session_id: &str) -> Result<Inbox> {
        crate::sqlite::SqliteStore::session_inbox(self, session_id)
    }
    fn heartbeat(&mut self, s: &SessionInfo) -> Result<()> {
        crate::sqlite::SqliteStore::heartbeat(self, s)
    }
    fn active_peers(&mut self, scope: &str, exclude: &str, ttl: i64) -> Result<Vec<SessionInfo>> {
        crate::sqlite::SqliteStore::active_peers(self, scope, exclude, ttl)
    }
    fn all_sessions(&mut self) -> Result<Vec<SessionInfo>> {
        crate::sqlite::SqliteStore::all_sessions(self)
    }
    fn sweep(&mut self) -> Result<usize> {
        let m = crate::sqlite::SqliteStore::sweep_messages(self, MESSAGE_TTL_SECS)?;
        let b = crate::sqlite::SqliteStore::sweep_broadcasts(self, MESSAGE_TTL_SECS)?;
        let s = crate::sqlite::SqliteStore::sweep_sessions(self, PRESENCE_TTL_SECS)?;
        Ok(m + b + s)
    }
    fn sync(&mut self) -> Result<(usize, usize)> {
        Ok((0, 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> CommsStore {
        CommsStore::in_memory().unwrap()
    }

    /// Backdate one message's `created` past the TTL.
    fn backdate(s: &mut CommsStore, msg_id: &str) {
        let m = s.root_map("messages").unwrap();
        let rec = CommsStore::rec_of(&m, &s.store.doc, msg_id).unwrap();
        CommsStore::put_i64(&rec, "created", now() - MESSAGE_TTL_SECS - 10, &mut s.store.doc)
            .unwrap();
        s.store.doc.commit();
    }

    fn beat(id: &str, last_seen: i64) -> SessionInfo {
        SessionInfo {
            session_id: id.into(),
            machine: "m1".into(),
            scope: "repo".into(),
            cwd: "/tmp".into(),
            pid: 1,
            label: String::new(),
            workspace: "default".into(),
            started_at: now(),
            last_seen,
        }
    }

    #[test]
    fn message_roundtrip_and_read_receipt() {
        let mut s = store();
        let m = s.send_message("sess-b", "sess-a", "hello").unwrap();
        assert_eq!(m.dest, "sess-b");
        assert_eq!(s.unread_messages("sess-b").unwrap().len(), 1);
        assert!(s.unread_messages("sess-a").unwrap().is_empty());
        assert_eq!(s.mark_messages_read("sess-b").unwrap(), 1);
        assert!(s.unread_messages("sess-b").unwrap().is_empty());
    }

    #[test]
    fn ttl_hides_expired_messages() {
        let mut s = store();
        let m = s.send_message("sess-b", "sess-a", "old").unwrap();
        backdate(&mut s, &m.id);
        assert!(s.unread_messages("sess-b").unwrap().is_empty());
        assert!(s.expired_count() >= 1);
    }

    #[test]
    fn broadcast_seen_state_is_per_session() {
        let mut s = store();
        let b = s.post_broadcast("sess-a", "heads up").unwrap();
        assert_eq!(s.unseen_broadcasts("sess-b").unwrap().len(), 1);
        assert!(s.unseen_broadcasts("sess-a").unwrap().is_empty()); // sender skips own
        s.mark_broadcasts_seen("sess-b", &[b.id.clone()]).unwrap();
        assert!(s.unseen_broadcasts("sess-b").unwrap().is_empty());
    }

    #[test]
    fn inbox_reports_read_state_without_draining() {
        let mut s = store();
        s.send_message("sess-b", "sess-a", "first").unwrap();
        s.send_message("sess-b", "sess-a", "second").unwrap();
        let inbox = s.inbox("sess-b").unwrap();
        assert_eq!(inbox.messages.len(), 2);
        assert!(inbox.messages.iter().all(|m| m.read_at == 0));
        assert!(inbox.broadcasts.is_empty());
        // reading elsewhere is reflected; the inbox itself drains nothing
        s.mark_messages_read("sess-b").unwrap();
        let inbox = s.inbox("sess-b").unwrap();
        assert!(inbox.messages.iter().all(|m| m.read_at > 0));
        assert!(s.unread_messages("sess-b").unwrap().is_empty());
    }

    #[test]
    fn inbox_carries_broadcast_seen_state() {
        let mut s = store();
        let b = s.post_broadcast("sess-a", "heads up").unwrap();
        let inbox = s.inbox("sess-b").unwrap();
        assert_eq!(inbox.broadcasts.len(), 1);
        assert_eq!(inbox.broadcasts[0].seen_at, 0);
        assert_eq!(inbox.broadcasts[0].text, "heads up");
        s.mark_broadcasts_seen("sess-b", &[b.id.clone()]).unwrap();
        let inbox = s.inbox("sess-b").unwrap();
        assert!(inbox.broadcasts[0].seen_at > 0);
        // sender excluded
        assert!(s.inbox("sess-a").unwrap().broadcasts.is_empty());
    }

    #[test]
    fn inbox_filters_expired() {
        let mut s = store();
        let m = s.send_message("sess-b", "sess-a", "old").unwrap();
        let b = s.post_broadcast("sess-a", "old board").unwrap();
        backdate(&mut s, &m.id);
        // backdate the broadcast too
        let bm = s.root_map("broadcasts").unwrap();
        let rec = CommsStore::rec_of(&bm, &s.store.doc, &b.id).unwrap();
        CommsStore::put_i64(&rec, "created", now() - MESSAGE_TTL_SECS - 10, &mut s.store.doc)
            .unwrap();
        let inbox = s.inbox("sess-b").unwrap();
        assert!(inbox.messages.is_empty());
        assert!(inbox.broadcasts.is_empty());
    }

    #[test]
    fn presence_heartbeat_and_peers() {
        let mut s = store();
        s.heartbeat(&beat("a", now())).unwrap();
        s.heartbeat(&beat("b", now())).unwrap();
        // Heartbeat again: started_at preserved, last_seen updated.
        s.heartbeat(&beat("a", now() + 5)).unwrap();
        // A stale peer (heartbeat far older than the presence TTL).
        s.heartbeat(&beat("c", now() - 3600)).unwrap();
        let all = s.all_sessions().unwrap();
        assert_eq!(all.len(), 3);
        let a = all.iter().find(|x| x.session_id == "a").unwrap();
        assert!(a.started_at <= now()); // kept from the first beat, not bumped to last_seen
        let peers = s.active_peers("repo", "a", PRESENCE_TTL_SECS).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].session_id, "b");
    }

    #[test]
    fn two_replicas_converge_through_doc_exchange() {
        let mut a = store();
        let mut b = store();
        a.send_message("sess-b", "sess-a", "cross the wire").unwrap();
        // Transport: exchange full docs (what the hub change log achieves).
        let bytes = a.store.save_bytes();
        b.store = AutomergeStore::from_bytes(&bytes).unwrap();
        let unread = b.unread_messages("sess-b").unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].text, "cross the wire");
        // Read receipt propagates back the same way.
        b.mark_messages_read("sess-b").unwrap();
        let bytes = b.store.save_bytes();
        a.store = AutomergeStore::from_bytes(&bytes).unwrap();
        assert!(a.unread_messages("sess-b").unwrap().is_empty());
    }

    /// The full GC loop through a real hub: a replica rolls the epoch,
    /// the new doc is pushed, the hub truncates the superseded log, and
    /// the other replica converges on the live data. Requires
    /// HUB_TEST_URL (gzero-hub/scripts/two-replica-test.sh); skips when
    /// unset.
    #[test]
    fn epoch_roll_converges_through_hub() {
        let Ok(base) = std::env::var("HUB_TEST_URL") else {
            eprintln!("skipping: HUB_TEST_URL not set");
            return;
        };
        std::env::set_var("CX_HUB_URL", &base);
        // Dev hub token (.dev.vars); this test targets a local hub only.
        std::env::set_var("CX_TOKEN", "token");
        std::env::set_var(
            "CX_COMMS_STREAM",
            format!(
                "comms-test-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ),
        );
        let hub = StreamSync::from_env(&comms_stream()).expect("hub config");

        // File-backed: only real replicas (with a cursor sidecar) push
        // an epoch roll to the hub.
        let dir = std::env::temp_dir().join(format!(
            "gzero-epoch-roll-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = CommsStore::open(Some(&dir.join("comms.ws"))).unwrap();
        a.send_message("sess-b", "sess-a", "survives the roll").unwrap();
        let mut b = CommsStore::in_memory().unwrap();
        b.store = AutomergeStore::from_bytes(&a.store.save_bytes()).unwrap();
        let mut cur_b = SyncCursor::default();

        // Roll: the new epoch is pushed inside roll_epoch; truncate is
        // best-effort against the hub.
        assert_eq!(a.roll_epoch().unwrap(), 1);

        // B pulls the new epoch and converges on the live data.
        hub.pull(&mut b.store, &mut cur_b).unwrap();
        let unread = b.unread_messages("sess-b").unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].text, "survives the roll");
        assert_eq!(b.epoch_n(), 1);
    }

    #[test]
    fn epoch_roll_keeps_live_and_drops_expired() {
        let mut s = store();
        s.send_message("sess-b", "sess-a", "keep me").unwrap();
        let expired = s.send_message("sess-b", "sess-a", "expire me").unwrap();
        s.heartbeat(&beat("a", now())).unwrap();
        backdate(&mut s, &expired.id);
        assert_eq!(s.epoch_n(), 0);
        let n = s.roll_epoch().unwrap();
        assert_eq!(n, 1);
        assert_eq!(s.epoch_n(), 1);
        let live: Vec<String> = s
            .all_messages_to("sess-b")
            .into_iter()
            .map(|m| m.text)
            .collect();
        assert_eq!(live, vec!["keep me".to_string()]);
        // Presence survives the roll.
        assert_eq!(s.all_sessions().unwrap().len(), 1);
    }
}
