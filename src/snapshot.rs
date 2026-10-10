//! Snapshot document: the machine's published CRDT state and the
//! cross-machine merge unit. Mirrors `bagflow::Snapshot` field-for-field —
//! the JSON shape is the contract between implementations (see
//! `research/context/sync.md`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const SNAPSHOT_VERSION: u32 = 1;

/// One atom as it travels in a snapshot. Matches `bagflow::Atom`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Atom {
    pub text: String,
    pub scope: String,
    pub node: String,
    pub tags: BTreeSet<String>,
}

/// A versioned snapshot: alive atoms plus tombstones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub atoms: Vec<Atom>,
    pub tombstones: Vec<Atom>,
}

impl Snapshot {
    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec_pretty(self)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, String> {
        let snap: Snapshot =
            serde_json::from_slice(bytes).map_err(|e| format!("invalid snapshot: {e}"))?;
        if snap.version > SNAPSHOT_VERSION {
            return Err(format!(
                "snapshot version {} is newer than supported {SNAPSHOT_VERSION}",
                snap.version
            ));
        }
        Ok(snap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_json() {
        let snap = Snapshot {
            version: 1,
            atoms: vec![Atom {
                text: "keep it terse".into(),
                scope: "global".into(),
                node: "style".into(),
                tags: BTreeSet::from(["rust".to_string()]),
            }],
            tombstones: vec![Atom {
                text: "gone".into(),
                scope: "s".into(),
                node: "n".into(),
                tags: BTreeSet::new(),
            }],
        };
        let bytes = snap.to_json().unwrap();
        assert_eq!(Snapshot::from_json(&bytes).unwrap(), snap);
    }

    #[test]
    fn rejects_newer_versions() {
        let bytes = br#"{"version":99,"atoms":[],"tombstones":[]}"#;
        assert!(Snapshot::from_json(bytes).is_err());
    }
}
