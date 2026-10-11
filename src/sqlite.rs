//! SQLite storage backend for the context bag.
//!
//! One table, WAL mode. Rows are (text, source) assertions; sync replaces
//! all rows for a source in one transaction. `:memory:` opens an in-memory
//! database for tests. Schema v1 (count column) is detected and replaced.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::{ParsedAtom, Result, Row, Storage, SyncStats};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS atoms (
    text   TEXT NOT NULL,
    source TEXT NOT NULL,
    scope  TEXT NOT NULL,
    node   TEXT NOT NULL,
    tags   TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (text, source)
);
CREATE TABLE IF NOT EXISTS tombstones (
    text TEXT PRIMARY KEY,
    atom TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_hashes (
    source TEXT PRIMARY KEY,
    hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key  TEXT PRIMARY KEY,
    doc  TEXT NOT NULL
);";

/// SQLite-backed bag. One row per (text, source) assertion.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Open (creating or migrating the schema if needed). `:memory:` is
    /// supported.
    pub fn open(path: &str) -> Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            let conn = Connection::open(path)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn
        };
        Self::ensure_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Create the schema; replace pre-`source` (v1) tables, whose contents
    /// are re-importable from markdown.
    fn ensure_schema(conn: &Connection) -> Result<()> {
        let has_source: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('atoms') WHERE name = 'source'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !has_source {
            conn.execute("DROP TABLE IF EXISTS atoms", [])?;
        }
        conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    /// In-memory store for tests.
    pub fn in_memory() -> Result<Self> {
        Self::open(":memory:")
    }
}

/// Key–value annex: dotted keys ('a.b.c') map to whole documents.
/// Independent of the atom bag — no tags, no tombstones, not synced to
/// the hub; local to this database file.
impl SqliteStore {
    /// Upsert `key` → `doc`; returns true if the key already existed.
    pub fn kv_put(&mut self, key: &str, doc: &str) -> Result<bool> {
        let existed: bool = self
            .conn
            .query_row("SELECT 1 FROM kv WHERE key = ?1", params![key], |_| {
                Ok(true)
            })
            .unwrap_or(false);
        self.conn.execute(
            "INSERT OR REPLACE INTO kv (key, doc) VALUES (?1, ?2)",
            params![key, doc],
        )?;
        Ok(existed)
    }

    /// The document at exactly `key`, if any.
    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT doc FROM kv WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |r| r.get(0))?;
        Ok(rows.next().transpose()?)
    }

    /// All (key, doc) pairs strictly under `prefix` (the exact key itself
    /// excluded), sorted by key. Empty prefix matches every key.
    pub fn kv_children(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let stem = if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}.")
        };
        let mut stmt = self.conn.prepare("SELECT key, doc FROM kv ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (key, doc): (String, String) = row?;
            if key.starts_with(&stem) && key != prefix {
                out.push((key, doc));
            }
        }
        Ok(out)
    }

    /// Delete the document at exactly `key`; returns whether it existed.
    pub fn kv_delete(&mut self, key: &str) -> Result<bool> {
        let n = self
            .conn
            .execute("DELETE FROM kv WHERE key = ?1", params![key])?;
        Ok(n > 0)
    }
}

impl Storage for SqliteStore {
    fn sync_source(&mut self, source: &str, atoms: &[ParsedAtom]) -> Result<SyncStats> {
        let before: HashSet<String> = self
            .conn
            .prepare("SELECT text FROM atoms WHERE source = ?1")?
            .query_map(params![source], |r| r.get(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;

        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM atoms WHERE source = ?1", params![source])?;
        let mut now = HashSet::new();
        for a in atoms {
            let tags = serde_json::to_string(&a.tags)?;
            tx.execute(
                "INSERT OR REPLACE INTO atoms (text, source, scope, node, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![a.text, source, a.scope, a.node, tags],
            )?;
            now.insert(a.text.clone());
        }
        tx.commit()?;

        let kept = before.intersection(&now).count();
        Ok(SyncStats {
            added: now.len() - kept,
            removed: before.len() - kept,
            kept,
        })
    }

    fn all(&self) -> Result<Vec<Row>> {
        let mut stmt = self
            .conn
            .prepare("SELECT text, source, scope, node, tags FROM atoms ORDER BY source, text")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (text, source, scope, node, tags_json) = row?;
            out.push(Row {
                text,
                source,
                scope,
                node,
                tags: serde_json::from_str(&tags_json)?,
            });
        }
        Ok(out)
    }

    fn remove_matching(&mut self, needle: &str) -> Result<usize> {
        // Capture the merged representation so the tombstone atom matches
        // what other machines hold for this text.
        let matches: Vec<crate::snapshot::Atom> = crate::alive(self)?
            .into_iter()
            .filter(|(text, _)| text.contains(needle))
            .map(|(text, r)| crate::snapshot::Atom {
                text,
                scope: r.scope,
                node: r.node,
                tags: r.tags,
            })
            .collect();
        let tombstoned = self.tombstone(&matches)?;
        for atom in &matches {
            self.conn
                .execute("DELETE FROM atoms WHERE text = ?1", params![atom.text])?;
        }
        Ok(tombstoned)
    }

    fn tombstones(&self) -> Result<Vec<crate::snapshot::Atom>> {
        let mut stmt = self
            .conn
            .prepare("SELECT atom FROM tombstones ORDER BY text")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    fn tombstone(&mut self, atoms: &[crate::snapshot::Atom]) -> Result<usize> {
        let mut added = 0;
        for atom in atoms {
            let json = serde_json::to_string(atom)?;
            added += self.conn.execute(
                "INSERT OR IGNORE INTO tombstones (text, atom) VALUES (?1, ?2)",
                params![atom.text, json],
            )?;
        }
        Ok(added)
    }

    fn source_hash(&self, source: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash FROM source_hashes WHERE source = ?1")?;
        let mut rows = stmt.query_map(params![source], |r| r.get::<_, String>(0))?;
        Ok(rows.next().transpose()?.filter(|h| !h.is_empty()))
    }

    fn set_source_hash(&mut self, source: &str, hash: Option<&str>) -> Result<()> {
        match hash {
            Some(h) => {
                self.conn.execute(
                    "INSERT OR REPLACE INTO source_hashes (source, hash) VALUES (?1, ?2)",
                    params![source, h],
                )?;
            }
            None => {
                self.conn.execute(
                    "DELETE FROM source_hashes WHERE source = ?1",
                    params![source],
                )?;
            }
        }
        Ok(())
    }

    fn forget_source(&mut self, source: &str) -> Result<Vec<crate::snapshot::Atom>> {
        // Texts asserted only by this source die with it (tombstoned, so
        // deletion survives hub sync); texts also asserted elsewhere keep
        // living there — delete only this source's assertions.
        let own: Vec<(String, String, String, String)> = self
            .conn
            .prepare("SELECT text, scope, node, tags FROM atoms WHERE source = ?1")?
            .query_map(params![source], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let elsewhere: HashSet<String> = self
            .conn
            .prepare("SELECT text FROM atoms WHERE source != ?1")?
            .query_map(params![source], |r| r.get(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;
        let mut dying = Vec::new();
        for (text, scope, node, tags_json) in &own {
            if elsewhere.contains(text) {
                continue;
            }
            dying.push(crate::snapshot::Atom {
                text: text.clone(),
                scope: scope.clone(),
                node: node.clone(),
                tags: serde_json::from_str(tags_json)?,
            });
        }
        self.tombstone(&dying)?;
        self.conn
            .execute("DELETE FROM atoms WHERE source = ?1", params![source])?;
        self.conn.execute(
            "DELETE FROM source_hashes WHERE source = ?1",
            params![source],
        )?;
        Ok(dying)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{add_doc, alive};
    use std::collections::BTreeSet;

    #[test]
    fn tombstones_exclude_and_survive() {
        let mut store = SqliteStore::in_memory().unwrap();
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
        // deleting the assertion again doesn't resurrect or duplicate
        store.sync_source("s", &[]).unwrap();
        assert_eq!(store.tombstones().unwrap().len(), 1);
    }

    fn tags(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn roundtrip_row() {
        let mut store = SqliteStore::in_memory().unwrap();
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
    }

    #[test]
    fn sync_stats_and_dedup() {
        let mut store = SqliteStore::in_memory().unwrap();
        let doc = "## a\n- x\n- y\n";
        assert_eq!(add_doc(&mut store, "a", doc).unwrap().added, 2);
        // same text from another source: new row, same text
        add_doc(&mut store, "b", "## a\n- x\n").unwrap();
        assert_eq!(store.all().unwrap().len(), 3);
        assert_eq!(alive(&store).unwrap().len(), 2);
    }

    #[test]
    fn parse_and_alive_integration() {
        let mut store = SqliteStore::in_memory().unwrap();
        add_doc(&mut store, "s", "# Context — demo\n\n## n\n- hello #w\n").unwrap();
        let rows = alive(&store).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "hello #w");
        assert!(rows[0].1.tags.contains("w"));
    }
}
