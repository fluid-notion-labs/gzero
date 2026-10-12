# Distributed workflow test plan — multi-client bag sync under chaos

*Status: plan (not yet built). Tests the distributed store end-to-end:
N simulated machines, network faults and slowness, converge to the
assumed end state. One directory: `nursery/contextual/tests/` holds the
harness; this document holds the design. Related: `research/context/sync.md`.*

## Goal

Prove the distributed flow — mention on one machine, all machines see it,
deletes propagate, chaos in the middle — by simulation, not by hand-testing
across two laptops.

## Model of a machine

Each simulated machine = one container running the real components:

- `cx` binary (SQLite bag at `/data/context.db`) — authoring + local reads
- `lattic` engine as a small HTTP service (new: `lattic-serve`, ~200
  lines) — holds the in-memory lattice backed by `/data/bag.json`
- a snapshot exchange directory mounted per-machine: `/sync/` — in the
  docker network this is a shared volume emulating the git repo

The exchange directory plays the role of the pushed repo: machine A drops
`bag-a.json`, machine B drops `bag-b.json`. A sync worker in each container
(`syncd`, shell script or tiny Rust loop) does:

```
while true:
  copy foreign snapshots that are new  (emulates pull)
  cx absorb ...  /  HTTP merge into lattic service
  write own snapshot if changed   (emulates push)
  sleep $SYNC_INTERVAL ± jitter
```

## Test scenarios

### T1 — happy path convergence

- 3 clients start empty
- client A publishes 5 atoms (different tags/scope/node mixes)
- clients B, C absorb within one sync interval
- **Assert:** all 3 clients' `resolve()` output identical; A's atoms
  visible on B and C

### T2 — concurrent edits, no coordination

- A, B, C each publish disjoint atoms *at the same time*
- **Assert:** eventual equality on all clients; no atom lost; absorb of
  the same snapshot twice is a no-op (idempotence in the wild)

### T3 — deletes propagate, tombstones win

- A and B both have atom X; A deletes X mid-flight
- **Assert:** X disappears on B and C after sync, including from clients
  that re-received X in an old snapshot (tombstone wins over concurrent add)

### T4 — network slowness / partition (chaos-monkey)

- `toxiproxy` (or `tc netem` on the docker network) injects: latency
  spikes, packet loss, a full partition of B for N intervals
- during partition: B keeps working locally (authoring + local resolve)
- after heal: B catches up
- **Assert:** divergence is bounded by the partition window; after heal +
  one full sync round, all clients equal

### T5 — restart mid-flight (crash consistency)

- kill -9 a client's lattic service while it is absorbing
- restart it; it reloads from `/data/bag.json`
- **Assert:** no corruption, no lost atoms, converges with the others

### T6 — gossip topology

- C only syncs with B, not with A (B relays)
- **Assert:** A's changes reach C in at most two intervals; validates that
  transitive merge (merge-of-merges) is safe — it is, by
  associativity

## "Assume the end state" oracle

Every scenario ends with a *convergence assertion*, not a per-step one:

1. **Assumed end state** is declared up front (the union of all published
   atoms minus tombstones, expressed as the expected `resolve()` output)
2. A checker waits until every client's `resolve()` matches it exactly —
   polling with a deadline (`CONVERGENCE_TIMEOUT`, default 5× sync interval
   + worst-case injected delay)
3. On timeout: dump each client's full snapshot + tombstones for diffing

Equality is *set* equality of (text, scope, node, tags) per resolved view —
order is normalized by the canonical sort.

## Harness

- `docker compose` with: N `client` services (same image, different
  hostname/mounts), one shared `sync` volume, one `toxiproxy` service
- the test runner (Rust integration test in `tests/`, or a shell driver —
  pick Rust: reuses `contextual` types for the oracle) drives scenarios via
  `docker compose exec` / HTTP
- chaos is scripted per-scenario: toxiproxy API calls to add/remove
  toxicities mid-run
- CI-friendly: whole suite < 5 min, no external network

## Instrumentation

- every client exposes `GET /resolve`, `GET /snapshot`, `POST /merge` (the
  lattic-serve endpoints)
- the runner records a timeline: publish events, absorb events, assertion
  timestamps — so failures show *which interval lost what*
- syncd logs absorb counts (`+added -removed kept`), which map to the
  `SyncStats` already returned by the store

## Build order

1. ✅ `lattic-serve` (HTTP over Lattic: `PUT /atom`, `POST /merge`,
   `GET /resolve`, `GET /snapshot`, `DELETE /atom?text=`) — done, with a
   two-process smoke test (merge + delete propagation over HTTP verified)
2. compose file + syncd script + T1 happy path
3. oracle checker + T2, T3
4. toxiproxy wiring + T4, T5
5. T6 gossip relay
6. optional: run the same suite against a hub (single shared snapshot +
   merge-on-read) to compare topologies

## Open questions

- Does the sync worker need to diff foreign snapshots (mtime vs hash) to
  avoid re-absorbing? (Idempotence makes re-absorbing safe; only wasted IO.)
- Should lattic-serve expose tombstone of *not-present* atoms (pre-kill
  switch)? Currently `remove` requires the atom; text-only tombstones need
  the merged representation — same decision as cx's.
- Netem vs toxiproxy: toxiproxy only proxies TCP (HTTP), while sync is
  volume-copy based — so chaos must target the *service* HTTP calls, and
  volume-copy "slowness" is emulated by delaying copies in syncd instead.
