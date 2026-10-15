// ledger.ts — append-only JSONL usage ledger, the ai-harness-memory §3.6
// measurement-gate data: per-request input / cached / output tokens and cost,
// per classification, per route decision (with its cache implication), and
// per dispatch. Written locally, appended synchronously, and never allowed
// to break the turn: a ledger failure is swallowed.
//
// The "cacheEvent" on route entries is the proxy for §3.6's post-miss flag:
// a model switch means the next provider request re-prices its prefix.

import { appendFileSync } from "node:fs";
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
