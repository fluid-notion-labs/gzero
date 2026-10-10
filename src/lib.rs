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
//! Storage is a multiset keyed by (text, source): each source (markdown
//! file) contributes one assertion per atom. Import is a source-scoped
//! replace, so re-importing after edits is a correct sync — deletions
//! propagate, duplicates don't accumulate. Storage is pluggable via
//! [`Storage`]; SQLite is the first backend.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub mod hub;
pub mod snapshot;
pub mod sqlite;
pub use sqlite::SqliteStore;

/// One atom's stored record: an assertion of `text` by `source`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub text: String,
    pub source: String,
    pub scope: String,
    pub node: String,
    pub tags: BTreeSet<String>,
}

/// One atom as parsed from markdown, before storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAtom {
    pub text: String,
    pub scope: String,
    pub node: String,
    pub tags: BTreeSet<String>,
}

/// What one source sync changed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyncStats {
    /// Texts newly asserted by this source.
    pub added: usize,
    /// Texts this source no longer asserts.
    pub removed: usize,
    /// Texts asserted before and after (fields refreshed).
    pub kept: usize,
}

/// Storage backend contract. SQLite now; D1/JSON later behind the same trait.
pub trait Storage {
    /// Replace all atoms contributed by `source` with `atoms`.
    fn sync_source(&mut self, source: &str, atoms: &[ParsedAtom]) -> Result<SyncStats>;
    /// All assertions, ordered by (source, text).
    fn all(&self) -> Result<Vec<Row>>;
    /// Remove assertions whose text contains `needle`, recording tombstones
    /// so removals survive export to other machines; returns how many texts.
    fn remove_matching(&mut self, needle: &str) -> Result<usize>;
    /// All tombstones as full atoms (exact identity is needed to match
    /// remote replicas), sorted by text.
    fn tombstones(&self) -> Result<Vec<snapshot::Atom>>;
    /// Record tombstones (idempotent); returns how many were new.
    fn tombstone(&mut self, atoms: &[snapshot::Atom]) -> Result<usize>;
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

/// Import one parsed markdown document into the store as `source`.
pub fn add_doc(store: &mut dyn Storage, source: &str, input: &str) -> Result<SyncStats> {
    store.sync_source(source, &parse(input))
}

/// Project identity from the current working directory's git repo:
/// normalized `origin` remote URL (e.g. `fluid-notion-labs/context`).
/// Stable across machines and checkout paths. Falls back to the
/// working tree's directory basename when there is no remote.
pub fn repo_identity() -> Option<String> {
    let top = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let url = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match url {
        Some(u) => Some(normalize_repo_id(&u)),
        None => {
            let path = String::from_utf8_lossy(&top.stdout);
            std::path::Path::new(path.trim())
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        }
    }
}

/// `git@host:owner/repo.git`, `https://host/owner/repo.git`,
/// `ssh://git@host/owner/repo` → `owner/repo`.
pub fn normalize_repo_id(url: &str) -> String {
    let mut s = url.trim().to_string();
    if let Some(i) = s.find("://") {
        s = s[i + 3..].to_string();
    }
    if let Some(stripped) = s.strip_prefix("git@") {
        s = stripped.replacen(':', "/", 1);
    }
    // Drop the host segment (distinguished by containing a dot).
    if let Some(i) = s.find('/') {
        if s[..i].contains('.') {
            s = s[i + 1..].to_string();
        }
    }
    if let Some(stripped) = s.strip_suffix(".git") {
        s = stripped.to_string();
    }
    s
}

/// Scopes that count as the project tier for a repo identity: the full
/// `owner/repo` and its last segment (legacy scopes were dir names).
fn project_scopes(project: &str) -> Vec<String> {
    let mut scopes = vec![project.to_string()];
    if let Some((_owner, name)) = project.rsplit_once('/') {
        scopes.push(name.to_string());
    }
    scopes
}

/// Resolved context with tiered defaults: untagged atoms of the global
/// and project scopes are always in; referenced tags pull atoms from any
/// scope (the repository). See `research/context/architecture.md`.
pub fn resolve_tiers(
    store: &dyn Storage,
    project: Option<&str>,
    referenced: &[&str],
) -> Result<Vec<(String, Row)>> {
    let mut tiers: HashSet<String> = HashSet::from(["global".to_string()]);
    if let Some(p) = project {
        tiers.extend(project_scopes(p));
    }
    let referenced: HashSet<&str> = referenced.iter().copied().collect();
    let mut items: Vec<(String, Row)> = alive(store)?
        .into_iter()
        .filter(|(_, r)| {
            (tiers.contains(&r.scope) && r.tags.is_empty())
                || r.tags.iter().any(|t| referenced.contains(t.as_str()))
        })
        .collect();
    items.sort_by(|a, b| (&a.1.scope, &a.1.node, &a.0).cmp(&(&b.1.scope, &b.1.node, &b.0)));
    Ok(items)
}

/// Find alive atoms by case-insensitive text match — how an agent
/// discovers which hashtags exist when the user names a technology.
pub fn search(store: &dyn Storage, needle: &str) -> Result<Vec<(String, Row)>> {
    let needle = needle.to_lowercase();
    let mut items: Vec<(String, Row)> = alive(store)?
        .into_iter()
        .filter(|(text, _)| text.to_lowercase().contains(&needle))
        .collect();
    items.sort_by(|a, b| (&a.1.scope, &a.1.node, &a.0).cmp(&(&b.1.scope, &b.1.node, &b.0)));
    Ok(items)
}

/// Distinct alive atoms, deduplicated by text: duplicate assertions merge
/// (tags union; scope/node from the first source in storage order).
/// Tombstoned texts are excluded.
pub fn alive(store: &dyn Storage) -> Result<Vec<(String, Row)>> {
    let tombstones: HashSet<String> = store.tombstones()?.into_iter().map(|a| a.text).collect();
    let mut merged: BTreeMap<String, Row> = BTreeMap::new();
    for row in store.all()? {
        if tombstones.contains(&row.text) {
            continue;
        }
        match merged.get_mut(&row.text) {
            Some(kept) => kept.tags.extend(row.tags.iter().cloned()),
            None => {
                merged.insert(row.text.clone(), row);
            }
        }
    }
    Ok(merged.into_iter().collect())
}

/// Atoms active by default (untagged) plus any referenced tags, sorted by
/// (scope, node, text). Each fact once by construction.
pub fn resolve(store: &dyn Storage, referenced: &BTreeSet<String>) -> Result<Vec<(String, Row)>> {
    let mut items: Vec<(String, Row)> = alive(store)?
        .into_iter()
        .filter(|(_, r)| r.tags.is_empty() || referenced.iter().any(|t| r.tags.contains(t)))
        .collect();
    items.sort_by(|a, b| {
        (&a.1.scope, &a.1.node, &a.0).cmp(&(&b.1.scope, &b.1.node, &b.0))
    });
    Ok(items)
}

/// Build this machine's snapshot: alive atoms plus tombstones. This is the
/// published, mergeable state (see `snapshot` module and `research/context/sync.md`).
pub fn export_snapshot(store: &dyn Storage) -> Result<snapshot::Snapshot> {
    let atoms = alive(store)?
        .into_iter()
        .map(|(text, r)| snapshot::Atom {
            text,
            scope: r.scope,
            node: r.node,
            tags: r.tags,
        })
        .collect();
    let tombstones = store.tombstones()?;
    Ok(snapshot::Snapshot {
        version: snapshot::SNAPSHOT_VERSION,
        atoms,
        tombstones,
    })
}

/// Merge a snapshot into the store: its atoms become assertions sourced as
/// `source` (the snapshot file), its tombstones are recorded locally.
pub fn absorb_snapshot(
    store: &mut dyn Storage,
    source: &str,
    snap: &snapshot::Snapshot,
) -> Result<SyncStats> {
    let atoms: Vec<ParsedAtom> = snap
        .atoms
        .iter()
        .map(|a| ParsedAtom {
            text: a.text.clone(),
            scope: a.scope.clone(),
            node: a.node.clone(),
            tags: a.tags.clone(),
        })
        .collect();
    let stats = store.sync_source(source, &atoms)?;
    store.tombstone(&snap.tombstones)?;
    Ok(stats)
}

/// Tag vocabulary with the number of distinct atoms carrying each tag.
pub fn tag_counts(store: &dyn Storage) -> Result<Vec<(String, usize)>> {
    let mut counts: BTreeMap<String, usize> = Default::default();
    for (_, r) in alive(store)? {
        for t in &r.tags {
            *counts.entry(t.clone()).or_default() += 1;
        }
    }
    Ok(counts.into_iter().collect())
}

/// Per-source assertion counts.
pub fn source_counts(store: &dyn Storage) -> Result<Vec<(String, usize)>> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in store.all()? {
        *counts.entry(row.source).or_default() += 1;
    }
    let mut out: Vec<_> = counts.into_iter().collect();
    out.sort();
    Ok(out)
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

    fn mem() -> SqliteStore {
        SqliteStore::in_memory().unwrap()
    }

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
    fn wrapped_bullet_lines_rejoin() {
        let atoms = parse("## a\n- first line\n  second line\n- next\n");
        assert_eq!(atoms.len(), 2);
        assert_eq!(atoms[0].text, "first line second line");
    }

    #[test]
    fn default_excludes_tagged_nodes() {
        let mut store = mem();
        add_doc(&mut store, "s", DOC).unwrap();
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
    fn sync_replaces_source_assertions() {
        let mut store = mem();
        let stats = add_doc(&mut store, "s", DOC).unwrap();
        assert_eq!(stats, SyncStats { added: 3, removed: 0, kept: 0 });

        // re-import identical: idempotent
        let stats = add_doc(&mut store, "s", DOC).unwrap();
        assert_eq!(stats, SyncStats { added: 0, removed: 0, kept: 3 });
        assert_eq!(store.all().unwrap().len(), 3);

        // edited file: deletion propagates
        let edited = "## core\n- always on\n";
        let stats = add_doc(&mut store, "s", edited).unwrap();
        assert_eq!(stats, SyncStats { added: 0, removed: 2, kept: 1 });
        assert_eq!(store.all().unwrap().len(), 1);
    }

    #[test]
    fn duplicate_assertions_merge() {
        let mut store = mem();
        add_doc(&mut store, "a.md", "## n\n- shared\n- only a #taga\n").unwrap();
        add_doc(&mut store, "b.md", "## n\n- shared\n- only b #tagb\n").unwrap();
        // 4 rows, 3 distinct texts
        assert_eq!(store.all().unwrap().len(), 4);
        let alive = alive(&store).unwrap();
        assert_eq!(alive.len(), 3);
        let shared = alive.iter().find(|(t, _)| t == "shared").unwrap();
        assert!(shared.1.tags.is_empty());
        // tags union across sources; scope/node from first source
        let only = alive.iter().find(|(t, _)| t == "only a #taga").unwrap();
        assert!(only.1.tags.contains("taga"));
    }

    #[test]
    fn remove_matching_substring() {
        let mut store = mem();
        add_doc(&mut store, "s", DOC).unwrap();
        assert_eq!(store.remove_matching("always").unwrap(), 1);
        assert_eq!(alive(&store).unwrap().len(), 2);
    }

    #[test]
    fn normalize_repo_id_handles_all_remote_forms() {
        assert_eq!(
            normalize_repo_id("git@github.com:fluid-notion-labs/context.git"),
            "fluid-notion-labs/context"
        );
        assert_eq!(
            normalize_repo_id("https://github.com/fluid-notion-labs/context.git"),
            "fluid-notion-labs/context"
        );
        assert_eq!(
            normalize_repo_id("ssh://git@git.example.com/team/repo"),
            "team/repo"
        );
        assert_eq!(normalize_repo_id("owner/repo"), "owner/repo");
    }

    #[test]
    fn resolve_tiers_defaults_and_pulls() {
        let mut store = mem();
        // DOC: scope "Context — test"? No — H1 is "Context — test" so
        // scope is "Context — test"; add explicit tiered atoms instead.
        add_doc(
            &mut store,
            "g.md",
            "# global\n\n## always\n- global rule\n- tagged global #rust\n",
        )
        .unwrap();
        add_doc(
            &mut store,
            "p.md",
            "# owner/repo\n\n## local\n- project rule\n",
        )
        .unwrap();
        add_doc(
            &mut store,
            "repo-pack.md",
            "# packs\n\n## build #rust\n- pull me by tag\n",
        )
        .unwrap();

        // default: global + project untagged only
        let items = resolve_tiers(&store, Some("owner/repo"), &[]).unwrap();
        let texts: Vec<&str> = items.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(texts, ["global rule", "project rule"]);

        // legacy dir-name scope still matches the project tier
        let items = resolve_tiers(&store, Some("owner/repo"), &["rust"]).unwrap();
        let texts: Vec<&str> = items.iter().map(|(t, _)| t.as_str()).collect();
        assert!(texts.contains(&"pull me by tag"));
        assert!(texts.contains(&"global rule"));
        // hashtag pull works from any scope, global included
        assert!(texts.contains(&"tagged global #rust"));
        // and it only adds — tier defaults remain
        assert!(texts.contains(&"project rule"));
    }

    #[test]
    fn search_finds_by_text_case_insensitive() {
        let mut store = mem();
        add_doc(&mut store, "s", "# packs\n\n## build #rust\n- Cargo before answers\n").unwrap();
        let items = search(&store, "cargo").unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].1.tags.contains("rust"));
        assert!(search(&store, "nothing-matches").unwrap().is_empty());
    }

    #[test]
    fn export_absorb_roundtrip_between_machines() {
        // machine A: two atoms, one removed (tombstone)
        let mut a = mem();
        add_doc(&mut a, "a.md", "## n\n- shared\n- only a\n- doomed\n").unwrap();
        a.remove_matching("doomed").unwrap();
        let snap = export_snapshot(&a).unwrap();
        assert_eq!(snap.atoms.len(), 2);
        assert_eq!(snap.tombstones.len(), 1);
        assert_eq!(snap.tombstones[0].text, "doomed");

        // machine B: has its own atom plus an older copy of "doomed"
        let mut b = mem();
        add_doc(&mut b, "b.md", "## n\n- only b\n- doomed\n").unwrap();

        // B absorbs A's snapshot
        absorb_snapshot(&mut b, "machine-a.json", &snap).unwrap();
        let texts: Vec<String> = alive(&b).unwrap().into_iter().map(|(t, _)| t).collect();
        assert!(texts.contains(&"only a".to_string()));
        assert!(texts.contains(&"only b".to_string()));
        assert!(texts.contains(&"shared".to_string()));
        assert!(!texts.contains(&"doomed".to_string()), "tombstone hides doomed");

        // absorbing again is idempotent
        let before = b.all().unwrap().len();
        absorb_snapshot(&mut b, "machine-a.json", &snap).unwrap();
        assert_eq!(b.all().unwrap().len(), before);

        // B's export carries the tombstone forward
        let b_snap = export_snapshot(&b).unwrap();
        assert_eq!(b_snap.tombstones.len(), 1);
    }
}
