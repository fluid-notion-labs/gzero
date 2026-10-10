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
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            // both bullet markers: authored files use '-'; wild files
            // (CLAUDE.md, GEMINI.md, …) frequently use '*'
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

/// Agent-instruction files contextual harvests from a repo: written for
/// any agent (pi, Claude Code, Cursor, Copilot, …), imported into the one
/// bag so every session gets them.
pub const HARVEST_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
    ".github/copilot-instructions.md",
];

/// One harvested file's outcome.
pub struct HarvestResult {
    pub path: std::path::PathBuf,
    /// `None` = skipped: the file parsed to zero bullets (pointer stubs
    /// and prose-only files — a zero-atom sync would wipe the source).
    pub stats: Option<SyncStats>,
    /// Parsed atoms (empty when skipped) — for hub Put events.
    pub atoms: Vec<ParsedAtom>,
}

/// Project identity from an arbitrary directory's git repo:
/// normalized `origin` remote URL (e.g. `fluid-notion-labs/context`).
/// Stable across machines and checkout paths. Falls back to the
/// repo's directory basename when there is no remote, `None` when the
/// directory is not a git repo at all.
pub fn repo_identity_in(dir: &std::path::Path) -> Option<String> {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
    };
    let top = git(&["rev-parse", "--show-toplevel"])?;
    match git(&["remote", "get-url", "origin"]) {
        Some(url) => {
            let u = String::from_utf8_lossy(&url.stdout).trim().to_string();
            Some(normalize_repo_id(&u))
        }
        None => {
            let path = String::from_utf8_lossy(&top.stdout);
            std::path::Path::new(path.trim())
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        }
    }
}

/// Project identity of the current working directory.
pub fn repo_identity() -> Option<String> {
    repo_identity_in(std::path::Path::new("."))
}

/// Import one instruction file into the store: scope forced to `scope`
/// (project tier), source = the file's canonical path.
pub fn harvest_file(
    store: &mut dyn Storage,
    path: &std::path::Path,
    scope: &str,
) -> Result<HarvestResult> {
    let text = std::fs::read_to_string(path)?;
    let mut atoms = parse(&text);
    if atoms.is_empty() {
        return Ok(HarvestResult {
            path: path.to_path_buf(),
            stats: None,
            atoms,
        });
    }
    for a in &mut atoms {
        a.scope = scope.to_string();
    }
    let source = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let stats = store.sync_source(&source, &atoms)?;
    Ok(HarvestResult {
        path: path.to_path_buf(),
        stats: Some(stats),
        atoms,
    })
}

/// Harvest every candidate instruction file found at `dir`'s repo root
/// (and at `dir` itself, when deeper), all scoped to the repo identity.
/// Scope falls back to the directory basename outside git.
pub fn harvest_dir(store: &mut dyn Storage, dir: &std::path::Path) -> Result<Vec<HarvestResult>> {
    let root = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if p.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(p))
            }
        })
        .unwrap_or_else(|| dir.to_path_buf());
    let scope = repo_identity_in(&root)
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "harvest".to_string());

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for base in [&root, dir] {
        for name in HARVEST_FILES {
            let p = base.join(name);
            if p.is_file() && !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for path in candidates {
        if let Ok(r) = harvest_file(store, &path, &scope) {
            out.push(r);
        }
    }
    Ok(out)
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

/// Alive atom texts closest to `needle` by word overlap — how a failed
/// removal teaches the caller what to retry with. Score is
/// |words(needle) ∩ words(entry)| / |words(needle)|; only scores ≥ 0.3,/// best first, at most `limit`.
pub fn closest_matches(store: &dyn Storage, needle: &str, limit: usize) -> Result<Vec<String>> {
    let words = |t: &str| -> HashSet<String> {
        t.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_lowercase())
            .collect()
    };
    let needle_words = words(needle);
    if needle_words.is_empty() {
        return Ok(Vec::new());
    }
    let mut scored: Vec<(usize, String)> = alive(store)?
        .into_iter()
        .map(|(text, _)| {
            let overlap = words(&text).intersection(&needle_words).count();
            (overlap, text)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(scored
        .into_iter()
        .take_while(|(overlap, _)| *overlap * 10 >= needle_words.len() * 3)
        .take(limit)
        .map(|(_, text)| text)
        .collect())
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

/// Inline hashtags in atom text: whitespace-delimited tokens starting
/// with `#` followed by an alphanumeric. Markdown hashes (`##`, `###`)
/// and anchors (`#!`) are not tags; trailing punctuation (`#rust,`)
/// is trimmed.
fn hashtags(text: &str) -> BTreeSet<String> {
    text.split_whitespace()
        .filter_map(|t| t.strip_prefix('#'))
        .filter(|t| t.chars().next().is_some_and(|c| c.is_alphanumeric()))
        .map(|t| {
            let trimmed: String = t
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-')
                .collect();
            trimmed.to_ascii_lowercase()
        })
        .filter(|t| !t.is_empty())
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
    fn hashtags_reject_markdown_hashes_and_trim_punctuation() {
        let tags = hashtags("### Hyrum's Law #api #design #rust, keep #!!");
        let expect: BTreeSet<String> =
            ["api", "design", "rust"].iter().map(|s| s.to_string()).collect();
        assert_eq!(tags, expect);
    }

    #[test]
    fn parse_accepts_star_bullets() {
        let atoms = parse("# Claude\n\n## build\n* star bullet\n  continuation\n- dash bullet\n");
        assert_eq!(atoms.len(), 2);
        assert_eq!(atoms[0].text, "star bullet continuation");
        assert_eq!(atoms[1].text, "dash bullet");
    }

    #[test]
    fn harvest_forces_scope_and_syncs() {
        let dir = std::env::temp_dir().join("cx-harvest-a");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("CLAUDE.md"),
            "# Claude instructions\n\n## build\n- run the tests before done\n",
        )
        .unwrap();
        let mut store = mem();
        let results = harvest_dir(&mut store, &dir).unwrap();
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert!(r.stats.as_ref().unwrap().added == 1);
        // scope falls back to the dir basename (no git repo) and is forced
        // onto the atom regardless of the file's own H1
        let atom = &r.atoms[0];
        assert_eq!(atom.scope, "cx-harvest-a");
        assert_eq!(atom.text, "run the tests before done");
    }

    #[test]
    fn harvest_skips_zero_bullet_files_and_protects_existing_rows() {
        let dir = std::env::temp_dir().join("cx-harvest-b");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // pointer stub: prose only, no bullets
        std::fs::write(dir.join("AGENTS.md"), "# Context\n\nThis file is a pointer.\n").unwrap();
        let mut store = mem();
        // the stub's source already has rows (the pre-P4 import)
        add_doc(
            &mut store,
            dir.join("AGENTS.md").canonicalize().unwrap().to_str().unwrap(),
            "# Context — global\n\n## n\n- real atom\n",
        )
        .unwrap();
        let results = harvest_dir(&mut store, &dir).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].stats.is_none(), "stub must be skipped");
        // and the skip must not wipe the source's rows
        assert_eq!(alive(&store).unwrap().len(), 1);
    }

    #[test]
    fn closest_matches_scores_word_overlap() {
        let mut store = mem();
        add_doc(
            &mut store,
            "s",
            "## n\n- user prefers concise responses\n- use cargo test before pushing\n- unrelated\n",
        )
        .unwrap();
        // paraphrased needle still lands on the closest entry
        let closest = closest_matches(&store, "prefers concise replies", 3).unwrap();
        assert_eq!(closest[0], "user prefers concise responses");
        assert!(!closest.contains(&"unrelated".to_string()));
        // total gibberish scores below the 0.3 floor
        assert!(closest_matches(&store, "xyzzy plugh", 3).unwrap().is_empty());
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
