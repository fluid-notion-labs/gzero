// Tests for config.ts: defaults encode the model-router decisions (glm tier
// for plan/research/architect/medium-codefix, qwen tier for the delegated
// types), merge order is global then repo, and validation fails loudly on
// typos — a mistyped work type must not silently route nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, DELEGATED_TYPES, WORK_TYPES, loadRouterConfig, mergeConfig, parseConfig } from "../router/config.ts";

test("defaults bless glm for the four keep-in-place types and qwen for the delegated types", () => {
  const glm = "cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash";
  for (const type of ["plan", "research", "architect", "medium-codefix"] as const) {
    assert.equal(`${DEFAULT_CONFIG.blessed[type].provider}/${DEFAULT_CONFIG.blessed[type].id}`, glm, type);
  }
  const qwen = "cloudflare-workers-ai/@cf/qwen/qwen3-30b-a3b-fp8";
  for (const type of DELEGATED_TYPES) {
    assert.equal(`${DEFAULT_CONFIG.blessed[type].provider}/${DEFAULT_CONFIG.blessed[type].id}`, qwen, type);
  }
  assert.equal(DELEGATED_TYPES.length, 3);
});

test("defaults cover every work type; classifier is clef-flash with threshold 0.5", () => {
  for (const type of WORK_TYPES) assert.ok(DEFAULT_CONFIG.blessed[type], type);
  assert.equal(DEFAULT_CONFIG.classifier.id, "@cf/cloudflare/clef-flash");
  assert.equal(DEFAULT_CONFIG.classifier.threshold, 0.5);
  assert.deepEqual(DEFAULT_CONFIG.delegation.subagentTools, ["read", "grep", "find", "ls", "edit", "write"]);
});

test("parseConfig accepts a valid partial config", () => {
  const cfg = parseConfig(
    JSON.stringify({
      classifier: { threshold: 0.7 },
      blessed: { "easy-codefix": { id: "@cf/qwen/qwen3.8-27b" } },
      default: { provider: "openai", id: "gpt-5.2-mini", thinkingLevel: "low" },
      delegation: { directRouteMaxTokens: 10_000 },
    }),
    "test",
  );
  assert.equal(cfg.classifier?.threshold, 0.7);
  assert.equal(cfg.blessed?.["easy-codefix"]?.id, "@cf/qwen/qwen3.8-27b");
  assert.equal(cfg.default?.thinkingLevel, "low");
});

test("parseConfig rejects unknown top-level keys, work types, and model keys", () => {
  assert.throws(() => parseConfig('{"blessedx":{}}', "f.json"), /unknown key "blessedx"/);
  assert.throws(() => parseConfig('{"blessed":{"easyfix":{}}}', "f.json"), /unknown work type "easyfix"/);
  assert.throws(() => parseConfig('{"blessed":{"plan":{"id":"x","model":"y"}}}', "f.json"), /unknown key "model"/);
});

test("parseConfig validates value shapes", () => {
  assert.throws(() => parseConfig('{"classifier":{"threshold":1.5}}', "f.json"), /threshold/);
  assert.throws(() => parseConfig('{"classifier":{"threshold":"high"}}', "f.json"), /threshold/);
  assert.throws(() => parseConfig('{"default":{"provider":""}}', "f.json"), /provider/);
  assert.throws(() => parseConfig('{"delegation":{"subagentTools":["read",42]}}', "f.json"), /subagentTools/);
  assert.throws(() => parseConfig("{not json", "f.json"), /invalid JSON/);
  assert.throws(() => parseConfig('["array"]', "f.json"), /expected a JSON object/);
});

test("mergeConfig overlays per key without losing unspecified entries", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, parseConfig('{"blessed":{"fix-errors":{"id":"other-qwen"}}}', "t"));
  assert.equal(merged.blessed["fix-errors"].id, "other-qwen");
  assert.equal(merged.blessed["fix-errors"].provider, "cloudflare-workers-ai");
  assert.equal(merged.blessed["easy-codefix"].id, "@cf/qwen/qwen3-30b-a3b-fp8");
  assert.equal(merged.classifier.id, "@cf/cloudflare/clef-flash");
});

test("loadRouterConfig: missing files yield defaults and no sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cfg-"));
  const { config, sources } = loadRouterConfig(join(dir, "missing.json"), join(dir, "also-missing.json"));
  assert.deepEqual(sources, []);
  assert.equal(config.classifier.threshold, DEFAULT_CONFIG.classifier.threshold);
});

test("loadRouterConfig: global applies first, repo overrides it, sources recorded in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cfg-"));
  mkdirSync(join(dir, ".pi"));
  const globalPath = join(dir, "global.json");
  const repoPath = join(dir, ".pi", "pi-router.json");
  writeFileSync(globalPath, JSON.stringify({ classifier: { threshold: 0.6 }, blessed: { plan: { id: "from-global" } } }));
  writeFileSync(repoPath, JSON.stringify({ blessed: { plan: { id: "from-repo" }, "easy-codefix": { id: "repo-qwen" } } }));
  const { config, sources } = loadRouterConfig(globalPath, repoPath);
  assert.deepEqual(sources, [globalPath, repoPath]);
  assert.equal(config.classifier.threshold, 0.6);
  assert.equal(config.blessed.plan.id, "from-repo");
  assert.equal(config.blessed["easy-codefix"].id, "repo-qwen");
  assert.equal(config.blessed.research.id, "@cf/zai-org/glm-5.3-flash");
});
