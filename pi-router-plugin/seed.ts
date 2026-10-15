// seed.ts — build the fresh-context brief for a delegated subagent.
//
// This is the brief composer of the router: deterministic, cheap, composed
// once per dispatch, then frozen. The subagent gets the diagnostics verbatim
// plus extracted file spans, and pulls further files itself via its own
// read/grep tools — no parsing of the codebase on our side.
//
// v1 diagnostic parsing handles rendered rustc/cargo output (`--> path:line:col`
// spans, error/warning headers). cargo's `--message-format=json` and other
// languages come later; when nothing parses, the raw output rides along.

import type { RouterConfig, WorkType } from "./config.ts";

/** Cap on the verbatim diagnostics block included in the seed (tail is kept). */
export const OUTPUT_CAP = 8_000;

export interface Span {
  path: string;
  line: number;
  column?: number;
}

/**
 * Extract `--> path:line[:col]` spans from rendered compiler/diagnostic
 * output. Deduplicated, first-seen order. Returns [] when the output has
 * no spans (the caller then relies on the raw text alone).
 */
export function extractSpans(text: string): Span[] {
  const spans: Span[] = [];
  const seen = new Set<string>();
  const re = /-->[ \t]+([^\s:]+):(\d+):(\d+)/g;
  for (const match of text.matchAll(re)) {
    const [, path, line, column] = match;
    if (!path || path.length > 4096) continue;
    const key = `${path}:${line}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({ path, line: Number(line), column: Number(column) });
  }
  return spans;
}

/** Distinct span paths in first-seen order. */
export function spanPaths(spans: Span[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const span of spans) {
    if (seen.has(span.path)) continue;
    seen.add(span.path);
    out.push(span.path);
  }
  return out;
}

/** Keep the tail of an output blob, preferring the most recent content. */
export function capTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const clipped = text.slice(text.length - cap);
  // start on a line boundary so the first entry isn't mangled
  const newline = clipped.indexOf("\n");
  return newline === -1 ? clipped : clipped.slice(newline + 1);
}

export interface SeedInput {
  workType: WorkType;
  /** Verbatim diagnostics/tool output the dispatch was triggered from (already tail-capped by the caller if desired). */
  recentOutput: string;
  cwd: string;
  config: RouterConfig;
  /** Extra context lines appended after the diagnostics (caller-supplied task statement). */
  taskStatement?: string;
}

const ROLE_LINE: Record<WorkType, string> = {
  plan: "Draft a plan: steps, sequencing, open questions. Do not start implementing.",
  research: "Answer the question from the code. Read what you need; do not modify files.",
  architect: "Sketch the design: modules, boundaries, data flow. Do not implement.",
  "medium-codefix": "Implement the change. It is localized but non-trivial; add or adjust tests where they exist.",
  "easy-codefix": "Make the small, obvious change. No extra refactoring.",
  "fix-warnings": "Clear the compiler/linter warnings shown below. Do not change unrelated code.",
  "fix-errors": "Fix the errors shown below. Minimal, correct changes; do not redesign while debugging.",
};

export function buildSeed(input: SeedInput): string {
  const spans = extractSpans(input.recentOutput);
  const paths = spanPaths(spans);
  const tools = input.config.delegation.subagentTools.join(",");
  const model = input.config.blessed[input.workType];
  const lines: string[] = [];

  lines.push(`You are a fresh dispatch working in ${input.cwd}. Work type: ${input.workType}.`);
  lines.push(`Role: ${ROLE_LINE[input.workType]}`);
  lines.push("");
  if (input.taskStatement) {
    lines.push(input.taskStatement.trim());
    lines.push("");
  }
  lines.push("Diagnostics / recent tool output (verbatim):");
  lines.push("<output>");
  lines.push(capTail(input.recentOutput, OUTPUT_CAP));
  lines.push("</output>");
  if (paths.length > 0) {
    lines.push("");
    lines.push("Locations referenced by the diagnostics:");
    for (const path of paths) lines.push(`- ${path}`);
  }
  lines.push("");
  lines.push("Rules:");
  lines.push(`- Pull only the files you need with your tools (${tools}), then do the work.`);
  lines.push("- Don't restate the problem or narrate; work.");
  lines.push("- Final response: a short structured summary — what was done, files touched, remaining issues.");
  lines.push("");
  lines.push(`(dispatch metadata: model ${model.provider}/${model.id})`);
  return lines.join("\n");
}
