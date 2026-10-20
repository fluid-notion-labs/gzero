# Architecture — actors and entities

*2026-10-20. Who and what exists in the gzero system, and how they
connect. Every durable state flows through automerge docs replicated
via the hub's Stream DOs; nothing talks to hub storage directly. The
comms stream is the connective tissue between machines: presence,
messages, broadcasts, and teams.*

```mermaid
flowchart TB
    user["👤 Nick<br/>(human)"]

    subgraph cloud["☁️ Cloudflare"]
        hub["gzero-hub Worker<br/>bearer auth · /stream/{name}/...<br/>/health · legacy /bag compat"]
        doCtx["Stream DO<br/>'context'<br/>change log · SSE push<br/>snapshots"]
        doComms["Stream DO<br/>'comms'<br/>change log · SSE push"]
        dostore["DO Storage<br/>(change logs)"]
        legacy["LegacyMerge<br/>(old bag:path)"]
    end

    subgraph macpro["🖥️ nick-MacPro5-1 — 'Al Grater' (main)"]
        pi1["pi coding sessions<br/>(agents)"]
        plugin["pi-gzero plugin<br/>panel: tasks · context · skills<br/>router · history · documentation"]
        mcp1["gzero-mcp<br/>MCP server: context · items<br/>comms · ws · sections"]
        cli1["gzero CLI<br/>add · remove · sync · teams · migrate"]
        syncd1["gzero-syncd<br/>daemon: SSE watch + sync"]
        docCtx1["📄 automerge doc<br/>context stream<br/>atoms · sections · items"]
        docComms1["📄 automerge doc<br/>comms stream<br/>sessions · messages<br/>broadcasts · presence · teams"]
        sess1["session files<br/>~/.pi/agent/sessions/"]
        legacydb["SQLite context.db<br/>(rollback hatch)"]
        observer["viz observer<br/>(planned)"]
    end

    subgraph air["💻 nick-MacBookAir — 'Air Apparent'"]
        pi2["pi coding sessions"]
        mcp2["gzero-mcp"]
        syncd2["gzero-syncd"]
        docCtx2["📄 context doc"]
        docComms2["📄 comms doc"]
    end

    subgraph tablet["📱 Android tablet (SM-T220)"]
        flutter["Flutter client<br/>projects UI · sync state"]
        ffi["gzero-ffi<br/>C ABI over automerge<br/>(JNI)"]
        docT["📄 context doc<br/>(on device)"]
    end

    subgraph gh["🐙 GitHub"]
        repoGzero["fluid-notion-labs/gzero<br/>(monorepo: systems/* + gzero-ffi)"]
        repoHub["fluid-notion-labs/gzero-hub<br/>(archive)"]
    end

    user -->|"drives"| pi1
    user -->|"drives"| pi2
    user -->|"uses"| flutter

    pi1 <-->|"MCP tools"| mcp1
    pi1 --- plugin
    plugin -->|"reads"| sess1
    plugin -->|"panel sections"| mcp1
    pi2 <-->|"MCP tools"| mcp2

    mcp1 <--> docCtx1
    mcp1 <--> docComms1
    cli1 <--> docCtx1
    syncd1 <--> docCtx1
    syncd1 <--> docComms1
    docCtx1 -.->|"rollback hatch"| legacydb

    mcp2 <--> docCtx2
    mcp2 <--> docComms2
    syncd2 <--> docCtx2
    syncd2 <--> docComms2

    flutter <--> ffi
    ffi <--> docT

    syncd1 <-->|"pull/push + SSE"| hub
    syncd2 <-->|"pull/push + SSE"| hub
    flutter <-->|"HTTPS pull/push"| hub
    mcp1 -.->|"startup sync"| hub
    mcp2 -.->|"startup sync"| hub

    hub --> doCtx
    hub --> doComms
    hub --> legacy
    doCtx --> dostore
    doComms --> dostore

    docCtx1 <-->|"replica"| doCtx
    docComms1 <-->|"replica"| doComms
    docCtx2 <-->|"replica"| doCtx
    docComms2 <-->|"replica"| doComms
    docT <-->|"replica"| doCtx
    observer -.->|"SSE + /changes (planned)"| hub

    repoGzero -->|"builds / deploys"| macpro
    repoGzero -->|"wrangler deploy"| hub
    repoHub -.->|"superseded by systems/hub"| repoGzero

    docComms1 <-->|"presence & messages<br/>bridge the machines"| docComms2
```

## Actor classes

- **The human** drives the agents and uses the clients.
- **pi coding sessions** are the agents: they act through the
  gzero-mcp tool surface and are seen in the plugin's panel sections.
- **Daemons and clients** (gzero-mcp, gzero-syncd, the CLI, the
  Flutter app) move state between local automerge docs and the hub.

## States

| Entity | Where | Notes |
|---|---|---|
| context stream doc | local + Stream DO | atoms, sections, work items |
| comms stream doc | local + Stream DO | sessions, messages, broadcasts, presence, teams |
| session files | `~/.pi/agent/sessions/` | local-only; presence rows are the global layer |
| legacy SQLite | rollback hatch | slated for removal once all machines cut over |
| hub change logs | DO Storage | per-stream, since-cursor reads + SSE push |

## Planned, not built

The **viz observer** (dashed): a small Node/TS process holding the
hub token, subscribing to each stream's SSE and serving JSON to a
browser — the first web version of the visualization. Spec:
`explorations/research/gzero-viz/README.md`.
