//! Teams (item b66c): named groups of collaborators — agents now, humans
//! soon. A team is durable, synced configuration, so it lives in the atom
//! doc as scope `team/<name>` (source `team:<name>`), not in the ephemeral
//! comms store. The atom format is plain markdown:
//!
//! ```text
//! # team/example
//!
//! ## purpose
//! - The example team: a living template for how teams are modeled.
//!
//! ## member/nick
//! - kind: human
//! - role: owner
//! - note: first real member.
//! ```
//!
//! `## purpose` carries the team's one-line purpose (first bullet wins);
//! each `## member/<id>` node is one member with `kind: human|agent`,
//! `role: <role>` and any number of free-form note atoms. Reading is
//! best-effort per field: a member missing `kind` still lists.
//!
//! Seeding: `seed:team-example` (see [`crate::SEEDS`]) plants the example
//! team in every fresh store; it grows organically from there. Seed
//! tombstones win, so a removed member stays removed. Editing a team is
//! the same doc:/add flow as any source-scoped document — no dedicated
//! write tools yet (v1 is read-only).

use std::collections::BTreeMap;

use crate::{scope_atoms, Result, Storage};

/// Scopes starting with this prefix are teams.
pub const TEAM_SCOPE_PREFIX: &str = "team/";

/// Sources starting with this prefix own team documents.
pub const TEAM_SOURCE_PREFIX: &str = "team:";

/// Node within a team scope that holds the purpose line.
pub const PURPOSE_NODE: &str = "purpose";

/// Node prefix for member nodes (`member/<id>`).
pub const MEMBER_NODE_PREFIX: &str = "member/";

/// One member of a team.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// Member id: the node after `member/`, e.g. `nick`.
    pub id: String,
    /// `human` or `agent`; empty when unlabelled.
    pub kind: String,
    /// Free-text role, e.g. `owner` or `builder`.
    pub role: String,
    /// Remaining descriptive atoms (contact info, notes).
    pub notes: Vec<String>,
}

/// A team: scope `team/<name>` in the atom store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Team {
    /// Scope after the `team/` prefix, e.g. `example`.
    pub name: String,
    /// One-line purpose; empty when the team has none yet.
    pub purpose: String,
    /// Members sorted by id.
    pub members: Vec<Member>,
}

/// Read every team from the store, sorted by name. Teams missing a
/// purpose or members still list — the fixture grows organically.
pub fn list_teams(store: &dyn Storage) -> Result<Vec<Team>> {
    let rows = scope_atoms(store, TEAM_SCOPE_PREFIX)?;

    // Group texts by scope, then node (scope_atoms already sorts).
    let mut scopes: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
    for (text, r) in rows {
        scopes
            .entry(r.scope.clone())
            .or_default()
            .entry(r.node.clone())
            .or_default()
            .push(text);
    }

    let mut teams = Vec::new();
    for (scope, nodes) in scopes {
        let name = scope
            .strip_prefix(TEAM_SCOPE_PREFIX)
            .unwrap_or(&scope)
            .to_string();
        let purpose = nodes
            .get(PURPOSE_NODE)
            .and_then(|texts| texts.first())
            .cloned()
            .unwrap_or_default();

        let mut members = Vec::new();
        for (node, texts) in nodes {
            let Some(id) = node.strip_prefix(MEMBER_NODE_PREFIX) else {
                continue;
            };
            let mut kind = String::new();
            let mut role = String::new();
            let mut notes = Vec::new();
            for text in texts {
                if let Some(v) = text.strip_prefix("kind: ") {
                    kind = v.to_string();
                } else if let Some(v) = text.strip_prefix("role: ") {
                    role = v.to_string();
                } else {
                    notes.push(text);
                }
            }
            members.push(Member {
                id: id.to_string(),
                kind,
                role,
                notes,
            });
        }

        teams.push(Team {
            name,
            purpose,
            members,
        });
    }
    Ok(teams)
}

/// Render a team back to the markdown form that parses into it — the
/// roundtrip used by tests, the fixture and a future write path.
pub fn to_markdown(team: &Team) -> String {
    let mut out = format!("# team/{}\n\n## {}\n", team.name, PURPOSE_NODE);
    if !team.purpose.is_empty() {
        out.push_str(&format!("- {}\n", team.purpose));
    }
    for m in &team.members {
        out.push_str(&format!("\n## {}{}\n", MEMBER_NODE_PREFIX, m.id));
        if !m.kind.is_empty() {
            out.push_str(&format!("- kind: {}\n", m.kind));
        }
        if !m.role.is_empty() {
            out.push_str(&format!("- role: {}\n", m.role));
        }
        for n in &m.notes {
            out.push_str(&format!("- {}\n", n));
        }
    }
    out
}

/// Human/agent-facing listing: one block per team, members with kind
/// and role. Shared by the CLI (`gzero teams`) and the `teams` MCP tool.
pub fn render(teams: &[Team]) -> String {
    if teams.is_empty() {
        return String::from("(no teams — the example team seeds on startup)");
    }
    let mut out = String::new();
    for t in teams {
        out.push_str(&format!(
            "{} — {}\n",
            t.name,
            if t.purpose.is_empty() { "(no purpose)" } else { &t.purpose }
        ));
        for m in &t.members {
            let kind = if m.kind.is_empty() { "?" } else { &m.kind };
            let role = if m.role.is_empty() { "?" } else { &m.role };
            out.push_str(&format!("  {} ({kind}, {role})", m.id));
            for n in &m.notes {
                out.push_str(&format!(" — {n}"));
            }
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::add_doc;
    use crate::sqlite::SqliteStore;

    fn memory_store() -> SqliteStore {
        SqliteStore::in_memory().unwrap()
    }

    fn example_doc() -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/seeds/team-example.md"))
            .unwrap()
    }

    #[test]
    fn list_teams_reads_scope_nodes_and_members() {
        let mut store = memory_store();
        add_doc(&mut store, "team:example", &example_doc()).unwrap();
        let teams = list_teams(&store).unwrap();
        assert_eq!(teams.len(), 1);
        let t = &teams[0];
        assert_eq!(t.name, "example");
        assert!(!t.purpose.is_empty());
        assert_eq!(t.members.len(), 2);
        assert_eq!(t.members[0].id, "nick");
        assert_eq!(t.members[0].kind, "human");
        assert_eq!(t.members[0].role, "owner");
        assert_eq!(t.members[1].id, "pair-agent");
        assert_eq!(t.members[1].kind, "agent");
    }

    #[test]
    fn to_markdown_roundtrips_through_parse() {
        let team = Team {
            name: "alpha".into(),
            purpose: "Ship the thing.".into(),
            members: vec![Member {
                id: "bob".into(),
                kind: "human".into(),
                role: "reviewer".into(),
                notes: vec!["note: prefers review by Tuesday.".into()],
            }],
        };
        let mut store = memory_store();
        add_doc(&mut store, "team:alpha", &to_markdown(&team)).unwrap();
        assert_eq!(list_teams(&store).unwrap(), vec![team]);
    }

    #[test]
    fn partial_members_and_multiple_teams_list_best_effort() {
        let md = "# team/one\n\n## member/a\n- role: helper\n\n# team/two\n\n## purpose\n- second.\n";
        let mut store = memory_store();
        add_doc(&mut store, "team:partial", md).unwrap();
        let teams = list_teams(&store).unwrap();
        assert_eq!(teams.len(), 2);
        assert_eq!(teams[0].name, "one");
        assert!(teams[0].purpose.is_empty());
        assert_eq!(teams[0].members[0].kind, ""); // unlabelled kind lists
        assert_eq!(teams[1].purpose, "second.");
        assert!(teams[1].members.is_empty());
    }

    #[test]
    fn render_is_empty_store_friendly() {
        let store = memory_store();
        assert!(render(&list_teams(&store).unwrap()).starts_with("(no teams"));
        let md = "# team/x\n\n## member/h\n- kind: human\n- role: dev\n- note: hi\n";
        let mut store = memory_store();
        add_doc(&mut store, "team:x", md).unwrap();
        let out = render(&list_teams(&store).unwrap());
        assert!(out.contains("x — (no purpose)"));
        assert!(out.contains("h (human, dev) — note: hi"));
    }
}
