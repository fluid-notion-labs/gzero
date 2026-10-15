// Tests for routing.ts: the decision matrix over classification outcomes,
// sticky behavior, and the direct-route threshold for the 32k tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config.ts";
import { decideRoute, estimateTokens } from "../routing.ts";

const state = { workType: "fix-errors" as const, provider: "cloudflare-workers-ai", id: "@cf/qwen/qwen3-30b-a3b-fp8" };

test("classified non-delegated type routes to its blessed model", () => {
  const d = decideRoute({ workType: "plan", state: undefined, hasSticky: false, estimateTokens: 5_000, config: DEFAULT_CONFIG });
  assert.equal(d.ref, DEFAULT_CONFIG.blessed.plan);
  assert.equal(d.workType, "plan");
  assert.equal(d.delegationSuggested, false);
});

test("classified delegated type under the threshold routes directly to qwen", () => {
  const d = decideRoute({ workType: "fix-errors", state: undefined, hasSticky: false, estimateTokens: DEFAULT_CONFIG.delegation.directRouteMaxTokens - 1, config: DEFAULT_CONFIG });
  assert.equal(d.ref, DEFAULT_CONFIG.blessed["fix-errors"]);
  assert.equal(d.delegationSuggested, false);
});

test("classified delegated type over the threshold stays sticky and suggests delegation", () => {
  const d = decideRoute({ workType: "fix-errors", state, hasSticky: true, estimateTokens: DEFAULT_CONFIG.delegation.directRouteMaxTokens + 1, config: DEFAULT_CONFIG });
  assert.equal(d.ref, "sticky");
  assert.equal(d.workType, "fix-errors");
  assert.equal(d.delegationSuggested, true);
});

test("classified delegated type over threshold without sticky falls back to default", () => {
  const d = decideRoute({ workType: "fix-warnings", state: undefined, hasSticky: false, estimateTokens: DEFAULT_CONFIG.delegation.directRouteMaxTokens + 1, config: DEFAULT_CONFIG });
  assert.equal(d.ref, DEFAULT_CONFIG.default);
  assert.equal(d.delegationSuggested, true);
});

test("unclassified turn stays sticky; without sticky uses the default model", () => {
  const sticky = decideRoute({ workType: null, state, hasSticky: true, estimateTokens: 100, config: DEFAULT_CONFIG });
  assert.equal(sticky.ref, "sticky");
  assert.equal(sticky.workType, "fix-errors");

  const fresh = decideRoute({ workType: null, state: undefined, hasSticky: false, estimateTokens: 100, config: DEFAULT_CONFIG });
  assert.equal(fresh.ref, DEFAULT_CONFIG.default);
  assert.equal(fresh.workType, null);
  assert.equal(fresh.delegationSuggested, false);
});

test("estimateTokens counts strings and text blocks, ignores other shapes", () => {
  const messages = [
    { content: "12345678" }, // 8 chars
    { content: [{ type: "text", text: "12345678" }] }, // 8 chars
    { content: [{ type: "image", data: "xxxx" }] }, // ignored
    { content: null },
  ];
  // 16 chars / 4
  assert.equal(estimateTokens(messages as never), 4);
});
