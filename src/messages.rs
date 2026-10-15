//! Messages and broadcasts (S3 / S3b, Track S): the conversation layer.
//!
//! Ephemeral by design, like sessions (see `sessions.rs`): rows live in
//! the sqlite atom store, never enter snapshots, and expire by TTL rather
//! than being edited. A message is conversation, not memory — the store stays
//! durable-only. One-to-one is a message (`dest` = recipient session);
//! one-to-all is a broadcast (no dest; per-session read state drains
//! the board). `msg_read` and resolve delivery mark reads; sweeping
//! rides on the same piggyback as presence.

use std::collections::HashSet;

use rusqlite::params;

use crate::{items::fresh_id, Result, SqliteStore};

/// A message (or its unread state) counts as live for this long after
/// it was sent. Long enough to cross a weekend; short enough that
/// stale conversations don't accumulate.
pub const MESSAGE_TTL_SECS: i64 = 7 * 24 * 3600;

/// A one-to-one message between sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Message {
    pub id: String,
    /// Recipient session id.
    pub dest: String,
    pub sender: String,
    pub text: String,
    pub created: i64,
    /// Unix seconds when the recipient read it; 0 = unread.
    pub read_at: i64,
}

/// A one-to-all broadcast: shared board, information not demand.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Broadcast {
    pub id: String,
    pub sender: String,
    pub text: String,
    pub created: i64,
}

fn now() -> i64 {
    crate::sessions::now()
}

impl SqliteStore {
    // ---- messages (one-to-one) ----

    /// Send a message to a session. Returns the stored record.
    pub fn send_message(&self, dest: &str, sender: &str, text: &str) -> Result<Message> {
        let text = text.trim();
        if dest.is_empty() || sender.is_empty() || text.is_empty() {
            return Err("message: dest, sender and text are required".into());
        }
        let existing: HashSet<String> = self
            .conn()
            .prepare("SELECT id FROM messages")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;
        let m = Message {
            id: fresh_id(&existing),
            dest: dest.to_string(),
            sender: sender.to_string(),
            text: text.to_string(),
            created: now(),
            read_at: 0,
        };
        self.conn().execute(
            "INSERT INTO messages (id, dest, sender, text, created, read_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![m.id, m.dest, m.sender, m.text, m.created, m.read_at],
        )?;
        Ok(m)
    }

    /// Unread messages addressed to `dest`, oldest first.
    pub fn unread_messages(&self, dest: &str) -> Result<Vec<Message>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, dest, sender, text, created, read_at
             FROM messages WHERE dest = ?1 AND read_at = 0 ORDER BY created",
        )?;
        let rows = stmt.query_map(params![dest], message_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Mark all of `dest`'s unread messages read.
    pub fn mark_messages_read(&self, dest: &str) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE messages SET read_at = ?2 WHERE dest = ?1 AND read_at = 0",
            params![dest, now()],
        )?)
    }

    /// Delete messages older than the TTL. Returns how many expired.
    pub fn sweep_messages(&self, ttl: i64) -> Result<usize> {
        Ok(self.conn().execute(
            "DELETE FROM messages WHERE created < ?1",
            params![now() - ttl],
        )?)
    }

    // ---- broadcasts (one-to-all) ----

    /// Post a broadcast to the shared board.
    pub fn post_broadcast(&self, sender: &str, text: &str) -> Result<Broadcast> {
        let text = text.trim();
        if sender.is_empty() || text.is_empty() {
            return Err("broadcast: sender and text are required".into());
        }
        let existing: HashSet<String> = self
            .conn()
            .prepare("SELECT id FROM broadcasts")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;
        let b = Broadcast {
            id: fresh_id(&existing),
            sender: sender.to_string(),
            text: text.to_string(),
            created: now(),
        };
        self.conn().execute(
            "INSERT INTO broadcasts (id, sender, text, created) VALUES (?1, ?2, ?3, ?4)",
            params![b.id, b.sender, b.text, b.created],
        )?;
        Ok(b)
    }

    /// Broadcasts `session_id` has not seen yet, oldest first.
    pub fn unseen_broadcasts(&self, session_id: &str) -> Result<Vec<Broadcast>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, sender, text, created FROM broadcasts
             WHERE id NOT IN (SELECT broadcast_id FROM broadcast_reads WHERE session_id = ?1)
               AND sender != ?1
             ORDER BY created",
        )?;
        let rows = stmt.query_map(params![session_id], broadcast_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Drain the board: mark broadcasts seen for `session_id`. Per
    /// delivery, not per request — resolve shows them once.
    pub fn mark_broadcasts_seen(&self, session_id: &str, ids: &[String]) -> Result<()> {
        for id in ids {
            self.conn().execute(
                "INSERT OR IGNORE INTO broadcast_reads (broadcast_id, session_id, read_at)
                 VALUES (?1, ?2, ?3)",
                params![id, session_id, now()],
            )?;
        }
        Ok(())
    }

    /// Delete broadcasts older than the TTL plus their read state.
    /// Returns how many broadcasts expired.
    pub fn sweep_broadcasts(&self, ttl: i64) -> Result<usize> {
        let cutoff = now() - ttl;
        self.conn().execute(
            "DELETE FROM broadcast_reads WHERE broadcast_id IN
               (SELECT id FROM broadcasts WHERE created < ?1)",
            params![cutoff],
        )?;
        Ok(self
            .conn()
            .execute("DELETE FROM broadcasts WHERE created < ?1", params![cutoff])?)
    }
}

fn message_row(r: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: r.get(0)?,
        dest: r.get(1)?,
        sender: r.get(2)?,
        text: r.get(3)?,
        created: r.get(4)?,
        read_at: r.get(5)?,
    })
}

fn broadcast_row(r: &rusqlite::Row) -> rusqlite::Result<Broadcast> {
    Ok(Broadcast {
        id: r.get(0)?,
        sender: r.get(1)?,
        text: r.get(2)?,
        created: r.get(3)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_roundtrip_and_read() {
        let s = SqliteStore::in_memory().unwrap();
        let a = s
            .send_message("sess-b", "sess-a", "watch the edge case in compose")
            .unwrap();
        assert_ne!(a.id.len(), 0);
        // duplicate id not possible; second message gets a fresh id
        let b = s
            .send_message("sess-b", "sess-a", "second thought: also check reflow")
            .unwrap();
        assert_ne!(a.id, b.id);
        // wrong dest sees nothing
        assert!(s.unread_messages("sess-c").unwrap().is_empty());
        // dest sees both unread, oldest first
        let unread = s.unread_messages("sess-b").unwrap();
        assert_eq!(unread.len(), 2);
        assert_eq!(unread[0].id, a.id);
        // reading marks and drains
        assert_eq!(s.mark_messages_read("sess-b").unwrap(), 2);
        assert!(s.unread_messages("sess-b").unwrap().is_empty());
        // empty fields refused
        assert!(s.send_message("sess-b", "sess-a", "  ").is_err());
        assert!(s.send_message("", "sess-a", "x").is_err());
    }

    #[test]
    fn broadcast_seen_state_is_per_session() {
        let s = SqliteStore::in_memory().unwrap();
        let b1 = s
            .post_broadcast("sess-a", "tag 9ebe is pulling next")
            .unwrap();
        let b2 = s
            .post_broadcast("sess-a", "deploys paused until 5pm")
            .unwrap();
        assert_ne!(b1.id, b2.id);
        // sender never sees own broadcasts
        assert!(s.unseen_broadcasts("sess-a").unwrap().is_empty());
        // everyone else sees both until seen
        let for_b = s.unseen_broadcasts("sess-b").unwrap();
        assert_eq!(for_b.len(), 2);
        // seen state is per session: B drains, C still sees them
        let ids: Vec<String> = for_b.iter().map(|b| b.id.clone()).collect();
        s.mark_broadcasts_seen("sess-b", &ids).unwrap();
        assert!(s.unseen_broadcasts("sess-b").unwrap().is_empty());
        assert_eq!(s.unseen_broadcasts("sess-c").unwrap().len(), 2);
        // empty text refused
        assert!(s.post_broadcast("sess-a", "  ").is_err());
    }

    #[test]
    fn sweeps_expire_conversations_and_board() {
        let s = SqliteStore::in_memory().unwrap();
        let old = now() - MESSAGE_TTL_SECS - 10;
        s.send_message("sess-b", "sess-a", "stale").unwrap();
        s.post_broadcast("sess-a", "stale board").unwrap();
        // backdate both (test-only direct update)
        s.conn()
            .execute("UPDATE messages SET created = ?1", params![old])
            .unwrap();
        s.conn()
            .execute("UPDATE broadcasts SET created = ?1", params![old])
            .unwrap();
        assert_eq!(s.sweep_messages(MESSAGE_TTL_SECS).unwrap(), 1);
        assert_eq!(s.sweep_broadcasts(MESSAGE_TTL_SECS).unwrap(), 1);
        assert!(s.unread_messages("sess-b").unwrap().is_empty());
        assert!(s.unseen_broadcasts("sess-b").unwrap().is_empty());
    }
}
