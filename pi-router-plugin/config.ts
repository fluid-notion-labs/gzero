// config.ts — the router's configuration: which model is blessed for each
// work type, which classifier decides the work type, and how delegation to
// the fresh-context subagent behaves.
//
// Deliberately free of pi imports: pure loading/validation/merge so the
// tests run without the harness. Defaults encode the decisions recorded in
// the model-router workflow section (glm tier / qwen tier, clef-flash).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkType =
  | "plan"
  | "research"
  | "architect"
  | "medium-codefix"
  | "easy-codefix"
  | "fix-warnings"
  | "fix-errors";

export const WORK_TYPES: readonly WorkType[] = [
  "plan",
  "research",
  "architect",
  "medium-codefix",
  "easy-codefix",
  "fix-warnings",
  "fix-errors",
];

/** Qwen tier: work types dispatched to the fresh-context subagent (32k model). */
export const DELEGATED_TYPES: readonly WorkType[] = [
  "easy-codefix",
  "fix-warnings",
  "fix-errors",
];

export interface ModelRef {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

export interface RouterConfig {
  classifier: { provider: string; id: string; threshold: number };
  blessed: Record<WorkType, ModelRef>;
  default: ModelRef;
  delegation: {
    /** Below this estimated token count, route directly instead of delegating. */
    directRouteMaxTokens: number;
    /** Tools the headless subagent gets. */
    subagentTools: string[];
    /** pi binary the subagent runs through. */
    piCommand: string;
    /** Hard wall-clock limit for one dispatch. */
    dispatchTimeoutMs: number;
  };
}

const GLM: ModelRef = { provider: "cloudflare-workers-ai", id: "@cf/zai-org/glm-5.3-flash" };
const QWEN: ModelRef = { provider: "cloudflare-workers-ai", id: "@cf/qwen/qwen3-30b-a3b-fp8" };

export const DEFAULT_CONFIG: RouterConfig = {
  classifier: { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef-flash", threshold: 0.5 },
  blessed: {
    plan: GLM,
    research: GLM,
    architect: GLM,
    "medium-codefix": GLM,
    "easy-codefix": QWEN,
    "fix-warnings": QWEN,
    "fix-errors": QWEN,
  },
  default: GLM,
  delegation: {
    directRouteMaxTokens: 24_000,
    subagentTools: ["read", "grep", "find", "ls", "edit", "write"],
    piCommand: "pi",
    dispatchTimeoutMs: 600_000,
  },
};

/** Config as it may come from a file: every section and key optional. */
export type PartialConfig = {
  classifier?: Partial<RouterConfig["classifier"]>;
  blessed?: Partial<Record<WorkType, Partial<ModelRef>>>;
  default?: Partial<ModelRef>;
  delegation?: Partial<RouterConfig["delegation"]>;
};

const TOP_LEVEL_KEYS = new Set(["classifier", "blessed", "default", "delegation"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelRef(value: unknown, where: string): Partial<ModelRef> {
  if (!isPlainObject(value)) throw new Error(`${where}: expected an object`);
  const known = new Set(["provider", "id", "thinkingLevel"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`${where}: unknown key "${key}" (expected provider, id, thinkingLevel)`);
  }
  for (const key of ["provider", "id"] as const) {
    const v = value[key];
    if (v !== undefined && (typeof v !== "string" || v.length === 0)) {
      throw new Error(`${where}: "${key}" must be a non-empty string`);
    }
  }
  if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") {
    throw new Error(`${where}: "thinkingLevel" must be a string`);
  }
  return value as Partial<ModelRef>;
}

/** Parse and validate a config file's text. Throws with `where` in the message on any problem. */
export function parseConfig(text: string, where: string): PartialConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: invalid JSON — ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new Error(`${where}: expected a JSON object`);

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`${where}: unknown key "${key}" (expected ${[...TOP_LEVEL_KEYS].join(", ")})`);
  }

  const out: PartialConfig = {};

  if (raw.classifier !== undefined) {
    if (!isPlainObject(raw.classifier)) throw new Error(`${where}: classifier: expected an object`);
    const c = raw.classifier as Record<string, unknown>;
    for (const key of Object.keys(c)) {
      if (!["provider", "id", "threshold"].includes(key)) throw new Error(`${where}: classifier: unknown key "${key}"`);
    }
    const entry: PartialConfig["classifier"] = {};
    if (c.provider !== undefined) {
      if (typeof c.provider !== "string" || c.provider.length === 0) throw new Error(`${where}: classifier.provider must be a non-empty string`);
      entry.provider = c.provider;
    }
    if (c.id !== undefined) {
      if (typeof c.id !== "string" || c.id.length === 0) throw new Error(`${where}: classifier.id must be a non-empty string`);
      entry.id = c.id;
    }
    if (c.threshold !== undefined) {
      if (typeof c.threshold !== "number" || !(c.threshold >= 0 && c.threshold <= 1)) {
        throw new Error(`${where}: classifier.threshold must be a number between 0 and 1`);
      }
      entry.threshold = c.threshold;
    }
    out.classifier = entry;
  }

  if (raw.blessed !== undefined) {
    if (!isPlainObject(raw.blessed)) throw new Error(`${where}: blessed: expected an object`);
    const blessed: NonNullable<PartialConfig["blessed"]> = {};
    for (const [type, value] of Object.entries(raw.blessed)) {
      if (!WORK_TYPES.includes(type as WorkType)) {
        throw new Error(`${where}: blessed: unknown work type "${type}" (expected ${WORK_TYPES.join(", ")})`);
      }
      blessed[type as WorkType] = parseModelRef(value, `${where}: blessed.${type}`);
    }
    out.blessed = blessed;
  }

  if (raw.default !== undefined) out.default = parseModelRef(raw.default, `${where}: default`);

  if (raw.delegation !== undefined) {
    if (!isPlainObject(raw.delegation)) throw new Error(`${where}: delegation: expected an object`);
    const d = raw.delegation as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (!["directRouteMaxTokens", "subagentTools", "piCommand", "dispatchTimeoutMs"].includes(key)) {
        throw new Error(`${where}: delegation: unknown key "${key}"`);
      }
    }
    const entry: PartialConfig["delegation"] = {};
    if (d.directRouteMaxTokens !== undefined) {
      if (typeof d.directRouteMaxTokens !== "number" || !Number.isFinite(d.directRouteMaxTokens) || d.directRouteMaxTokens < 0) {
        throw new Error(`${where}: delegation.directRouteMaxTokens must be a non-negative number`);
      }
      entry.directRouteMaxTokens = d.directRouteMaxTokens;
    }
    if (d.subagentTools !== undefined) {
      if (!Array.isArray(d.subagentTools) || d.subagentTools.some((t) => typeof t !== "string" || t.length === 0)) {
        throw new Error(`${where}: delegation.subagentTools must be an array of non-empty strings`);
      }
      entry.subagentTools = d.subagentTools as string[];
    }
    if (d.piCommand !== undefined) {
      if (typeof d.piCommand !== "string" || d.piCommand.length === 0) throw new Error(`${where}: delegation.piCommand must be a non-empty string`);
      entry.piCommand = d.piCommand;
    }
    if (d.dispatchTimeoutMs !== undefined) {
      if (typeof d.dispatchTimeoutMs !== "number" || !Number.isFinite(d.dispatchTimeoutMs) || d.dispatchTimeoutMs <= 0) {
        throw new Error(`${where}: delegation.dispatchTimeoutMs must be a positive number`);
      }
      entry.dispatchTimeoutMs = d.dispatchTimeoutMs;
    }
    out.delegation = entry;
  }

  return out;
}

function mergeModelRef(base: ModelRef, patch: Partial<ModelRef> | undefined): ModelRef {
  if (!patch) return base;
  return { ...base, ...patch };
}

/** Merge a validated partial config over a base config. Sections merge per key. */
export function mergeConfig(base: RouterConfig, patch: PartialConfig): RouterConfig {
  return {
    classifier: patch.classifier ? { ...base.classifier, ...patch.classifier } : base.classifier,
    blessed: patch.blessed
      ? { ...base.blessed, ...Object.fromEntries(Object.entries(patch.blessed).map(([k, v]) => [k, mergeModelRef(base.blessed[k as WorkType], v)])) }
      : base.blessed,
    default: mergeModelRef(base.default, patch.default),
    delegation: patch.delegation ? { ...base.delegation, ...patch.delegation } : base.delegation,
  };
}

/**
 * Load the router config: built-in defaults, then the global file
 * (~/.pi/agent/pi-router.json), then the repo file (<cwd>/.pi/pi-router.json).
 * Missing files are fine. Returns the merged config and the files applied, in
 * order. Pass explicit paths to override the defaults (tests do).
 */
export function loadRouterConfig(
  globalPath: string = join(homedir(), ".pi", "agent", "pi-router.json"),
  repoPath: string = join(process.cwd(), ".pi", "pi-router.json"),
): { config: RouterConfig; sources: string[] } {
  let config = DEFAULT_CONFIG;
  const sources: string[] = [];
  for (const path of [globalPath, repoPath]) {
    if (!existsSync(path)) continue;
    const patch = parseConfig(readFileSync(path, "utf8"), path);
    config = mergeConfig(config, patch);
    sources.push(path);
  }
  return { config, sources };
}
