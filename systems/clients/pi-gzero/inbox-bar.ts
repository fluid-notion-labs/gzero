// inbox-bar.ts — the always-on traffic bar: one horizontal line across
// the top of the terminal showing this session's incoming traffic (S3
// messages and S3b broadcasts), each delivery's done state, and traffic
// rates (msg/sec | /10s | /min), warning above 1 msg/sec.
//
// Data source: a long-lived gzero-mcp child polls `msg_inbox` every
// INBOX_POLL_MS — a read-only view of the session's inbox (every live
// message with its read state, every broadcast with this session's seen
// time). Drains nothing: `msg_read` and resolve delivery stay in charge
// of that; the bar just watches unread → read transitions into a 'read'
// queue capped at READ_QUEUE_MAX. gzero-syncd keeps the comms doc fresh
// between polls; the poller's `msg_inbox` adopts on-disk changes itself.
//
// The bar is a non-capturing overlay anchored top-center, mirroring the
// tasks strip's rail. alt+m (or /messages) opens the message view panel.
// CX_INBOX_BAR=0 disables the feature.

import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SPINNER_FRAMES } from "./items-pane.ts";

// ---- tunables ----

/** Poll interval for `msg_inbox` over the persistent MCP child. */
export const INBOX_POLL_MS = 2_000;
/** The 'read' queue: only the last 3 done deliveries stay on the bar. */
export const READ_QUEUE_MAX = 3;
/** An arrival counts as traffic only if created this recently — a
 * weekend backlog read at session start must not look like a burst. */
export const FRESH_SECS = 60;
/** Warn threshold: strictly above 1 msg/s, measured over the 10s
 * window so a two-message ripple doesn't cry wolf. */
export const WARN_PER_SEC = 1;
/** Render tick: spinner frames while unread, traffic windows slide. */
export const BAR_TICK_MS = 500;

// ---- inbox data (mirrors gzero's `msg_inbox` JSON) ----

export interface InboxMessage {
  id: string;
  dest: string;
  sender: string;
  text: string;
  created: number;
  read_at: number;
}

export interface InboxBroadcast {
  id: string;
  sender: string;
  text: string;
  created: number;
  seen_at: number;
}

export interface InboxSnapshot {
  messages: InboxMessage[];
  broadcasts: InboxBroadcast[];
}

/** Parse a `msg_inbox` tool result; null when unparseable/malformed. */
export function parseInbox(text: string): InboxSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.messages) || !Array.isArray(obj.broadcasts)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    messages: obj.messages.map((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      return {
        id: str(r.id),
        dest: str(r.dest),
        sender: str(r.sender),
        text: str(r.text),
        created: num(r.created),
        read_at: num(r.read_at),
      };
    }),
    broadcasts: obj.broadcasts.map((b) => {
      const r = (b ?? {}) as Record<string, unknown>;
      return {
        id: str(r.id),
        sender: str(r.sender),
        text: str(r.text),
        created: num(r.created),
        seen_at: num(r.seen_at),
      };
    }),
  };
}

// ---- model ----

/** One conversation entry as the bar shows it. */
export interface BarEntry {
  id: string;
  sender: string;
  text: string;
  created: number;
}

/** Traffic over sliding windows, from poll-observed fresh arrivals. */
export interface Traffic {
  /** Arrivals in the last second. */
  perSec: number;
  /** Arrivals in the last 10 seconds. */
  per10s: number;
  /** Arrivals in the last minute. */
  perMin: number;
  /** Strictly above 1 msg/s over the 10s window — the warn state. */
  warn: boolean;
}

interface Tracked {
  sender: string;
  text: string;
  created: number;
  /** Message read_at / broadcast seen_at; 0 = unread. */
  readAt: number;
}

export interface InboxState {
  /** Unread entries, oldest first. */
  unread: BarEntry[];
  /** Done deliveries, oldest evicted past READ_QUEUE_MAX. */
  readQueue: BarEntry[];
}

/**
 * Pure bar model: tracks known entries, unread → read transitions and
 * fresh arrivals. `apply` merges one snapshot; the read queue keeps its
 * own copies so entries expiring out of the store stay visible until
 * evicted. Traffic counts only fresh arrivals (FRESH_SECS) observed at
 * poll time, so backlogs don't masquerade as bursts.
 */
export class InboxModel {
  private known = new Map<string, Tracked>();
  /** Poll-time stamps of fresh arrivals, pruned to the minute window. */
  private arrivals: number[] = [];
  private unreadEntries: BarEntry[] = [];
  private lastSig = "";

  readQueue: BarEntry[] = [];
  /** True once at least one snapshot was applied successfully. */
  seen = false;

  /** Merge one snapshot; returns true when visible state changed. */
  apply(snapshot: InboxSnapshot, nowMs: number): boolean {
    const nowSec = Math.floor(nowMs / 1000);
    const cutoff = nowSec - FRESH_SECS;
    const entries = [
      ...snapshot.messages.map((m) => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        created: m.created,
        readAt: m.read_at,
      })),
      ...snapshot.broadcasts.map((b) => ({
        id: b.id,
        sender: b.sender,
        text: b.text,
        created: b.created,
        readAt: b.seen_at,
      })),
    ];
    const seen = new Set<string>();
    const unread: BarEntry[] = [];
    let changed = false;
    for (const e of entries) {
      if (!e.id) continue;
      seen.add(e.id);
      const prev = this.known.get(e.id);
      if (prev) {
        if (e.readAt !== prev.readAt) {
          // Done: into the read queue (own copies; the store may TTL
          // the entry out from under us before the cap evicts it).
          if (prev.readAt === 0 && e.readAt > 0) {
            this.readQueue.push({
              id: e.id,
              sender: e.sender,
              text: e.text,
              created: e.created,
            });
            while (this.readQueue.length > READ_QUEUE_MAX) this.readQueue.shift();
          }
          this.known.set(e.id, { ...e });
          changed = true;
        }
      } else {
        this.known.set(e.id, { ...e });
        if (e.created >= cutoff) this.arrivals.push(nowMs);
        changed = true;
      }
      if (e.readAt === 0) {
        unread.push({ id: e.id, sender: e.sender, text: e.text, created: e.created });
      }
    }
    // Entries that vanished (TTL'd, swept, epoch roll) drop out of
    // tracking; read-queue copies survive until the cap evicts them.
    let vanished = false;
    for (const id of this.known.keys()) {
      if (!seen.has(id)) vanished = true;
    }
    if (vanished) {
      for (const id of [...this.known.keys()]) {
        if (!seen.has(id)) this.known.delete(id);
      }
      changed = true;
    }
    if (this.arrivals.length > 0) {
      this.arrivals = this.arrivals.filter((t) => nowMs - t < 60_000);
    }
    this.unreadEntries = unread;
    this.seen = true;
    const sig = JSON.stringify([unread.map((u) => u.id), this.readQueue.map((r) => r.id)]);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      changed = true;
    }
    return changed;
  }

  get unread(): BarEntry[] {
    return this.unreadEntries;
  }

  state(): InboxState {
    return { unread: this.unreadEntries, readQueue: this.readQueue };
  }

  /** Whether any arrival is still inside the minute window (keeps the
   * tick timer alive so the traffic readout keeps sliding). */
  hasLiveTraffic(nowMs: number): boolean {
    return this.arrivals.some((t) => nowMs - t < 60_000);
  }

  traffic(nowMs: number): Traffic {
    const inWindow = (ms: number) => this.arrivals.filter((t) => nowMs - t < ms).length;
    const per10s = inWindow(10_000);
    const perMin = inWindow(60_000);
    return {
      perSec: inWindow(1_000),
      per10s,
      perMin,
      warn: per10s / 10 > WARN_PER_SEC,
    };
  }
}

// ---- rendering (pure) ----

export type BarColor = "accent" | "dim" | "muted" | "warning";

/** Truncate an entry to `sender: text`, fitting `max` cells. */
export function entryLabel(e: BarEntry, max: number): string {
  const head = `${e.sender.slice(0, 8)}: `;
  const rest = Math.max(0, max - visibleWidth(head) - 1);
  const body = e.text.length > rest ? e.text.slice(0, Math.max(0, rest - 1)) + "…" : e.text;
  return head + body;
}

/**
 * The bar's left-side segments: a spinner + count while anything is
 * unread (each entry shown as ▸), then the read queue as ✓ entries —
 * done deliveries linger until evicted, max 3.
 */
export function barSegments(state: InboxState, frame: number): { text: string; color: BarColor }[] {
  const segs: { text: string; color: BarColor }[] = [];
  if (state.unread.length > 0) {
    segs.push({ text: SPINNER_FRAMES[frame % SPINNER_FRAMES.length] + " ", color: "accent" });
    segs.push({ text: `${state.unread.length} incoming`, color: "accent" });
    for (const u of state.unread) {
      segs.push({ text: ` ▸ ${entryLabel(u, 28)}`, color: "accent" });
    }
  }
  for (const r of state.readQueue) {
    segs.push({ text: ` ✓ ${entryLabel(r, 28)}`, color: "dim" });
  }
  return segs;
}

/** "0.3/s · 3/10s · 8/min", ⚠-prefixed in the warn state. */
export function trafficText(t: Traffic): string {
  const rate = (t.per10s / 10).toFixed(1);
  return `${t.warn ? "⚠ " : ""}${rate}/s · ${t.per10s}/10s · ${t.perMin}/min`;
}

/**
 * The full bar line: left segments, traffic right-aligned. Entries
 * that don't fully fit are dropped whole — read entries go first (the
 * queue's head is the oldest), unread beat read for space — and the
 * line is always at least the traffic values.
 */
export function renderBar(
  state: InboxState,
  traffic: Traffic,
  frame: number,
  theme: Theme,
  width: number,
): string {
  if (width < 12) return "";
  const text = trafficText(traffic);
  const right = theme.fg(traffic.warn ? "warning" : "muted", text);
  const rightW = visibleWidth(text);
  if (rightW + 4 > width) {
    // Too narrow for both: the values alone, truncated.
    return theme.fg("muted", truncateToWidth(text, width));
  }
  const budget = width - rightW - 2;
  let left = "";
  for (const seg of barSegments(state, frame)) {
    if (visibleWidth(seg.text) <= budget - visibleWidth(left)) {
      left += theme.fg(seg.color, seg.text);
    }
    // Doesn't fit whole: dropped, not truncated — the next (newer)
    // entry may still fit, and a half-entry reads as a glitch.
  }
  const pad = Math.max(0, width - rightW - visibleWidth(left));
  return left + " ".repeat(pad) + right;
}

// ---- components ----

/**
 * The traffic bar. Passive: no input handling; content is derived from
 * the model on each render, and the controller ticks frames and
 * requests re-renders.
 */
export class InboxBar implements Component {
  private theme: Theme | null = null;
  private tui: TUI | null = null;
  private frame = 0;
  private model: InboxModel;

  constructor(model: InboxModel) {
    this.model = model;
  }

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
  }

  dispose(): void {
    this.tui = null;
    this.theme = null;
  }

  /** Advance the spinner frame (controller tick). */
  tick(): void {
    this.frame += 1;
  }

  requestRender(): void {
    this.tui?.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme;
    // Hidden until the first successful poll: a stale gzero-mcp (no
    // msg_inbox) degrades to no bar rather than an error line.
    if (!theme || !this.model.seen || width < 12) return [];
    const nowMs = Date.now();
    const line = renderBar(this.model.state(), this.model.traffic(nowMs), this.frame, theme, width);
    return line ? [line] : [];
  }
}

/**
 * The message view panel: the bar's content, fullscreen-ish — unread
 * first, then the read queue, traffic in the title. Capturing overlay;
 * esc/q (or the toggle key again) closes.
 */
export class MessagesView implements Component {
  private theme: Theme | null = null;
  private tui: TUI | null = null;
  private model: InboxModel;
  private onClose: () => void;

  constructor(model: InboxModel, onClose: () => void) {
    this.model = model;
    this.onClose = onClose;
  }

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
  }

  dispose(): void {
    this.tui = null;
    this.theme = null;
  }

  /** Capturing: close on esc/q (or the toggle keys), swallow the rest. */
  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "q") ||
      matchesKey(data, "ctrl+m") ||
      matchesKey(data, "alt+m")
    ) {
      this.onClose();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme;
    if (!theme || width < 20) return [];
    const nowMs = Date.now();
    const state = this.model.state();
    const traffic = this.model.traffic(nowMs);
    const inner = Math.max(10, width - 4);
    const lines: string[] = [];
    lines.push(
      theme.fg(traffic.warn ? "warning" : "muted", ` messages — ${trafficText(traffic)}`),
    );
    if (state.unread.length > 0) {
      for (const u of state.unread) {
        lines.push(" " + theme.fg("accent", `▸ ${entryLabel(u, inner - 3)}`));
      }
    } else {
      lines.push(" " + theme.fg("muted", "no incoming messages"));
    }
    if (state.readQueue.length > 0) {
      lines.push("");
      lines.push(" " + theme.fg("dim", "read (last 3):"));
      for (const r of state.readQueue) {
        lines.push(" " + theme.fg("dim", `✓ ${entryLabel(r, inner - 3)}`));
      }
    }
    lines.push("");
    lines.push(" " + theme.fg("dim", "esc/q close · alt+m toggles"));
    return lines;
  }
}

// ---- persistent MCP poller ----

import { type ChildProcess, spawn } from "node:child_process";

/**
 * A long-lived gzero-mcp stdio session: one spawn, many requests. The
 * child does its own startup hub sync and heartbeat; requests after a
 * crash respawn the child. One-shot spawns per poll would pay a process
 * + handshake every 2s — this pays it once.
 */
export class McpPoller {
  private child: ChildProcess | null = null;
  private spawnedChild: ChildProcess | null = null;
  private buf = "";
  private nextId = 2;
  private readyPromise: Promise<ChildProcess> | null = null;
  private readyOk: ((c: ChildProcess) => void) | null = null;
  private readyErr: ((e: Error) => void) | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private command: string;

  constructor(command: string) {
    this.command = command;
  }

  /** Spawn + handshake once; later calls reuse the connection. */
  private ensure(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<ChildProcess>((resolve, reject) => {
      this.readyOk = resolve;
      this.readyErr = reject;
      const child = spawn(this.command, [], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, CX_ONE_SHOT: "1" },
      });
      this.spawnedChild = child;
      // A dead/broken child must never take down pi (EPIPE on stdin).
      child.stdin?.on("error", () => {});
      child.on("error", (e) => this.fail(e));
      child.on("exit", () => this.fail(new Error("gzero-mcp poller exited")));
      child.stdout?.on("data", (d: Buffer) => this.handleData(d));
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pi-gzero-poller", version: "0.1.0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      setTimeout(() => {
        if (!this.child) this.fail(new Error("gzero-mcp poller: handshake timed out"));
      }, 10_000).unref?.();
    });
    return this.readyPromise;
  }

  /** Route incoming messages: handshake reply, then pending calls. */
  private handleData(d: Buffer): void {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue;
      if (msg.id === 1) {
        // Handshake reply: the child is live.
        this.child = this.spawnedChild;
        const ok = this.readyOk;
        this.readyOk = null;
        this.readyErr = null;
        this.readyPromise = null;
        if (this.child && ok) ok(this.child);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const m =
          typeof msg.error === "object" && msg.error !== null && "message" in msg.error
            ? String((msg.error as { message: unknown }).message)
            : JSON.stringify(msg.error);
        p.reject(new Error(m));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private fail(e: Error): void {
    const err = this.readyErr;
    this.readyOk = null;
    this.readyErr = null;
    this.readyPromise = null;
    this.child = null;
    this.spawnedChild = null;
    this.buf = "";
    err?.(e);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  /** One tools/call over the persistent connection; returns the text. */
  async call(tool: string, args: unknown = {}, timeoutMs = 8_000): Promise<string> {
    const child = await this.ensure();
    const id = this.nextId++;
    const result = (await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The child may be wedged; drop it so the next call respawns.
        this.fail(new Error(`gzero-mcp ${tool}: timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }) + "\n",
      );
    })) as { content?: { type: string; text?: string }[] } | undefined;
    const content = result?.content ?? [];
    return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  }

  close(): void {
    const child = this.spawnedChild;
    this.fail(new Error("poller closed"));
    child?.kill();
  }
}

// ---- controller ----

/** Mode toggle: CX_INBOX_BAR=0 turns the whole feature off. */
export function initialInboxMode(env: NodeJS.ProcessEnv = process.env): "bar" | "off" {
  return env.CX_INBOX_BAR === "0" ? "off" : "bar";
}

export class InboxBarController {
  private model = new InboxModel();
  private poller: McpPoller | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private bar: InboxBar | null = null;
  private barDone: ((result: undefined) => void) | null = null;
  private view: MessagesView | null = null;
  private viewDone: ((result: undefined) => void) | null = null;
  private opening = false;
  /** Set when gzero-mcp lacks msg_inbox (stale install): stop quietly. */
  private unsupported = false;

  get active(): boolean {
    return this.bar !== null;
  }

  get viewOpen(): boolean {
    return this.view !== null;
  }

  /** Session start: open the always-on overlay and begin polling. */
  async start(ctx: ExtensionContext, cxMcp: string): Promise<void> {
    if (initialInboxMode() === "off") return;
    if (this.poller || ctx.mode !== "tui" || !ctx.hasUI) return;
    this.poller = new McpPoller(cxMcp);
    // The overlay's custom() promise stays pending by design (the bar
    // lives until shutdown) — open fire-and-forget, poll immediately.
    // A failed open (races at session start) must not reject unhandled.
    this.open(ctx).catch(() => {});
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), INBOX_POLL_MS);
    this.pollTimer.unref?.();
  }

  /** Open the bar overlay (mirrors the tasks strip's ensureStrip). */
  private async open(ctx: ExtensionContext): Promise<void> {
    if (this.bar || this.opening) return;
    this.opening = true;
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          this.bar = new InboxBar(this.model);
          this.bar.attach(tui, theme);
          this.barDone = done;
          this.opening = false;
          return this.bar;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: "100%",
            anchor: "top-center",
            margin: { top: 0 },
            nonCapturing: true,
            visible: (termWidth: number) => termWidth >= 60,
          }),
        },
      );
    } finally {
      this.opening = false;
    }
  }

  /** One msg_inbox poll: apply to the model, re-render on change. */
  async poll(): Promise<void> {
    if (!this.poller || this.unsupported) return;
    let text: string;
    try {
      text = await this.poller.call("msg_inbox");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unknown tool|method not found/i.test(msg)) {
        // Stale gzero-mcp: no bar rather than a permanent error.
        this.unsupported = true;
        this.stopTimers();
        this.teardown();
        return;
      }
      return; // transient (sync, hub) — the next tick retries
    }
    const snapshot = parseInbox(text);
    if (!snapshot) return;
    if (this.model.apply(snapshot, Date.now())) this.repaint();
  }

  /** Re-render tick: spinner frames while unread, traffic sliding. */
  private syncTick(): void {
    const need = this.model.unread.length > 0 || this.model.hasLiveTraffic(Date.now());
    if (need && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        this.bar?.tick();
        this.bar?.requestRender();
      }, BAR_TICK_MS);
      this.tickTimer.unref?.();
    } else if (!need && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private repaint(): void {
    this.bar?.invalidate();
    this.bar?.requestRender();
    this.syncTick();
  }

  private stopTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private teardown(): void {
    this.stopTimers();
    this.bar?.dispose();
    const done = this.barDone;
    this.barDone = null;
    this.bar = null;
    done?.(undefined);
    this.poller?.close();
    this.poller = null;
  }

  /** /messages (alt+m or ctrl+m): toggle the message view panel —
   * the bar's content, roomier. Non-TUI modes get a notification. */
  async toggleView(ctx: ExtensionContext): Promise<void> {
    if (this.viewDone) {
      this.closeView();
      return;
    }
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify(
        `messages: ${this.model.unread.length} unread — ${trafficText(this.model.traffic(Date.now()))}`,
        "info",
      );
      return;
    }
    await ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        const view = new MessagesView(this.model, () => this.closeView());
        view.attach(tui, theme);
        this.view = view;
        this.viewDone = done;
        return view;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          width: 80,
          minWidth: 40,
          maxHeight: "40%",
          anchor: "top-center",
          margin: { top: 1 },
          visible: (termWidth: number) => termWidth >= 60,
        }),
      },
    );
    // Resolves when the view closed itself (esc/q) or closeView ran.
    this.view = null;
    this.viewDone = null;
  }

  private closeView(): void {
    const done = this.viewDone;
    this.viewDone = null;
    this.view?.dispose();
    this.view = null;
    done?.(undefined);
  }

  /** Full teardown on session shutdown. */
  shutdown(): void {
    this.closeView();
    this.teardown();
  }
}
