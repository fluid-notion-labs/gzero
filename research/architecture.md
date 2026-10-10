# Contextual — architecture

*The system: authoring → ledger → snapshots → merge → consumption.
Linked from `research/context/architecture.md` (symlinked there).
Companions: `research/context/lattice.md` (merge math), `sync.md`
(transport), `persistence.md` (durability), `distributed-chaos-plan.md`
(testing). Code: `nursery/contextual`, `nursery/bagflow`.*

## Naming (use it precisely)

| term       | meaning                                              |
|------------|------------------------------------------------------|
| contextual | the system                                           |
| context    | what the agent receives: global ∪ project ∪ pulled-in |
| bag        | the repository of *possible* contexts; pulled via hashtag |
| atom       | one terse assertion: `{text, scope, node, tags}`; identity = text |
| ledger     | per-machine SQLite: rows `(text, source, scope, node, tags)` + tombstones |
| snapshot   | published merge unit: `{version, atoms, tombstones}` JSON |
| lattice    | CRDT merge semantics (see `lattice.md`)              |

## Components

| component     | crate     | role                                            |
|---------------|-----------|-------------------------------------------------|
| `cx`          | contextual| CLI: add/resolve/rm/tags/export/absorb/push/pull |
| `cx-mcp`      | contextual| MCP stdio server: resolve/search/add/remove/tags for agents (pi) |
| `SqliteStore` | contextual| ledger backend behind the `Storage` trait       |
| snapshot JSON | (format)  | the contract — identical shape in both crates   |
| `bagflow`     | bagflow   | lattice engine prototype: DFIR dataflow, persistence, merge |
| `bagflow-serve`| bagflow  | HTTP wrapper over the engine (multi-machine test harness) |

Two pools, one bridge: **contextual** is the product (SQLite ledger, live
data); **bagflow** is the proven engine (in-memory lattice + JSON
snapshot). They share only the snapshot format. Unification is M4.

## Resolution model — three tiers

Context is resolved automatically per session:

- **global tier** — user/author-level context, scope `global`, always in
- **project tier** — scope = **repo identity**, detected from cwd's git
  root: `git remote get-url origin`, normalized (strip scheme/`git@`,
  `.git` suffix, leading host) → e.g. `fluid-notion-labs/context`. Stable
  across machines and checkout paths; falls back to cwd basename when
  no git repo. The local project's standing context.
- **repository tier** — the bag: tagged atoms in any scope;
  *pulled in* on demand via hashtag lookup (`resolve(tags)`), discovered
  via `search` when the model doesn't know the hashtag yet

Default delivery = untagged atoms of global + project scopes. Tags pull
from anywhere — that's the hashtag lookup.

```mermaid
flowchart LR
    G["global tier\nscope = global\nalways included"] --> R
    CWD["cwd"] --> GIT["git root →\nremote origin URL →\nnormalized repo ID\n(fallback: dir name)"] --> P["project tier\nscope = repo ID"]
    P --> R["resolved CONTEXT\ndelivered to agent"]
    B["repository / bag\ntagged atoms\nany scope"] -- "hashtag pull\nresolve(tags)" --> R
    U["user phrase\n\"rust api, svelte app\""] -- "model maps\nto tags" --> B
```

### Repo identity is host-agnostic (pluggable backend)

The key is the **normalized repo URL**, not the hosting backend. Git
remotes now (GitHub, self-hosted, bare repos); later **Cloudflare
Artifacts** — git-compatible versioned storage with repos per project,
user, session, or task, plus Workers Builds auto-deploy. A repo's URL
changes host → context follows the repo, because scope keys on the
identity, not the path.

Planned Artifacts roles (not yet built):

1. **Project host** — repos live on Artifacts; `origin` URL normalizes
   to the same repo-ID scheme. Zero context-code change.
2. **Session repos** — Artifacts' per-session/branch model maps to the
   harness plan (agent sessions as branches off a baseline).
3. **Sync transport** — an Artifacts repo could host `sync/bag-<host>.json`
   as a git-protocol alternative to the hub; the hub (real-time events)
   remains the fast path.

### The pull-in workflow

The target interaction: the user names technologies or domains, and the
system brings all matching skills/contexts in — no manual curation.

```mermaid
sequenceDiagram
    participant U as user
    participant P as pi (model)
    participant C as context MCP
    participant B as repository / bag

    U->>P: "rust api, serving svelte app, flutter app"
    P->>C: search("svelte") / tags
    C->>B: hashtag + text lookup
    C-->>P: matching atoms with their tags
    P->>C: resolve(tags: rust, api, svelte, flutter)
    C-->>P: global + project + pulled contexts
    Note over P: every skill the task needs is now in context
```

Resolution rules:

| rule | behavior |
|------|----------|
| default | untagged atoms, scopes `global` + detected project |
| pull | `resolve(tags)` includes tagged atoms from any scope |
| discover | `search(text)` finds atoms when the hashtag is unknown |
| post | `add` writes to the detected repo identity (project scope) by default |

## Diagrams

### Components and artifacts

```mermaid
flowchart LR
    subgraph A["Authoring — per machine"]
        MD["markdown\n(AGENTS.md, CONTEXT.md)"
        PI["pi session"]
    end
    subgraph L["Ledger — SQLite, per machine"]
        DB[("atoms\n(text, source, scope, node, tags)")]
        T[("tombstones\n(full atoms)")]
    end
    subgraph D["Distributed artifacts"]
        S["snapshot JSON\n{version, atoms, tombstones}"]
        G["sync/ dir in git\nbag-<host>.json"]
    end
    MD -- "cx add\n(per-source sync)" --> DB
    PI -- "mcp__context__add\n(source = mcp)" --> MCP["cx-mcp"] --> DB
    PI -- "mcp__context__resolve" --> MCP
    DB -- "cx rm / mcp__context__remove" --> T
    DB -- "cx export" --> S
    T --> S
    S -- "commit + push" --> G
    G -- "pull" --> S2["other machines'\nsnapshots"]
    S2 -- "cx absorb" --> DB
    S2 -- "absorb" --> T
```

### Information flow — "mention here, appears there"

```mermaid
sequenceDiagram
    participant PA as pi (machine A)
    participant MCPA as cx-mcp (A)
    participant LA as ledger A
    participant G as git sync/
    participant LB as ledger B
    participant PB as pi (machine B)

    PA->>MCPA: add("terse beats verbose")
    MCPA->>LA: sync_source("mcp", ...)
    Note over G: A: cx export bag-a.json → commit → push
    Note over G: B: pull
    LB->>G: cx absorb bag-*.json
    PB->>LB: resolve → sees the atom

    PA->>MCPA: remove("verbose")
    MCPA->>LA: tombstone (full atom)
    Note over G: export/pull/absorb again
    LB->>LB: tombstone wins → gone on B
```

Properties carried by the format (not by the transport): merges are
commutative, associative, idempotent — arrival order and repetition are
irrelevant; a hub later would run the same `absorb`.

### Engines — now and M4

```mermaid
flowchart TB
    subgraph NOW["Now — two pools, one bridge"]
        direction LR
        C1["contextual\nSQLite ledger\n(product, live data)"] <..>|"snapshot JSON"| B1["bagflow\nlattice replicas\n(proven engine)"]
    end
    subgraph M4["M4 — one engine"]
        direction LR
        CX2["cx + cx-mcp"] --> ST["Storage trait"] --> EN["lattice engine\n(bagflow core)"] --> PS[("snapshot /\nor SQLite")]
    end
```

M4 decision (2025, revisitable): the unified engine crate will be named
**`contexture`**. SQLite stays for now — `Storage` is the plug point —
with a noted no-SQL endgame: one JSON snapshot per machine as the store,
`flock` + read-merge-write + atomic rename for same-machine races (the
lattice merge already handles cross-machine), so the lattice state is
the file is the wire format. Until then:

1. **Engine absorbs ledger**: contextual keeps its CLI/MCP and markdown
   sync, but the bag behind `Storage` becomes the bagflow lattice; SQLite
   becomes a projection. Strongest consistency story.
2. **Ledger stays, merge delegates**: keep SQLite as source of truth,
   route `absorb` through bagflow's `merge` so per-source replace becomes
   true lattice merge. Cheapest change.

## Invariants

- **Per-source sync**: a source (file, snapshot, `mcp`) owns its rows
  wholesale; re-importing replaces them. Idempotent.
- **Tombstones are full atoms** — exact identity needed to dominate a
  remote replica's add. Removal is addition; permanent.
- **Snapshot = durable artifact = merge unit** — one type serves
  persistence and distribution.
- **Resolve is a projection** — never mutates; untagged atoms are the
  default set, tags widen it.

## Failure modes

| failure            | behavior                                   |
|--------------------|--------------------------------------------|
| crash mid-write    | atomic tmp+rename; last good snapshot survives |
| duplicate absorb   | no-op (idempotence)                        |
| stale snapshot     | harmless (monotonic merge)                 |
| machine offline    | works locally; converges on return         |
| split brain        | none — replicas converge to the same union |

## Status

- ✅ ledger, CLI, MCP server (pi-connected), export/absorb, tombstones
- ✅ hub: Cloudflare Worker in server mode (events in, snapshot out,
  `cx push` / `cx pull` / auto-post in `cx-mcp`) — multi-machine works
- ✅ engine: lattice, persistence, HTTP replication demo
- ✅ MCP tools renamed (`mcp__context__resolve/search/add/remove/tags`),
  tiered resolve with **repo-URL project identity** (git origin,
  normalized; dir-name fallback + legacy scope match), `search` tool;
  verified live: tiers resolve per cwd, `add` lands in
  `fluid-notion-labs/explorations`
- ✅ curation policy from hermes in the tool descriptions (`add` batch
  `operations`, self-healing `remove`; `curation.md`) — 5s cap on hub calls
- ✅ pi plugin P1+P2 (`pi-plugin.md`): per-turn `<context>` injection,
  install offer, `/context` commands, stale-binary check
- ✅ packs dissolved: atoms seeded, `packs/` + `recommend` deleted,
  project-relevance atoms in place, junk skills corpus removed via the
  new `cx rm-source` (`plan.md` M4); hub push of the new events pending
- ✅ pi plugin installed and verified live (injection + MCP tools in a
  real session)
- ✅ P4 migration: global `AGENTS.md` + explorations `CONTEXT.md` are
  pointer stubs — the bag is the sole authority, injected per session
- ⬜ Cloudflare Artifacts backend (planned — see "host-agnostic" above)
- ⬜ hub: live push (DO websockets) so pulls aren't per-session
- ⬜ chaos harness (compose + syncd, see `distributed-chaos-plan.md`)
- ⬜ M4 unification (name reserved: `contexture`)
