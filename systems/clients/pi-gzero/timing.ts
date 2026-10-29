/**
 * Nested timing spans, rendered as an ASCII table on stderr — the TS
 * twin of `src/timing.rs` in the Rust core. One trace at a time:
 * `startTrace(title)` opens it, `span(name, fn)` brackets any region
 * (nesting follows call depth, repeated sibling names merge into one
 * row with a call count, async fns measure to settlement),
 * `trace.print(label)` renders and closes. Spans outside a trace are
 * free.
 *
 * ```ts
 * const t = startTrace("session start");
 * const tools = await span("tools/list", () => mcpTools(cxMcp));
 * t.print("gzero pi plugin");
 * // └─ tools/list ·········· 61.3ms 100%
 * ```
 */

interface Node {
  name: string;
  /** Accumulated wall time of the measured regions (nested children
   * included — they ran inside), milliseconds. */
  ms: number;
  calls: number;
  children: Node[];
}

interface TraceState {
  root: Node;
  /** Innermost open span; spans attach under its last element. */
  stack: Node[];
  open: boolean;
  startedAt: number;
}

let current: TraceState | null = null;

function newNode(name: string): Node {
  return { name, ms: 0, calls: 0, children: [] };
}

/** Fold a measured subtree in: same-name children accumulate. */
function merge(target: Node, other: Node): void {
  target.ms += other.ms;
  target.calls += other.calls;
  for (const child of other.children) {
    const existing = target.children.find((c) => c.name === child.name);
    if (existing) merge(existing, child);
    else target.children.push(child);
  }
}

/** Running trace. `print`/`finish` close it; an abandoned trace
 * (early return, no print) is recorded as a warning instead of
 * vanishing. */
export interface Trace {
  /** Bracket a region; nested spans attach under this one. */
  span<T>(name: string, fn: () => T): T;
  /** Render the table and return it; closes the trace. */
  finish(): string;
  /** `finish` + record into the timing ring buffer (view with
   * /timing in the plugin). With `minMs`, traces under that total
   * close silently — only slow ones surface. CX_TRACE=1 also streams
   * to stderr live. */
  print(label?: string, minMs?: number): void;
}

// ---- the ring buffer (/timing views this; stderr is never touched
// unless CX_TRACE=1, so the pi TUI stays clean) ----

interface LogEntry {
  at: string;
  label: string;
  table: string;
}

const log: LogEntry[] = [];
const LOG_MAX = 40;

function record(label: string | undefined, table: string): void {
  const at = new Date().toLocaleTimeString([], { hour12: false });
  log.push({ at, label: label ?? "", table });
  if (log.length > LOG_MAX) log.shift();
  if (process.env.CX_TRACE === "1") {
    console.error(`gzero timing${label ? ` — ${label}` : ""} [${at}]\n${table}`);
  }
}

/** The last `n` recorded tables (most recent last), /timing's body. */
export function timingReport(n = 3): string {
  if (log.length === 0) return "no timings recorded yet";
  return log
    .slice(-n)
    .map((e) => `[${e.at}] ${e.label}\n${e.table}`)
    .join("\n\n");
}

/** Drop every recorded table. */
export function clearTimingReport(): void {
  log.length = 0;
}

/** Start a trace with this title as its root span. */
export function startTrace(title: string): Trace {
  if (current?.open) {
    // A previous trace was abandoned (early return); keep what it had
    // rather than silently losing its numbers.
    record("abandoned trace", render(current));
  }
  const root = newNode(title);
  current = { root, stack: [root], open: true, startedAt: performance.now() };
  return {
    span<T>(name: string, fn: () => T): T {
      return runSpan(name, fn);
    },
    finish(): string {
      return finishTrace();
    },
    print(label?: string, minMs = 0): void {
      const state = current;
      const elapsed = state ? performance.now() - state.startedAt : 0;
      if (state && elapsed < minMs) {
        finishTrace();
        return;
      }
      record(label, finishTrace());
    },
  };
}

/** Bracket a region under the innermost open span (or the trace root). */
export function span<T>(name: string, fn: () => T): T {
  return runSpan(name, fn);
}

function runSpan<T>(name: string, fn: () => T): T {
  const state = current;
  if (!state || !state.open) return fn();
  const node = newNode(name);
  state.stack.push(node);
  const t0 = performance.now();
  const close = () => {
    node.ms = performance.now() - t0;
    node.calls = 1;
    state.stack.pop();
    const parent = state.stack[state.stack.length - 1] ?? state.root;
    // Record as a row; a repeated name folds into its sibling instead.
    const existing = parent.children.find((c) => c.name === name);
    if (existing) merge(existing, node);
    else parent.children.push(node);
  };
  const result = fn();
  // Async fns: measure to settlement, not to first await return.
  if (result instanceof Promise) {
    return result.finally(close) as T;
  }
  close();
  return result;
}

function finishTrace(): string {
  const state = current;
  if (!state) return "(no trace)";
  state.open = false;
  current = null;
  return render(state);
}

/** Render the tree as a table: tree glyphs + dotted leaders to the
 * name column, then ms, share of the parent, and call count (when it
 * repeats). */
function render(state: TraceState): string {
  const root = state.root;
  const rows: string[][] = [];
  // Root ms is never recorded; children share against the trace total.
  walk(root, "", rows, performance.now() - state.startedAt);
  const nameWidth = Math.max(
    root.name.length + 3,
    ...rows.map((r) => r[0].length),
  ) + 2;
  const msWidth = Math.max(4, ...rows.map((r) => r[1].length));
  const total = fmtMs(performance.now() - state.startedAt);
  const lines: string[] = [`${root.name} [total ${total}]`];
  for (const [name, ms, pct, calls] of rows) {
    // Dotted leaders to the name column (matches src/timing.rs).
    const dots = Math.max(0, nameWidth - name.length - 1);
    lines.push(
      `${name} ${"·".repeat(dots)} ${ms.padStart(msWidth)}${pct.padStart(5)}${calls.padStart(4)}`,
    );
  }
  return lines.join("\n");
}

/** `ownMs` is the denominator for the children's share: a node's
 * measured time for interior spans, the trace total for the root
 * (whose own ms is never recorded). */
function walk(node: Node, prefix: string, rows: string[][], ownMs: number): void {
  node.children.forEach((child, i) => {
    const last = i + 1 === node.children.length;
    const branch = last ? "└─ " : "├─ ";
    rows.push([
      `${prefix}${branch}${child.name}`,
      fmtMs(child.ms),
      ownMs > 0 ? `${Math.round((child.ms / ownMs) * 100)}%` : "",
      child.calls > 1 ? `×${child.calls}` : "",
    ]);
    walk(child, `${prefix}${last ? "   " : "│  "}`, rows, child.ms);
  });
}

function fmtMs(ms: number): string {
  if (ms >= 100) return `${Math.round(ms)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}
