// delegate.ts — dispatch a work item to the fresh-context subagent: a
// headless one-shot pi running the blessed model for the work type.
//
// The subagent never sees the parent conversation (brief in, result up one
// edge). Its edits land directly in the shared working tree; its final text
// comes back as a structured tool-result-style payload for the spine.
//
// The runner is injectable so tests never spawn a real process.

import { spawn } from "node:child_process";
import type { RouterConfig, WorkType } from "./config.ts";

export interface DispatchPlan {
  command: string;
  args: string[];
  /** "provider/id" of the blessed model, for ledger/metadata. */
  model: string;
}

/** Build the pi argv for a one-shot dispatch. The seed must be the last arg. */
export function buildDispatch(opts: {
  workType: WorkType;
  seed: string;
  config: RouterConfig;
  /** Loaded via -e so the subagent gets the same compat fixes. */
  extensionPath?: string;
}): DispatchPlan {
  const model = opts.config.blessed[opts.workType];
  const modelId = `${model.provider}/${model.id}`;
  const args = [
    "--print",
    "--no-session",
    "--model",
    modelId,
    "--tools",
    opts.config.delegation.subagentTools.join(","),
  ];
  if (opts.extensionPath) args.push("-e", opts.extensionPath);
  if (model.thinkingLevel) args.push("--thinking-level", model.thinkingLevel);
  args.push(opts.seed);
  return { command: opts.config.delegation.piCommand, args, model: modelId };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

export type Runner = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

/** Default runner: spawn the process, collect output, kill on timeout or abort. */
export const spawnRunner: Runner = (command, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      spawnError = err.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, timedOut, spawnError });
    });
  });

export interface DispatchResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The subagent's final text (its structured summary). */
  summary: string;
  stderrTail: string;
  model: string;
  durationMs: number;
}

export async function dispatchWork(opts: {
  plan: DispatchPlan;
  cwd: string;
  config: RouterConfig;
  runner?: Runner;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const run = opts.runner ?? spawnRunner;
  const started = Date.now();
  const result = await run(opts.plan.command, opts.plan.args, {
    cwd: opts.cwd,
    timeoutMs: opts.config.delegation.dispatchTimeoutMs,
    signal: opts.signal,
  });
  const durationMs = Date.now() - started;
  const summary = result.stdout.trim();
  const ok = !result.timedOut && !result.spawnError && result.code === 0 && summary.length > 0;
  return {
    ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    summary,
    stderrTail: result.stderr.length > 2000 ? result.stderr.slice(-2000) : result.stderr,
    model: opts.plan.model,
    durationMs,
  };
}

/** The payload returned up the edge — structured, brief-digest shaped. */
export function formatDispatchResult(result: DispatchResult): string {
  const status = result.ok ? "ok" : result.timedOut ? "timeout" : "failed";
  const lines = [
    "<dispatch-result>",
    `status: ${status}`,
    `model: ${result.model}`,
    `duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    "<summary>",
    result.summary || "(empty)",
    "</summary>",
  ];
  if (!result.ok) {
    lines.push("<stderr>");
    lines.push(result.stderrTail || "(none)");
    lines.push("</stderr>");
  }
  lines.push("</dispatch-result>");
  return lines.join("\n");
}
