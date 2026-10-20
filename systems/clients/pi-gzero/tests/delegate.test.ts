// Tests for delegate.ts: command construction, dispatch via an injected
// runner (no real processes), and the structured result format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../router/config.ts";
import { buildDispatch, dispatchWork, formatDispatchResult, type Runner } from "../router/delegate.ts";
import { buildSeed } from "../router/seed.ts";

const SEED = buildSeed({ workType: "fix-errors", recentOutput: "boom", cwd: "/repo", config: DEFAULT_CONFIG });

test("buildDispatch: one-shot pi with the blessed model, tools, seed last", () => {
  const plan = buildDispatch({ workType: "fix-errors", seed: SEED, config: DEFAULT_CONFIG });
  assert.equal(plan.command, "pi");
  assert.equal(plan.model, "cloudflare-workers-ai/@cf/qwen/qwen3-30b-a3b-fp8");
  assert.deepEqual(plan.args.slice(0, 6), ["--print", "--no-session", "--model", plan.model, "--tools", "read,grep,find,ls,edit,write"]);
  assert.equal(plan.args[plan.args.length - 1], SEED);
  assert.equal(plan.args.length, 7);
});

test("buildDispatch: glm-tier work type also dispatchable (direct route fallback case)", () => {
  const plan = buildDispatch({ workType: "plan", seed: "s", config: DEFAULT_CONFIG });
  assert.equal(plan.model, "cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash");
});

test("buildDispatch passes thinking level when the model ref has one", () => {
  const config = { ...DEFAULT_CONFIG, blessed: { ...DEFAULT_CONFIG.blessed, "fix-errors": { ...DEFAULT_CONFIG.blessed["fix-errors"], thinkingLevel: "low" } } };
  const plan = buildDispatch({ workType: "fix-errors", seed: "s", config });
  assert.ok(plan.args.includes("--thinking-level"));
  assert.equal(plan.args[plan.args.indexOf("--thinking-level") + 1], "low");
});

function runnerFrom(result: Partial<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError: string }>): { runner: Runner; seen: { cwd: string; timeoutMs: number }[] } {
  const seen: { cwd: string; timeoutMs: number }[] = [];
  return {
    seen,
    runner: async (_command, _args, opts) => {
      seen.push({ cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { stdout: "", stderr: "", code: 0, timedOut: false, ...result };
    },
  };
}

test("dispatchWork: success returns the summary and the run context", async () => {
  const { runner, seen } = runnerFrom({ stdout: "  fixed the thing  \n", code: 0 });
  const result = await dispatchWork({ plan: buildDispatch({ workType: "fix-errors", seed: SEED, config: DEFAULT_CONFIG }), cwd: "/repo", config: DEFAULT_CONFIG, runner });
  assert.equal(result.ok, true);
  assert.equal(result.summary, "fixed the thing");
  assert.equal(result.model, "cloudflare-workers-ai/@cf/qwen/qwen3-30b-a3b-fp8");
  assert.equal(seen[0].cwd, "/repo");
  assert.equal(seen[0].timeoutMs, DEFAULT_CONFIG.delegation.dispatchTimeoutMs);
});

test("dispatchWork: timeout and non-zero exit and empty output are not ok", async () => {
  for (const failure of [{ timedOut: true, code: null }, { code: 1, stderr: "crash" }, { stdout: "   " }]) {
    const { runner } = runnerFrom(failure);
    const result = await dispatchWork({ plan: buildDispatch({ workType: "fix-errors", seed: SEED, config: DEFAULT_CONFIG }), cwd: "/repo", config: DEFAULT_CONFIG, runner });
    assert.equal(result.ok, false, JSON.stringify(failure));
  }
});

test("formatDispatchResult: ok result is compact and carries the summary", () => {
  const text = formatDispatchResult({ ok: true, exitCode: 0, timedOut: false, summary: "done", stderrTail: "", model: "m/x", durationMs: 1234 });
  assert.match(text, /status: ok/);
  assert.match(text, /model: m\/x/);
  assert.match(text, /duration: 1\.2s/);
  assert.match(text, /<summary>\ndone\n<\/summary>/);
  assert.doesNotMatch(text, /<stderr>/);
});

test("formatDispatchResult: failed result includes stderr, timeout status", () => {
  const text = formatDispatchResult({ ok: false, exitCode: null, timedOut: true, summary: "", stderrTail: "killed", model: "m/x", durationMs: 600000 });
  assert.match(text, /status: timeout/);
  assert.match(text, /<stderr>\nkilled\n<\/stderr>/);
});
