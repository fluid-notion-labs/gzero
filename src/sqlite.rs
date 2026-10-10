//! SQLite storage backend for the context bag.
//!
//! One table, WAL mode, upsert = read-merge-write (count + 1, tag union).
//! `:memory:` opens an in-memory database for tests.

use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{Entry, Result, Storage};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS atoms (
    text  TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    node  TEXT NOT NULL,
    tags  TEXT NOT NULL DEFAULT '[]'
);";

/// SQLite-backed bag. One row per distinct atom text.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Open (creating the schema if needed). `:memory:` is supported.
    pub fn open(path: &str) -> Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            let conn = Connection::open(path)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn
        };
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// In-memory store for tests.
    pub fn in_memory() -> Result<Self> {
        Self::open(":memory:")
    }
}

impl Storage for SqliteStore {
    fn upsert(
        &mut self,
        text: &str,
        scope: &str,
        node: &str,
        tags: &BTreeSet<String>,
    ) -> Result<u64> {
        let existing: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT count, tags FROM atoms WHERE text = ?1",
                params![text],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (count, merged) = match existing {
            Some((c, tags_json)) => {
                let mut merged: BTreeSet<String> = serde_json::from_str(&tags_json)?;
                merged.extend(tags.iter().cloned());
                (c as u64 + 1, merged)
            }
            None => (1, tags.clone()),
        };
        let tags_json = serde_json::to_string(&merged)?;
        self.conn.execute(
            "INSERT INTO atoms (text, count, scope, node, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(text) DO UPDATE SET count = ?2, scope = ?3, node = ?4, tags = ?5",
            params![text, count, scope, node, tags_json],
        )?;
        Ok(count)
    }

    fn all(&self) -> Result<Vec<(String, Entry)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT text, count, scope, node, tags FROM atoms")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)? as u64,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (text, count, scope, node, tags_json) = row?;
            out.push((
                text,
                Entry {
                    count,
                    scope,
                    node,
                    tags: serde_json::from_str(&tags_json)?,
                },
            ));
        }
        Ok(out)
    }

    fn remove_matching(&mut self, needle: &str) -> Result<usize> {
        let matches: Vec<String> = self
            .all()?
            .into_iter()
            .filter(|(text, _)| text.contains(needle))
            .map(|(text, _)| text)
            .collect();
        let mut removed = 0;
        for text in &matches {
            removed += self.conn.execute("DELETE FROM atoms WHERE text = ?1", params![text])?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut store = SqliteStore::in_memory().unwrap();
        let mut tags = BTreeSet::new();
        tags.insert("rust".to_string());
        store.upsert("keep it terse", "global", "style", &tags).unwrap();
        let all = store.all().unwrap();
        assert_eq!(all[0].0, "keep it terse");
        assert_eq!(all[0].1.scope, "global");
        assert_eq!(all[0].1.count, 1);
        assert!(all[0].1.tags.contains("rust"));
    }
}
