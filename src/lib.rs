//! Context bag: a persisted multiset of terse, tagged instruction atoms.
//!
//! Spec: `research/context/findings.md` and `plan.md` in
//! `~/projects/explorations` (the `context` concept).
//!
//! Authoring format is homoiconic markdown — it is both the prose and the data:
//!
//! ```text
//! # Context — global      → scope (title, lowercased)
//! ## style                → node; untagged node = default set
//! ## build #rust          → opt-in node, active when #rust is referenced
//! - one atomic rule       → atom; inline #hashtags add tags
//! ```
//!
//! The bag is a hashtable keyed by atom text (`count` = multiplicity, tags
//! merge on re-import). Storage is pluggable via [`Storage`]; SQLite is the
//! first backend.

use std::collections::BTreeSet;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub mod sqlite;
pub use sqlite::SqliteStore;

/// One atom's record in the bag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Multiplicity: how many imports asserted this fact.
    pub count: u64,
    /// Scope slug from the `# Context — <scope>` title.
    pub scope: String,
    /// Node slug from the `## <slug> [#tags]` heading.
    pub node: String,
    /// Node tags plus inline hashtags. Empty = default set.
    pub tags: BTreeSet<String>,
}

/// Storage backend contract. SQLite now; D1/JSON later behind the same trait.
pub trait Storage {
    /// Insert or merge one atom; returns the updated count.
    fn upsert(&mut self, text: &str, scope: &str, node: &str, tags: &BTreeSet<String>)
        -> Result<u64>;
    /// All atoms as (text, entry).
    fn all(&self) -> Result<Vec<(String, Entry)>>;
    /// Remove atoms whose text contains `needle`; returns how many.
    fn remove_matching(&mut self, needle: &str) -> Result<usize>;
}

/// An atom as parsed from markdown, before storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAtom {
    pub text: String,
    pub scope: String,
    pub node: String,
    pub tags: BTreeSet<String>,
}

/// Parse a context file into atoms. See crate docs for the format.
pub fn parse(input: &str) -> Vec<ParsedAtom> {
    let mut scope = String::from("untitled");
    let mut node = String::from("_root");
    let mut node_tags = BTreeSet::new();
    let mut out = Vec::new();
    for line in input.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            scope = title_scope(rest);
            node = String::from("_root");
            node_tags.clear();
        } else if let Some(rest) = t.strip_prefix("## ") {
            let (slug, tags) = heading(rest);
            node = slug;
            node_tags = tags;
        } else if let Some(rest) = t.strip_prefix("- ") {
            let mut tags = node_tags.clone();
            tags.extend(hashtags(rest));
            out.push(ParsedAtom {
                text: rest.to_string(),
                scope: scope.clone(),
                node: node.clone(),
                tags,
            });
        } else if !t.is_empty() && line.starts_with([' ', '\t']) {
            // wrapped continuation of the previous bullet: rejoin it
            if let Some(last) = out.last_mut() {
                last.text.push(' ');
                last.text.push_str(t);
            }
        }
    }
    out
}

/// Import one parsed markdown document into the store.
pub fn add_doc(store: &mut dyn Storage, input: &str) -> Result<usize> {
    let atoms = parse(input);
    let n = atoms.len();
    for a in &atoms {
        store.upsert(&a.text, &a.scope, &a.node, &a.tags)?;
    }
    Ok(n)
}

/// Atoms active by default (untagged) plus any referenced tags, sorted by
/// (scope, node, text). Each fact once by construction (hashtable key).
pub fn resolve(store: &dyn Storage, referenced: &BTreeSet<String>) -> Result<Vec<(String, Entry)>> {
    let mut items: Vec<(String, Entry)> = store
        .all()?
        .into_iter()
        .filter(|(_, e)| e.tags.is_empty() || referenced.iter().any(|t| e.tags.contains(t)))
        .collect();
    items.sort_by(|a, b| (&a.1.scope, &a.1.node, &a.0).cmp(&(&b.1.scope, &b.1.node, &b.0)));
    Ok(items)
}

/// Tag vocabulary with the number of atoms carrying each tag.
pub fn tag_counts(store: &dyn Storage) -> Result<Vec<(String, usize)>> {
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for (_, e) in store.all()? {
        for t in &e.tags {
            *counts.entry(t.clone()).or_default() += 1;
        }
    }
    Ok(counts.into_iter().collect())
}

/// Scope slug from a `# ` title: lowercase, `context`/`pack` words and
/// separators stripped. `Context — global` → `global`; `rust pack` → `rust`.
fn title_scope(title: &str) -> String {
    let mut s = title.trim().to_ascii_lowercase();
    if let Some(rest) = s.strip_prefix("context") {
        s = rest.to_string();
    }
    if let Some(rest) = s.strip_suffix("pack") {
        s = rest.to_string();
    }
    s.trim_matches(|c: char| matches!(c, '—' | '–' | '-' | ':' | ' ')).to_string()
}

/// Node slug and tags from a `## ` heading: leading non-`#` tokens become
/// the slug (words joined with `-`), `#tag` tokens become tags.
fn heading(line: &str) -> (String, BTreeSet<String>) {
    let mut slug: Vec<&str> = Vec::new();
    let mut tags = BTreeSet::new();
    for tok in line.split_whitespace() {
        if let Some(t) = tok.strip_prefix('#') {
            if !t.is_empty() {
                tags.insert(t.to_ascii_lowercase());
            }
        } else if tags.is_empty() {
            slug.push(tok);
        }
    }
    (slug.join("-").to_ascii_lowercase(), tags)
}

/// Inline hashtags in atom text: whitespace-delimited tokens starting with `#`.
fn hashtags(text: &str) -> BTreeSet<String> {
    text.split_whitespace()
        .filter_map(|t| t.strip_prefix('#'))
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# Context — test\n\n## core\n- always on\n- keep #tagged\n\n## extra #rust\n- opt in only\n";

    #[test]
    fn parse_scopes_nodes_atoms() {
        let atoms = parse(DOC);
        assert_eq!(atoms.len(), 3);
        assert_eq!(atoms[0].scope, "test");
        assert_eq!(atoms[0].node, "core");
        assert!(atoms[0].tags.is_empty());
        assert!(atoms[1].tags.contains("tagged"));
        assert_eq!(atoms[2].node, "extra");
        assert!(atoms[2].tags.contains("rust"));
    }

    #[test]
    fn default_excludes_tagged_nodes() {
        let mut store = SqliteStore::in_memory().unwrap();
        add_doc(&mut store, DOC).unwrap();
        // default: only the untagged atom; inline hashtags are opt-in too
        let none = resolve(&store, &BTreeSet::new()).unwrap();
        assert_eq!(none.len(), 1);
        let mut tagged = BTreeSet::new();
        tagged.insert("tagged".to_string());
        assert_eq!(resolve(&store, &tagged).unwrap().len(), 2);
        let mut rust = BTreeSet::new();
        rust.insert("rust".to_string());
        assert_eq!(resolve(&store, &rust).unwrap().len(), 2);
    }

    #[test]
    fn wrapped_bullet_lines_rejoin() {
        let atoms = parse("## a\n- first line\n  second line\n- next\n");
        assert_eq!(atoms.len(), 2);
        assert_eq!(atoms[0].text, "first line second line");
    }

    #[test]
    fn upsert_counts_and_merges_tags() {
        let mut store = SqliteStore::in_memory().unwrap();
        let mut tags = BTreeSet::new();
        tags.insert("a".to_string());
        assert_eq!(store.upsert("x", "s", "n", &tags).unwrap(), 1);
        let mut more = tags.clone();
        more.insert("b".to_string());
        assert_eq!(store.upsert("x", "s", "n", &more).unwrap(), 2);
        let all = store.all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1.count, 2);
        assert!(all[0].1.tags.contains("a") && all[0].1.tags.contains("b"));
    }

    #[test]
    fn remove_matching_substring() {
        let mut store = SqliteStore::in_memory().unwrap();
        add_doc(&mut store, DOC).unwrap();
        assert_eq!(store.remove_matching("always").unwrap(), 1);
        assert_eq!(store.all().unwrap().len(), 2);
    }
}
