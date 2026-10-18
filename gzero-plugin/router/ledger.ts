// ledger.ts — append-only JSONL usage ledger, the ai-harness-memory §3.6
// measurement-gate data: per-request input / cached / output tokens and cost,
// per classification, per route decision (with its cache implication), and
// per dispatch. Written locally, appended synchronously, and never allowed
// to break the turn: a ledger failure is swallowed.
//
// The "cacheEvent" on route entries is the proxy for §3.6's post-miss flag:
// a model switch means the next provider request re-prices its prefix.

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  reasoning?: number;
  costTotal: number;
}

export function toUsageRecord(usage: Usage | undefined): UsageRecord | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
    reasoning: usage.reasoning,
    costTotal: usage.cost.total,
  };
}

export const DEFAULT_LEDGER_PATH = join(homedir(), ".pi", "agent", "pi-router-ledger.jsonl");

export interface LedgerSummary {
  total: number;
  byKind: Record<string, number>;
  /** Route decisions grouped by work type ("unclassified" included). */
  routesByType: Record<string, number>;
  /** Dispatch (subagent) outcomes. */
  dispatchOk: number;
  dispatchFailed: number;
  /** Last `limit` raw entries, oldest last (the panel formats them). */
  recent: Record<string, unknown>[];
}

/** Read the ledger file (missing/unreadable → empty) and aggregate.
 * Read-only: for the gzero panel's router section. */
export function summarizeLedger(path = DEFAULT_LEDGER_PATH, limit = 6): LedgerSummary {
  const entries: Record<string, unknown>[] = [];
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // no ledger yet
  }
  const byKind: Record<string, number> = {};
  const routesByType: Record<string, number> = {};
  let dispatchOk = 0;
  let dispatchFailed = 0;
  for (const e of entries) {
    const kind = typeof e.kind === "string" ? e.kind : "?";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === "route") {
      const wt = typeof e.workType === "string" ? e.workType : "unclassified";
      routesByType[wt] = (routesByType[wt] ?? 0) + 1;
    } else if (kind === "dispatch") {
      if (e.ok === true) dispatchOk++;
      else dispatchFailed++;
    }
  }
  return { total: entries.length, byKind, routesByType, dispatchOk, dispatchFailed, recent: entries.slice(-limit) };
}

export class Ledger {
  private readonly path: string | null;

  /** null disables writing entirely. */
  constructor(path: string | null = DEFAULT_LEDGER_PATH) {
    this.path = path;
  }

  append(entry: Record<string, unknown>): void {
    if (!this.path) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      appendFileSync(this.path, line + "\n");
    } catch {
      // never let the ledger break a turn
    }
  }
}
