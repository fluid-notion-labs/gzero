//! Comms transport B client: `CommsLayer` over the hub's addressed
//! mailbox (gzero item 64cd).
//!
//! The efficacy analysis (item 6db2) measured the automerge-doc comms
//! transport: conversation was 0.25% of the stream's bytes, presence
//! machinery 99.9%, and every client pulled everything. This client
//! speaks the fixed shape instead — addressed pull against the hub's
//! Inbox DO, where dest filtering happens server-side and presence is
//! a row query, not a write storm. There is no local doc and no
//! sync: the hub is the state; `sync()` is a no-op by construction.
//!
//! Selected with `CX_COMMS_TRANSPORT=inbox` (falls back to the doc
//! store when unset or misconfigured) — reads and writes must come
//! from the same store, so the plugin's bar probe uses the same flag.

use crate::comms::CommsLayer;
use crate::messages::{Broadcast, BroadcastState, Inbox, Message, MESSAGE_TTL_SECS};
use crate::sessions::SessionInfo;
use serde_json::Value;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

/// The transport-B comms layer. Stateless: cursors aren't needed
/// because the server filters (per-dest rows, unseen broadcasts) —
/// each read is a complete answer over the client's own data.
pub struct InboxStore {
    base: String,
    token: String,
}

impl InboxStore {
    /// From `CX_HUB_URL` + `CX_TOKEN`. Error (not None) so a set flag
    /// with missing config is a loud configuration bug, not silence.
    pub fn from_env() -> Result<Self, String> {
        let base = std::env::var("CX_HUB_URL")
            .ok()
            .filter(|u| !u.is_empty())
            .ok_or("inbox: CX_HUB_URL is not set")?;
        let token = std::env::var("CX_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .ok_or("inbox: CX_TOKEN is not set")?;
        Ok(InboxStore {
            base: base.trim_end_matches('/').to_string(),
            token,
        })
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new().timeout(TIMEOUT).build()
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let resp = Self::agent()
            .get(&format!("{}{}", self.base, path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| format!("hub {path}: {e}"))?;
        resp.into_json::<Value>()
            .map_err(|e| format!("hub {path}: decode: {e}"))
    }

    fn send(&self, method: &str, path: &str, body: Value) -> Result<Value, String> {
        let resp = Self::agent()
            .request(method, &format!("{}{}", self.base, path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| format!("hub {path}: {e}"))?;
        resp.into_json::<Value>()
            .map_err(|e| format!("hub {path}: decode: {e}"))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.send("POST", path, body)
    }

    fn id_string(v: &Value, key: &str) -> String {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    fn i64_of(v: &Value, key: &str) -> i64 {
        v.get(key).and_then(Value::as_i64).unwrap_or(0)
    }

    pub(crate) fn parse_message(v: &Value, dest: &str) -> Message {
        Message {
            id: Self::id_string(v, "id"),
            dest: dest.to_string(),
            sender: Self::id_string(v, "sender"),
            text: Self::id_string(v, "text"),
            created: Self::i64_of(v, "created"),
            read_at: Self::i64_of(v, "read_at"),
        }
    }

    pub(crate) fn parse_broadcast_state(v: &Value) -> BroadcastState {
        BroadcastState {
            id: Self::id_string(v, "id"),
            sender: Self::id_string(v, "sender"),
            text: Self::id_string(v, "text"),
            created: Self::i64_of(v, "created"),
            seen_at: Self::i64_of(v, "seen_at"),
        }
    }

    pub(crate) fn parse_session(v: &Value) -> SessionInfo {
        SessionInfo {
            session_id: Self::id_string(v, "session_id"),
            machine: Self::id_string(v, "machine"),
            scope: Self::id_string(v, "scope"),
            cwd: Self::id_string(v, "cwd"),
            pid: Self::i64_of(v, "pid"),
            label: Self::id_string(v, "label"),
            workspace: Self::id_string(v, "workspace"),
            started_at: Self::i64_of(v, "started_at"),
            last_seen: Self::i64_of(v, "last_seen"),
        }
    }

    /// Every live row addressed to `dest` (the hub applies the message
    /// TTL server-side; the limit covers a session's whole week).
    fn fetch_messages(&self, dest: &str) -> Result<Vec<Message>, String> {
        let v = self.get(&format!(
            "/inbox/{dest}/messages?since=0&limit=500"
        ))?;
        let empty = Vec::new();
        let rows = v.get("messages").and_then(Value::as_array).unwrap_or(&empty);
        Ok(rows.iter().map(|r| Self::parse_message(r, dest)).collect())
    }

    fn fetch_broadcasts(&self, session: &str) -> Result<Vec<BroadcastState>, String> {
        let v = self.get(&format!(
            "/broadcasts?since=0&limit=500&session={session}"
        ))?;
        let empty = Vec::new();
        let rows = v
            .get("broadcasts")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        Ok(rows.iter().map(Self::parse_broadcast_state).collect())
    }
}

impl CommsLayer for InboxStore {
    fn send_message(&mut self, dest: &str, sender: &str, text: &str) -> Result<Message, String> {
        let dest = dest.trim();
        let sender = sender.trim();
        let text = text.trim();
        if dest.is_empty() || sender.is_empty() || text.is_empty() {
            return Err("message: dest, sender and text are required".into());
        }
        self.post(
            "/inbox/messages",
            serde_json::json!({ "dest": dest, "sender": sender, "text": text }),
        )?;
        // The hub returns {id, seq}; created is server-side — the read
        // path refetches rows, so local timestamps here are display-only.
        Ok(Message {
            id: String::new(),
            dest: dest.to_string(),
            sender: sender.to_string(),
            text: text.to_string(),
            created: crate::sessions::now(),
            read_at: 0,
        })
    }

    fn unread_messages(&mut self, dest: &str) -> Result<Vec<Message>, String> {
        Ok(self
            .fetch_messages(dest)?
            .into_iter()
            .filter(|m| m.read_at == 0)
            .collect())
    }

    fn mark_messages_read(&mut self, dest: &str) -> Result<usize, String> {
        let unread: Vec<String> = self
            .fetch_messages(dest)?
            .into_iter()
            .filter(|m| m.read_at == 0)
            .map(|m| m.id)
            .collect();
        if unread.is_empty() {
            return Ok(0);
        }
        let v = self.post(
            &format!("/inbox/{dest}/read"),
            serde_json::json!({ "ids": unread }),
        )?;
        Ok(v.get("marked").and_then(Value::as_u64).unwrap_or(0) as usize)
    }

    fn post_broadcast(&mut self, sender: &str, text: &str) -> Result<Broadcast, String> {
        let sender = sender.trim();
        let text = text.trim();
        if sender.is_empty() || text.is_empty() {
            return Err("broadcast: sender and text are required".into());
        }
        self.post(
            "/broadcast",
            serde_json::json!({ "sender": sender, "text": text }),
        )?;
        Ok(Broadcast {
            id: String::new(),
            sender: sender.to_string(),
            text: text.to_string(),
            created: crate::sessions::now(),
        })
    }

    fn unseen_broadcasts(&mut self, session_id: &str) -> Result<Vec<Broadcast>, String> {
        Ok(self
            .fetch_broadcasts(session_id)?
            .into_iter()
            .map(|b| Broadcast {
                id: b.id,
                sender: b.sender,
                text: b.text,
                created: b.created,
            })
            .collect())
    }

    fn mark_broadcasts_seen(&mut self, session_id: &str, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        self.post(
            "/broadcasts/seen",
            serde_json::json!({ "session": session_id, "ids": ids }),
        )?;
        Ok(())
    }

    fn inbox(&mut self, session_id: &str) -> Result<Inbox, String> {
        Ok(Inbox {
            messages: self.fetch_messages(session_id)?,
            broadcasts: self.fetch_broadcasts(session_id)?,
        })
    }

    fn heartbeat(&mut self, s: &SessionInfo) -> Result<(), String> {
        self.send(
            "PUT",
            "/presence",
            serde_json::json!({
                "session": s.session_id,
                "machine": s.machine,
                "scope": s.scope,
                "cwd": s.cwd,
                "pid": s.pid,
                "started_at": s.started_at,
                "workspace": s.workspace,
                "label": s.label,
            }),
        )?;
        Ok(())
    }

    fn active_peers(&mut self, scope: &str, exclude: &str, ttl: i64) -> Result<Vec<SessionInfo>, String> {
        let v = self.get(&format!(
            "/presence?scope={scope}&exclude={exclude}&ttl={ttl}"
        ))?;
        let empty = Vec::new();
        let rows = v.get("sessions").and_then(Value::as_array).unwrap_or(&empty);
        Ok(rows.iter().map(Self::parse_session).collect())
    }

    fn all_sessions(&mut self) -> Result<Vec<SessionInfo>, String> {
        let v = self.get("/presence?all=1")?;
        let empty = Vec::new();
        let rows = v.get("sessions").and_then(Value::as_array).unwrap_or(&empty);
        Ok(rows.iter().map(Self::parse_session).collect())
    }

    /// Server-side GC: sweep rows older than the message TTL. Presence
    /// expiry is the hub's archive TTL, handled on read.
    fn sweep(&mut self) -> Result<usize, String> {
        let before = crate::sessions::now() - MESSAGE_TTL_SECS - 60;
        let v = self.post("/inbox/sweep", serde_json::json!({ "before": before }))?;
        Ok(v.get("messages_deleted").and_then(Value::as_u64).unwrap_or(0) as usize)
    }

    /// Nothing to sync: the hub holds the state; every read is fresh.
    fn sync(&mut self) -> Result<(usize, usize), String> {
        Ok((0, 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hub_rows_into_domain_types() {
        let m = InboxStore::parse_message(
            &serde_json::json!({
                "id": "m1", "dest": "d", "sender": "s", "text": "hi",
                "created": 100, "seq": 3, "read_at": 0
            }),
            "d",
        );
        assert_eq!(m.id, "m1");
        assert_eq!(m.sender, "s");
        assert_eq!(m.read_at, 0);

        let b = InboxStore::parse_broadcast_state(&serde_json::json!({
            "id": "b1", "sender": "s", "text": "yo", "created": 101, "seq": 2, "seen_at": 0
        }));
        assert_eq!(b.id, "b1");
        assert_eq!(b.seen_at, 0);

        let s = InboxStore::parse_session(&serde_json::json!({
            "session_id": "sess-1", "machine": "macpro", "scope": "repo",
            "cwd": "/tmp", "pid": 42, "started_at": 5, "last_seen": 9,
            "label": "l", "workspace": "ws"
        }));
        assert_eq!(s.session_id, "sess-1");
        assert_eq!(s.started_at, 5);
        assert_eq!(s.last_seen, 9);
    }

    /// Full lifecycle against a real hub (transport B endpoints);
    /// skips without HUB_TEST_URL (two-replica-test.sh boots one).
    #[test]
    fn transport_b_lifecycle_through_hub() {
        let Ok(base) = std::env::var("HUB_TEST_URL") else {
            eprintln!("skipping: HUB_TEST_URL not set");
            return;
        };
        std::env::set_var("CX_HUB_URL", &base);
        std::env::set_var("CX_TOKEN", "token");
        let mut store = InboxStore::from_env().unwrap();
        let tag = format!(
            "zz-lifecycle-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let (dest, sender) = (format!("{tag}-b"), format!("{tag}-a"));

        // message: send → unread → read → empty
        store.send_message(&dest, &sender, "across the wire").unwrap();
        let unread = store.unread_messages(&dest).unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].text, "across the wire");
        assert_eq!(store.mark_messages_read(&dest).unwrap(), 1);
        assert!(store.unread_messages(&dest).unwrap().is_empty());

        // broadcast: unseen for others, invisible to sender, drains
        store.post_broadcast(&sender, "to the board").unwrap();
        assert_eq!(store.unseen_broadcasts(&dest).unwrap().len(), 1);
        assert!(store.unseen_broadcasts(&sender).unwrap().is_empty());
        let ids: Vec<String> = store
            .fetch_broadcasts(&dest)
            .unwrap()
            .into_iter()
            .map(|b| b.id)
            .collect();
        store.mark_broadcasts_seen(&dest, &ids).unwrap();
        assert!(store.unseen_broadcasts(&dest).unwrap().is_empty());

        // presence: heartbeat → live peer → started_at preserved
        let beat = |last_seen: i64| SessionInfo {
            session_id: sender.clone(),
            machine: "m1".into(),
            scope: format!("{tag}-scope"),
            cwd: "/tmp".into(),
            pid: 1,
            label: String::new(),
            workspace: "default".into(),
            started_at: 1000,
            last_seen,
        };
        store.heartbeat(&beat(1)).unwrap();
        store.heartbeat(&beat(2)).unwrap();
        let peers = store
            .active_peers(&format!("{tag}-scope"), "other", PRESENCE_TTL_SECS)
            .unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].started_at, 1000);
        assert!(store.all_sessions().unwrap().iter().any(|s| s.session_id == sender));

        // sweep clears our scratch rows
        let before = crate::sessions::now() + 5;
        let v = store
            .post("/inbox/sweep", serde_json::json!({ "before": before }))
            .unwrap();
        assert!(v.get("messages_deleted").is_some());
    }
}
