# iroh 1.0 as a pluggable backend — assessment

*2026-10-19. Question: is iroh 1.0 fit as an alternative, pluggable
backend for gzero storage? Short answer: as a local `Storage` backend,
no; as a transport/sync layer, later, yes — with an always-on peer as
the missing piece. Sources at the bottom.*

## What iroh 1.0 actually stabilizes

iroh 1.0 (2026-06-15) is a **transport** release: dial-by-public-key
QUIC, hole-punching with relay fallback, wire stability across
languages and minor versions, official Python/Node/Swift/Kotlin. It
ships no storage. The storage-adjacent pieces live in separate crates
and are **pre-1.0**: `iroh-docs` 0.101, `iroh-blobs` 0.103,
`iroh-gossip` 0.101 — maintained and updated to iroh 1.0 deps, but
still breaking-API per minor release.

## The stack, mapped against gzero

| iroh piece | role | gzero equivalent |
|---|---|---|
| iroh (1.0) | P2P transport, dial by key | hub HTTP transport (`hub.rs`) |
| iroh-docs (0.101) | CRDT KV: entries keyed `(namespace, author, key)`, value = BLAKE3 hash, per-key LWW by wall-clock timestamp, sync via 3d range-based set reconciliation | automerge doc + `apply_changes`/`get_changes` |
| iroh-blobs (0.103) | content-addressed bytes for entry values | not needed — atoms/items are small, in-doc |
| iroh-gossip (0.101) | live "new entry" notifications | hub pull on every write |

## Why it is not fit as a `Storage` backend today

1. **Wrong shape.** `Storage` is a local, synchronous, embedded-store
   contract (`sync_source`, `all`, `tombstones`, …). An iroh-docs
   backend is a distributed sync engine: it drags in an endpoint,
   router, gossip, blobs, redb, and an async runtime (tokio) into a
   codebase that is deliberately sync and on plain `ureq`. That is a
   runtime, not a backend swap.
2. **Different merge semantics.** iroh-docs entries are per-key
   last-writer-wins on **wall-clock timestamps** (with a
   future-shift guard whose hazards are a live issue,
   n0-computer/iroh-docs#120: a writer 10 min ahead is silently
   refused, one at 9:59 can pin a key). gzero's design explicitly
   avoids wall clocks and coordinators (`research/old/datastore-survey.md`,
   max-stamp registers, automerge operational merge). Atoms would
   survive the mapping (key = `source::hash(text)`, author = machine,
   `del` = tombstone propagation), but sections/items registers and
   the convergence tests would need a rewrite to a different lattice.
3. **No store-and-forward.** iroh-docs syncs live peers (gossip +
   reconciliation). Our machines are laptops that are rarely online
   simultaneously; the hub's D1 change log is exactly the offline
   queue. With iroh, an always-on peer (VPS, or the phone acting as
   provider) must exist or writes sit local. That is an architecture
   change, not a pluggable one — the hub isn't replaced, it's
   re-shaped into a peer.
4. **Maturity.** The 1.0 warranty covers only the transport. docs is
   at 0.101 with ~40 open issues and a wedged-sync bug fresh off the
   tracker (#121, Oct 2026). Pre-1.0 crates here have historically
   broken API every release cycle.
5. **Deletion is a prefix hack.** `Doc::del(author, prefix)` inserts
   an *empty entry at the prefix*, clearing matching entries — real
   tombstone propagation, but per-author and per-prefix; no story for
   the comms stream's epoch rolls / log truncation (`truncate_before`
   has no iroh-docs equivalent; a synced doc grows forever).

## Where iroh *is* the right tool (later tracks)

- **Mobile client (flutter-client track).** iroh 1.0's Swift/Kotlin
  support means the phone can be a real iroh peer — dial the tower
  directly instead of speaking Worker auth/HTTP. The strongest
  argument for adopting iroh anywhere.
- **Transport under the same engine.** The tested
  `apply_changes`/`get_changes` primitives mean a "fast path" peer
  transport (iroh-blobs carrying change bundles between machines that
  *are* both online, hub as slow/offline path) is a plausible Track D
  add-on without touching merge semantics.
- **Comms stream.** High-churn ephemeral chat over LWW entries is
  conceptually clean — but the epoch-roll/truncation requirement has
  no equivalent, so only if growth is accepted.

## Live fan-out with machines that may or may not be on

Split the requirement: **live** (sub-second propagation to whoever is
up), **fan-out** (one write reaches all peers), **constant** (no lost
updates, ever, regardless of overlap). iroh scores differently on each.

- **Live + fan-out: strong fit.** `iroh-gossip` (HyParView membership +
  PlumTree epidemic broadcast trees) broadcasts to the swarm with
  tree-shaped fan-out; `iroh-docs` layers state on top and pushes live
  events (`LiveEvent::InsertRemote`) to subscribers. Direct connections
  (~95% of traffic, hole-punched, relay fallback), discovery by public
  key via DNS/pkarr — no IPs, handles roaming laptops behind NAT. 0-RTT
  makes wake-from-sleep reconnects cheap. For a fleet of 2–5 machines
  the topology is trivial.
- **Constant: not solved by the swarm itself.** Gossip broadcast only
  reaches peers connected *at send time* — it is an epidemic tree, not
  a durable log; a machine that was asleep misses the broadcast and
gossip will not replay it. Catch-up exists, but one layer down:
  `iroh-docs` reconciles full state on connect. That only works if
  *some peer that was online during the gap still holds the data*.
  With all machines intermittent and no overlap, an update can exist
  on exactly one machine that then goes dark.
- **The anchor.** "Constant" therefore requires one always-on
  participant: a tiny VPS, or the tower (Al Grater) acting as the seed
  node every peer dials. Then the shape is: live broadcast among
  online peers via gossip, state reconciliation from the anchor on
  connect, anchor holds everything. This is the standard iroh-docs
  deployment (see the tauri-todos example's seed pattern). Note it is
  still a server — self-hosted instead of Cloudflare, but not
  serverless. The hybrid alternative (Cloudflare hub stays the durable
  log, iroh adds the live layer in front of it) keeps today's
  investment and adds real-time push; cost is two transports.
- **The process.** Constant live sync cannot live inside per-session
  MCP server processes — it needs a resident daemon per machine that
  owns the endpoint and the docs state. `iroh-docs` ships an RPC mode
  (irpc) built for exactly that split. This lands squarely on the
  deferred **resident track**; live sync and a resident process should
  be decided together, not separately.

Net: for the stated goal, iroh is a good fit **contingent on an
anchor** — either a self-hosted seed node or a hybrid with the hub.
Pure peer-to-peer with no anchor does not meet "constant" given our
uptime pattern.

## The current automerge layer, measured against the same goal

Splitting the requirement again — live, fan-out, constant — the
existing stack scores:

- **Constant: already solved.** Automerge CRDT + change log +
  `SyncCursor` + hub as durable anchor means offline writes queue in
  the doc, the hub holds every change, and machines converge however
  badly their uptime overlaps. Convergence is tested
  (`scripts/mcp-convergence-test.sh`). No new engine is needed for
  correctness.
- **Live: missing, and the gap is not the engine.** Today sync is
  pull-on-write: every MCP call pushes then pulls, so a machine sees
  remote changes only on its *next write*. An idle machine never
  syncs. Fan-out is hub-mediated but latency is unbounded.
- **The hub spec already planned the fix.** `research/hub-v0.md`
  lists SSE `/stream/{name}/events` as a v0.1 add: notify pullers that a
  push happened, so they pull immediately instead of on next write.
  But an SSE notification is only useful to a client that is
  *listening* — and no gzero process listens between sessions. The
  MCP server opens the doc per call and exits with the session.
- **Therefore: the daemon is the unlock, not the transport.** Every
  path to "constant live" — SSE from the hub, iroh, anything —
  requires a resident per-machine process. With `gzero-syncd`
  (resident, holds the hub SSE stream → pull → apply → save) plus the
  SSE endpoint, the existing automerge layer reaches live fan-out:
  write → hub → SSE → peers pull → applied in ~a second.
- **Design point the daemon forces:** single-writer. Sessions today
  write the doc file directly; a daemon writing the same file
  concurrently risks file-level lost updates. Either the daemon
  becomes the doc's sole writer and sessions go through it (local
  IPC), or a file lock arbitrates. Decide this before writing the
  daemon — it determines whether the daemon is a silent refresher or
  the storage front door.
- **Sequencing (cheapest path to the goal):** 1) SSE endpoint in
  gzero-hub; 2) `gzero-syncd` (SSE → pull → apply, single-writer
  decision first); 3) optionally, later, iroh as a direct P2P
  transport under the same engine (tower as seed for the phone). iroh
  is not required for constant live fan-out; the daemon is.

## Verdict

- **As a pluggable `Storage` backend: not fit.** Keep SQLite +
  automerge behind the trait; if a third local backend is ever wanted,
  it should stay an embedded store (e.g. redb directly), not iroh.
- **As a transport/sync backend: promising, not now.** iroh 1.0 itself
  is production-grade, but the doc/blob stack it would sit on is not,
  and the always-on-peer requirement changes the hub architecture.
  Revisit when the mobile client track starts — that's where iroh
  earns its keep, with the hub retained as the offline path.

## Sources

- iroh 1.0 announcement (2026-06-15): https://www.iroh.computer/blog/v1
- v1.0.0 changelog: https://github.com/n0-computer/iroh/releases/tag/v1.0.0
- Documents protocol docs (stack, entries, del, redb store):
  https://docs.iroh.computer/protocols/documents
- `Doc::del` API: https://docs.rs/iroh-docs/latest/iroh_docs/api/struct.Doc.html
- iroh-docs changelog / versions: https://github.com/n0-computer/iroh-docs/blob/main/CHANGELOG.md
- Open issues incl. #120 (timestamp guard), #121 (wedged sync):
  https://github.com/n0-computer/iroh-docs/issues
