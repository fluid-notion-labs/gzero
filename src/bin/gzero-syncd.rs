//! gzero-syncd — resident per-machine sync daemon.
//!
//! The silent refresher from `research/sync-daemon.md`: sessions keep
//! writing the doc files directly (they already push on every write);
//! this daemon closes the receiving side, which today only syncs when
//! a session happens to write. It owns no documents of its own —
//! correctness never depends on it, and it is crash-only: cursors
//! live in the per-doc sidecar, so kill -9 at any point resumes on
//! the next cycle.
//!
//! Per bag (context @ CX_WS_DB, comms @ CX_COMMS_DB):
//! - on boot: one full pull+push (covers everything missed offline)
//! - an SSE stream on the hub's `/bag/{name}/events` wakes an
//!   immediate sync on push (the live path, target ≤2s)
//! - a periodic backstop sync (default 60s) covers SSE loss
//!
//! The doc lock in AutomergeStore (held per flush / per sync
//! transaction) makes the daemon and concurrent sessions safe
//! co-writers; merge-on-flush means a stale session cannot clobber a
//! daemon-applied pull.
//!
//! Config: CX_HUB_URL, CX_TOKEN (required), CX_WS_DB, CX_COMMS_DB,
//! CX_BAG, CX_COMMS_BAG, CX_SYNCD_BACKSTOP_SECS (default 60).

use gzero::comms::{comms_bag, comms_db_path};
use gzero::hub_changes::{self, HubChanges};
use gzero::sections::default_ws_path;
use gzero::{atoms_bag, AutomergeStore};
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// One synced bag: a doc file plus its hub-side change-log name.
struct Bag {
    name: String,
    doc: PathBuf,
}

fn bags() -> Vec<Bag> {
    vec![
        Bag {
            name: atoms_bag(),
            doc: default_ws_path(),
        },
        Bag {
            name: comms_bag(),
            doc: comms_db_path(),
        },
    ]
}

/// One full sync of one bag: open the doc fresh (it may have been
/// written by a session since our last cycle), pull+push under the
/// doc lock. Cursor sidecar is per doc, so sessions and daemon share
/// one cursor per bag — no double-pushing.
fn sync_bag(bag: &Bag) -> Result<(usize, usize), String> {
    let hub = HubChanges::from_env(&bag.name)
        .ok_or_else(|| "hub not configured (CX_HUB_URL/CX_TOKEN)".to_string())?;
    let mut store =
        AutomergeStore::open(Some(&bag.doc)).map_err(|e| e.to_string())?;
    hub_changes::sync_store(
        &mut store,
        &hub,
        &hub_changes::sidecar_path(&bag.doc),
        &bag.name,
    )
}

fn log(msg: &str) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    eprintln!("[{secs}] gzero-syncd: {msg}");
}

fn hub_base() -> String {
    std::env::var("CX_HUB_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string()
}

fn hub_token() -> String {
    std::env::var("CX_TOKEN").unwrap_or_default()
}

fn main() {
    if hub_base().is_empty() || hub_token().is_empty() {
        eprintln!(
            "gzero-syncd: CX_HUB_URL and CX_TOKEN must be set (see install.sh); exiting"
        );
        std::process::exit(1);
    }
    let backstop = Duration::from_secs(
        std::env::var("CX_SYNCD_BACKSTOP_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60),
    );
    log(&format!(
        "starting: backstop={}s bags={}",
        backstop.as_secs(),
        bags()
            .iter()
            .map(|b| format!("{}@{}", b.name, b.doc.display()))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    let all = bags();
    let (tx, rx) = mpsc::channel::<String>();

    // One SSE listener per bag. The loop never returns: connect →
    // read events until the stream ends → reconnect with backoff. A
    // read timeout (3 missed heartbeats) catches silently-stalled
    // connections.
    for bag in &all {
        let tx = tx.clone();
        let bag = Bag {
            name: bag.name.clone(),
            doc: bag.doc.clone(),
        };
        std::thread::spawn(move || sse_loop(tx, bag));
    }

    // Boot sync: everything missed while offline, before any SSE.
    for bag in &all {
        boot_sync(bag);
    }

    loop {
        match rx.recv_timeout(backstop) {
            Ok(name) => {
                // Coalesce bursts: drain whatever else arrived.
                let mut due: Vec<String> = vec![name];
                while let Ok(more) = rx.try_recv() {
                    if !due.contains(&more) {
                        due.push(more);
                    }
                }
                for bag in all.iter().filter(|b| due.contains(&b.name)) {
                    cycle_sync(bag, "push event");
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                for bag in &all {
                    cycle_sync(bag, "backstop");
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => unreachable!(
                "sse_loop threads never exit; senders stay alive"
            ),
        }
    }
}

fn boot_sync(bag: &Bag) {
    match sync_bag(bag) {
        Ok((pushed, pulled)) => {
            log(&format!(
                "boot {}@{}: pushed {pushed}, pulled {pulled}",
                bag.name,
                bag.doc.display()
            ));
        }
        Err(e) => log(&format!(
            "boot {}@{} FAILED: {e}",
            bag.name,
            bag.doc.display()
        )),
    }
}

fn cycle_sync(bag: &Bag, why: &str) {
    match sync_bag(bag) {
        Ok((pushed, pulled)) => {
            if pushed > 0 || pulled > 0 {
                log(&format!(
                    "{} {}@{}: pushed {pushed}, pulled {pulled}",
                    why,
                    bag.name,
                    bag.doc.display()
                ));
            }
        }
        Err(e) => log(&format!(
            "{} {}@{} FAILED: {e}",
            why,
            bag.name,
            bag.doc.display()
        )),
    }
}

/// SSE listener: connect to the hub's event stream for one bag and
/// forward push triggers to the main loop. Never returns; reconnects
/// with capped exponential backoff. SSE is a trigger only — every
/// reconnect does a normal pull, so a lost stream is a latency blip,
/// never lost data.
fn sse_loop(tx: mpsc::Sender<String>, bag: Bag) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        // 3 missed heartbeats (25s each) → the connection is dead.
        .timeout_read(Duration::from_secs(90))
        .build();
    let url = format!("{}/bag/{}/events", hub_base(), bag.name);
    let auth = format!("Bearer {}", hub_token());
    let mut backoff: u64 = 2;
    loop {
        match agent
            .get(&url)
            .set("Authorization", &auth)
            .set("Accept", "text/event-stream")
            .call()
        {
            Ok(resp) => {
                log(&format!("sse connected: {} ({})", url, resp.status()));
                backoff = 2;
                let mut push_seen = false;
                let mut line = String::new();
                let result = (|| -> std::io::Result<()> {
                    let mut reader = std::io::BufReader::new(resp.into_reader());
                    loop {
                        line.clear();
                        let n = reader.read_line(&mut line)?;
                        if n == 0 {
                            return Ok(()); // stream ended
                        }
                        let l = line.trim_end();
                        if l.starts_with("event: push") {
                            push_seen = true;
                        } else if l.is_empty() && push_seen {
                            push_seen = false;
                            let _ = tx.send(bag.name.clone());
                        }
                        // "event: hello", data lines and heartbeat
                        // comments carry nothing we need: a fresh
                        // connection gets a boot-style pull anyway.
                    }
                })();
                if let Err(e) = result {
                    log(&format!("sse read error: {}: {e}", bag.name));
                } else {
                    log(&format!("sse stream ended: {}", bag.name));
                }
            }
            Err(ureq::Error::Status(code, _)) => {
                log(&format!("sse connect: {} rejected ({code}); retrying", bag.name));
            }
            Err(e) => {
                log(&format!("sse connect: {} failed ({e}); retrying", bag.name));
            }
        }
        std::thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(60);
    }
}
