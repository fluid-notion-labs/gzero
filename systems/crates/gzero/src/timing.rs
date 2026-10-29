//! Nested timing spans, rendered as an ASCII table on stderr.
//!
//! One trace per thread: [`Timer::new`] starts the root and makes the
//! thread "traced"; [`span`] then brackets any region — nesting follows
//! the guard drop order, and repeated sibling names merge (so a paging
//! loop shows one row with a call count). [`Timer::finish`] renders the
//! tree as a table; spans outside a trace are free (no-op guards).
//!
//! ```ignore
//! let t = Timer::new("startup");
//! { let _s = span("sync"); do_sync(); }
//! t.print(); // └─ sync ......... 812ms 100% ×1
//! ```

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

#[derive(Clone, Default)]
struct Node {
    name: String,
    /// Accumulated wall time of the measured regions (nested children
    /// included — they ran inside), milliseconds.
    ms: f64,
    calls: u32,
    children: Vec<Rc<RefCell<Node>>>,
}

impl Node {
    fn new(name: &str) -> Rc<RefCell<Node>> {
        Rc::new(RefCell::new(Node {
            name: name.to_string(),
            ..Node::default()
        }))
    }

    /// Fold a repeated sibling record in: same-name children
    /// accumulate time and calls instead of repeating as rows.
    fn merge(&mut self, other: Node) {
        self.ms += other.ms;
        self.calls += other.calls;
        for child in other.children {
            let name = child.borrow().name.clone();
            if let Some(existing) = self
                .children
                .iter()
                .find(|c| c.borrow().name == name)
            {
                for grand in child.borrow().children.iter() {
                    let g = grand.borrow().clone();
                    existing.borrow_mut().merge(g);
                }
            } else {
                self.children.push(child);
            }
        }
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Trace>> = const { RefCell::new(None) };
}

struct Trace {
    root: Rc<RefCell<Node>>,
    /// Innermost open span; spans attach under its last element.
    stack: Vec<Rc<RefCell<Node>>>,
}

/// A running trace. Created with [`Timer::new`]; [`Timer::finish`] (or
/// `print`) renders and closes it. If neither runs, [`Drop`] prints —
/// a dropped trace never silently loses its numbers.
pub struct Timer {
    root: Rc<RefCell<Node>>,
    start: Instant,
    done: bool,
}

impl Timer {
    /// Start a trace with this title as its root span.
    pub fn new(title: &str) -> Timer {
        let root = Node::new(title);
        CURRENT.with(|c| {
            // A still-open previous trace on this thread (an early
            // return dropped its guard path) is closed by replacement.
            if let Some(old) = c.borrow_mut().replace(Trace {
                root: root.clone(),
                stack: vec![root.clone()],
            }) {
                let _ = old; // dropped; its Timer already owns rendering
            }
        });
        Timer {
            root,
            start: Instant::now(),
            done: false,
        }
    }

    /// Render the table and return it; closes the trace.
    /// Bracket a closure under this trace's innermost span — the
    /// per-call-site form of [`with`] that reads clearly in startup code.
    pub fn span<T>(&self, name: &str, f: impl FnOnce() -> T) -> T {
        with(name, f)
    }

    pub fn finish(mut self) -> String {
        self.done = true;
        let total = self.start.elapsed().as_secs_f64() * 1000.0;
        let root = self.root.borrow().clone();
        CURRENT.with(|c| *c.borrow_mut() = None);
        render(&root, total)
    }

    /// `finish` + stderr, prefixed with `$argv0`-style label.
    pub fn print(self, label: &str) {
        let table = self.finish();
        eprintln!("{label}\n{table}");
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if !self.done {
            // finish() was skipped (panic, early `?`): still show the numbers.
            let total = self.start.elapsed().as_secs_f64() * 1000.0;
            let root = self.root.borrow().clone();
            CURRENT.with(|c| *c.borrow_mut() = None);
            let table = render(&root, total);
            eprintln!("gzero-timing (dropped trace)\n{table}");
            self.done = true;
        }
    }
}

/// Bracket a region under the innermost open span (or the trace root).
/// No trace on this thread: a guard that records nothing.
///
/// ```ignore
/// { let _s = span("hub pull"); pull(); } // closes on drop
/// ```
pub fn span(name: &str) -> SpanGuard {
    let target = CURRENT.with(|c| {
        c.borrow().as_ref().map(|t| {
            t.stack
                .last()
                .cloned()
                .unwrap_or_else(|| t.root.clone())
        })
    });
    match target {
        Some(parent) => {
            let node = Node::new(name);
            CURRENT.with(|c| {
                if let Some(t) = c.borrow_mut().as_mut() {
                    t.stack.push(node.clone());
                }
            });
            SpanGuard {
                parent: Some(parent),
                node: Some(node),
                start: Instant::now(),
            }
        }
        None => SpanGuard {
            parent: None,
            node: None,
            start: Instant::now(),
        },
    }
}

/// Bracket a closure under the innermost open span (or the trace
/// root) — the ergonomic form for expression positions:
/// `timing::with("pull", || hub.pull(store, cursor))?`.
pub fn with<T>(name: &str, f: impl FnOnce() -> T) -> T {
    let _guard = span(name);
    f()
}

/// Open span: records itself under its parent when dropped.
pub struct SpanGuard {
    parent: Option<Rc<RefCell<Node>>>,
    node: Option<Rc<RefCell<Node>>>,
    start: Instant,
}

impl Drop for SpanGuard {
    fn drop(&mut self) {
        let (Some(parent), Some(node)) = (&self.parent, &self.node) else {
            return;
        };
        {
            let mut n = node.borrow_mut();
            n.ms = self.start.elapsed().as_secs_f64() * 1000.0;
            n.calls = 1;
        }
        // Record as a row; a repeated name (loop iterations, retried
        // pages) folds into its sibling instead.
        {
            let mut p = parent.borrow_mut();
            let name = node.borrow().name.clone();
            if let Some(existing) = p.children.iter().find(|c| c.borrow().name == name) {
                let subtree = node.borrow().clone();
                existing.borrow_mut().merge(subtree);
            } else {
                p.children.push(node.clone());
            }
        }
        // Pop only if this guard is innermost — an inner guard that
        // outlives an outer one (leaked/unusual drop order) must not
        // unwind the stack for it.
        CURRENT.with(|c| {
            if let Some(t) = c.borrow_mut().as_mut() {
                if t.stack.last().map_or(false, |top| Rc::ptr_eq(top, node)) {
                    t.stack.pop();
                }
            }
        });
    }
}

/// Render the tree as a table: dotted leaders to a name column, then
/// ms, share of the parent, and call count (when it repeats).
fn render(root: &Node, total_ms: f64) -> String {
    let mut rows: Vec<(String, String, String, String)> = Vec::new(); // name, ms, %, calls
    walk(root, "", &mut rows, total_ms);
    let width = rows
        .iter()
        .map(|(n, ..)| n.chars().count())
        .max()
        .unwrap_or(root.name.chars().count())
        .max(root.name.chars().count() + 3);
    let ms_w = rows
        .iter()
        .map(|(_, m, ..)| m.len())
        .chain(std::iter::once(fmt_ms(total_ms).len()))
        .max()
        .unwrap_or(3);
    let mut out = String::new();
    let title = format!("{} [total {}]", root.name, fmt_ms(total_ms));
    out.push_str(&title);
    out.push('\n');
    for (name, ms, pct, calls) in &rows {
        let dots = width.saturating_sub(name.chars().count());
        out.push_str(name);
        out.push(' ');
        for _ in 0..dots.saturating_sub(1) {
            out.push('·');
        }
        out.push(' ');
        out.push_str(&format!("{:>width_ms$} {:>4} {:>5}", ms, pct, calls, width_ms = ms_w + 2));
        out.push('\n');
    }
    out
}

/// `own_ms` is the denominator for the children's share: a node's
/// measured time for interior spans, the trace total for the root
/// (whose own ms is never recorded).
fn walk(
    node: &Node,
    prefix: &str,
    rows: &mut Vec<(String, String, String, String)>,
    own_ms: f64,
) {
    let n = node.children.len();
    for (i, child) in node.children.iter().enumerate() {
        let last = i + 1 == n;
        let c = child.borrow();
        let branch = if last { "└─ " } else { "├─ " };
        let name = format!("{prefix}{branch}{}", c.name);
        let ms = fmt_ms(c.ms);
        let pct = if own_ms > 0.0 {
            format!("{:.0}%", c.ms / own_ms * 100.0)
        } else {
            String::new()
        };
        let calls = if c.calls > 1 {
            format!("×{}", c.calls)
        } else {
            String::new()
        };
        rows.push((name, ms, pct, calls));
        let ext = if last { "   " } else { "│  " };
        let child_ms = c.ms;
        walk(&c, &format!("{prefix}{ext}"), rows, child_ms);
    }
}

fn fmt_ms(ms: f64) -> String {
    if ms >= 100.0 {
        format!("{:.0}ms", ms)
    } else if ms >= 10.0 {
        format!("{:.1}ms", ms)
    } else {
        format!("{:.2}ms", ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nesting_and_merge() {
        let t = Timer::new("root");
        {
            let _a = span("sync");
            {
                let _b = span("pull");
                for _ in 0..3 {
                    let _p = span("page");
                }
            }
            {
                let _c = span("push");
                // Real work so the share math isn't pure timer overhead.
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
        let out = t.finish();
        assert!(out.contains("root [total"));
        assert!(out.contains("sync"));
        assert!(out.contains("×3"), "repeated pages merge: {out}");
        assert!(out.contains("push"));
        // Children indent under their parent, not at root level.
        // (sync and pull are last children, so their extension is spaces.)
        let pull_line = out.lines().find(|l| l.contains("pull")).unwrap();
        assert!(pull_line.starts_with("   ├─ "), "pull nests under sync: {pull_line}");
        let page_line = out.lines().find(|l| l.contains("page")).unwrap();
        assert!(page_line.starts_with("   │  └─ "), "page nests under pull: {page_line}");
        let sync_line = out.lines().find(|l| l.contains("sync")).unwrap();
        // Sole child of the root: ~100% of the trace total, minus the
        // timer's own bookkeeping between spans.
        let pct: u32 = sync_line
            .split_whitespace()
            .find(|t| t.ends_with('%'))
            .and_then(|t| t.trim_end_matches('%').parse().ok())
            .expect("pct column");
        assert!(pct >= 90, "share of parent: {sync_line}");
    }

    #[test]
    fn spans_without_trace_are_free() {
        let _g = span("no trace active");
    }

}
