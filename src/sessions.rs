//! Session presence (S1, Track S): who else is working in this scope.
//!
//! Ephemeral by design — rows live in the bag sqlite but are not atoms:
//! they never sync, never enter snapshots, and expire by TTL rather than
//! being edited. Resolve doubles as the heartbeat (it already runs every
//! turn), so presence needs no timer; stale entries are swept on the
//! same piggyback.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::{Result, SqliteStore};

/// A session counts as present for this long after its last heartbeat.
pub const PRESENCE_TTL_SECS: i64 = 5 * 60;

/// One session's presence row (the `sessions` table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    /// Stable for the lifetime of one pi session (plugin-generated UUID);
    /// CLI callers fall back to `cli-<pid>`.
    pub session_id: String,
    /// Stable per machine (machine-UUID file); CLI fallback is hostname.
    pub machine: String,
    /// Repo identity the session is working in.
    pub scope: String,
    /// Working directory at last heartbeat.
    pub cwd: String,
    pub pid: i64,
    /// Optional human label (e.g. "panel dev"), empty when unset.
    pub label: String,
    /// First heartbeat this session id was seen.
    pub started_at: i64,
    /// Last heartbeat (unix seconds).
    pub last_seen: i64,
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Session + machine identity from the environment. The pi plugin sets
/// CX_SESSION_ID (one UUID per session) and CX_MACHINE_ID (stable
/// machine-UUID file); CLI callers fall back to pid / hostname.
pub fn session_identity() -> (String, String) {
    let session = std::env::var("CX_SESSION_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("cli-{}", std::process::id()));
    let machine = std::env::var("CX_MACHINE_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| "unknown".into())
        });
    (session, machine)
}

impl SqliteStore {
    /// Record (or refresh) one session's presence. `started_at` survives
    /// the upsert; everything else reflects the latest heartbeat.
    pub fn heartbeat(&self, s: &SessionInfo) -> Result<()> {
        self.conn().execute(
            "INSERT INTO sessions
                (session_id, machine, scope, cwd, pid, label, started_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id) DO UPDATE SET
                machine = excluded.machine,
                scope = excluded.scope,
                cwd = excluded.cwd,
                pid = excluded.pid,
                label = excluded.label,
                last_seen = excluded.last_seen",
            params![
                s.session_id,
                s.machine,
                s.scope,
                s.cwd,
                s.pid,
                s.label,
                s.started_at,
                s.last_seen
            ],
        )?;
        Ok(())
    }

    /// Delete sessions whose last heartbeat is older than `ttl` seconds.
    /// Returns how many rows expired.
    pub fn sweep_sessions(&self, ttl: i64) -> Result<usize> {
        let n = self.conn().execute(
            "DELETE FROM sessions WHERE last_seen < ?1",
            params![now() - ttl],
        )?;
        Ok(n)
    }

    /// Sessions active in `scope` within `ttl` seconds, excluding
    /// `exclude` (the caller). Oldest first for stable display.
    pub fn active_peers(&self, scope: &str, exclude: &str, ttl: i64) -> Result<Vec<SessionInfo>> {
        let mut stmt = self.conn().prepare(
            "SELECT session_id, machine, scope, cwd, pid, label, started_at, last_seen
             FROM sessions
             WHERE scope = ?1 AND session_id != ?2 AND last_seen >= ?3
             ORDER BY started_at",
        )?;
        let rows = stmt.query_map(params![scope, exclude, now() - ttl], session_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// All presence rows, stale included — for inspection (`cx sessions`).
    pub fn all_sessions(&self) -> Result<Vec<SessionInfo>> {
        let mut stmt = self.conn().prepare(
            "SELECT session_id, machine, scope, cwd, pid, label, started_at, last_seen
             FROM sessions ORDER BY started_at",
        )?;
        let rows = stmt.query_map([], session_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<SessionInfo> {
    Ok(SessionInfo {
        session_id: r.get(0)?,
        machine: r.get(1)?,
        scope: r.get(2)?,
        cwd: r.get(3)?,
        pid: r.get(4)?,
        label: r.get(5)?,
        started_at: r.get(6)?,
        last_seen: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, scope: &str, seen: i64) -> SessionInfo {
        SessionInfo {
            session_id: id.into(),
            machine: "m1".into(),
            scope: scope.into(),
            cwd: "/tmp".into(),
            pid: 1,
            label: String::new(),
            started_at: seen,
            last_seen: seen,
        }
    }

    #[test]
    fn heartbeat_upserts_keeping_started_at() {
        let store = SqliteStore::in_memory().unwrap();
        let a = s("a", "repo", now() - 10);
        store.heartbeat(&a).unwrap();
        // later beat: started_at stays, last_seen moves
        let mut b = a.clone();
        b.last_seen = now();
        store.heartbeat(&b).unwrap();
        let all = store.all_sessions().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].started_at, a.started_at);
        assert_eq!(all[0].last_seen, b.last_seen);
    }

    #[test]
    fn peers_exclude_self_and_stale() {
        let store = SqliteStore::in_memory().unwrap();
        let t = now();
        store.heartbeat(&s("me", "repo", t)).unwrap();
        store.heartbeat(&s("peer", "repo", t)).unwrap();
        store
            .heartbeat(&s("old", "repo", t - PRESENCE_TTL_SECS - 5))
            .unwrap();
        store.heartbeat(&s("other-scope", "elsewhere", t)).unwrap();
        let peers = store.active_peers("repo", "me", PRESENCE_TTL_SECS).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].session_id, "peer");
        // sweeping drops the stale row
        assert_eq!(store.sweep_sessions(PRESENCE_TTL_SECS).unwrap(), 1);
        assert_eq!(store.all_sessions().unwrap().len(), 3);
    }

    #[test]
    fn identity_env_overrides() {
        // SAFETY: tests run single-threaded per process env mutation is
        // fine here (cargo test runs these in one thread each; env is
        // process-global but only this test reads these keys).
        std::env::set_var("CX_SESSION_ID", "sess-1");
        std::env::set_var("CX_MACHINE_ID", "box-9");
        let (session, machine) = session_identity();
        assert_eq!(session, "sess-1");
        assert_eq!(machine, "box-9");
        std::env::remove_var("CX_SESSION_ID");
        std::env::remove_var("CX_MACHINE_ID");
    }
}
