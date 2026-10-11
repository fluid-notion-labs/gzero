//! Hub client: contexture-hub (Cloudflare Worker) in server mode.
//! Clients post events and consume snapshots; the hub merges.
//!
//! Config via env: `CX_HUB_URL` (e.g. https://contexture-hub.<subdomain>.workers.dev)
//! and `CX_TOKEN` (bearer). Absent vars = offline mode, no hub calls.

use crate::snapshot::{Atom, Snapshot};

#[derive(serde::Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Event {
    Put { atom: Atom },
    Remove { atom: Atom },
}

pub struct Hub {
    base: String,
    token: String,
}

/// Cap hub calls so an unreachable hub degrades quickly instead of
/// stalling session start (startup pull is on the critical path).
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

impl Hub {
    pub fn from_env() -> Option<Hub> {
        let base = std::env::var("CX_HUB_URL").ok().filter(|u| !u.is_empty())?;
        let token = std::env::var("CX_TOKEN").ok().filter(|t| !t.is_empty())?;
        Some(Hub {
            base: base.trim_end_matches('/').to_string(),
            token,
        })
    }

    fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<(), String> {
        let resp = ureq::AgentBuilder::new()
            .timeout(TIMEOUT)
            .build()
            .post(&format!("{base}{path}", base = self.base))
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body.clone())
            .map_err(|e| format!("hub {path}: {e}"))?;
        if resp.status() >= 400 {
            return Err(format!("hub {path}: HTTP {}", resp.status()));
        }
        Ok(())
    }

    /// Post events (best-effort callers handle the error).
    pub fn post_events(&self, events: &[Event]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        self.post_json("/events", &serde_json::json!(events))
    }

    /// Fetch the hub's merged snapshot.
    pub fn fetch_snapshot(&self) -> Result<Snapshot, String> {
        let resp = ureq::AgentBuilder::new()
            .timeout(TIMEOUT)
            .build()
            .get(&format!("{}/snapshot", self.base))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| format!("hub /snapshot: {e}"))?;
        let bytes = resp.into_string().map_err(|e| format!("hub: {e}"))?;
        Snapshot::from_json(bytes.as_bytes())
    }
}

/// Events for a snapshot: alive atoms as puts, tombstones as removes.
pub fn events_for_snapshot(snap: &Snapshot) -> Vec<Event> {
    let mut events: Vec<Event> = snap
        .tombstones
        .iter()
        .map(|atom| Event::Remove { atom: atom.clone() })
        .collect();
    events.extend(
        snap.atoms
            .iter()
            .map(|atom| Event::Put { atom: atom.clone() }),
    );
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn atom(text: &str) -> Atom {
        Atom {
            text: text.into(),
            scope: "s".into(),
            node: "n".into(),
            tags: BTreeSet::new(),
        }
    }

    #[test]
    fn events_cover_atoms_and_tombstones() {
        let snap = Snapshot {
            version: 1,
            atoms: vec![atom("alive")],
            tombstones: vec![atom("dead")],
        };
        let events = events_for_snapshot(&snap);
        assert_eq!(events.len(), 2);
        let removes = events
            .iter()
            .filter(|e| matches!(e, Event::Remove { .. }))
            .count();
        assert_eq!(removes, 1);
    }

    #[test]
    fn events_serialize_to_hub_wire_format() {
        let events = events_for_snapshot(&Snapshot {
            version: 1,
            atoms: vec![atom("x")],
            tombstones: vec![],
        });
        let json = serde_json::json!(events);
        assert_eq!(json[0]["op"], "put");
        assert_eq!(json[0]["atom"]["text"], "x");
    }
}
