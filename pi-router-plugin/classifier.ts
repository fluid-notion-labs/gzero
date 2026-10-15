// classifier.ts — classify a user turn into one of the seven work types with
// a Clef/Jev classifier model. Pure logic lives here; the caller injects the
// classify function (ModelRegistry.classify in production, a fake in tests),
// so this module never touches the harness.

import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { WORK_TYPES, type WorkType } from "./config.ts";

/** Prompt text handed to the classifier, truncated to this many characters. */
export const PROMPT_SLICE = 16_000;
/** Tail of recent tool results, so fix-warnings/fix-errors don't rely on the prompt alone. */
export const TOOL_TAIL_SLICE = 4_000;

export interface ClassifierState {
  prompt: string;
  recentToolOutput: string;
  lastWorkType: WorkType | null;
}

function slice(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export function buildClassifierState(input: {
  prompt: string;
  recentToolOutput?: string;
  lastWorkType?: WorkType | null;
}): ClassifierState {
  return {
    prompt: slice(input.prompt, PROMPT_SLICE),
    recentToolOutput: slice(input.recentToolOutput ?? "", TOOL_TAIL_SLICE),
    lastWorkType: input.lastWorkType ?? null,
  };
}

/** What each choice means, phrased for the classifier. */
export const WORK_TYPE_CRITERIA: Record<WorkType, string> = {
  plan: "The user asks to plan upcoming work: propose steps, sequencing, or an approach before doing it",
  research: "Read, understand, or explain; questions about how things work; no intent to change code",
  architect: "Design or restructure across modules or systems: new components, APIs, data flow, boundaries",
  "medium-codefix": "Fix or implement something localized but non-trivial: real logic changes, tests, or refactors",
  "easy-codefix": "A small, obvious change: one-liners, renames, typos, copy tweaks, config values",
  "fix-warnings": "Clear compiler or linter warnings to clean up; the recent tool output shows warnings",
  "fix-errors": "Compile or runtime errors to fix; the recent tool output shows errors, or the user reports a failure",
};

export const WORK_TYPE_QUESTION = {
  type: "choice",
  instructions:
    "Classify the software-engineering work now being requested, given the user's prompt, the tail of recent " +
    "tool output, and the work type of the previous turn. If the prompt is a short continuation like " +
    "\"ok, next one\" or \"go ahead\", keep the previous work type. Judge by intent, not by phrasing politeness.",
  criteria: WORK_TYPE_CRITERIA,
} as const;

export interface WorkClassification {
  /** Null when the result is unusable (error, non-choice answer, below threshold) — caller falls back. */
  workType: WorkType | null;
  probabilities: Partial<Record<WorkType, number>>;
  confidence: number;
  raw: ClassifierResult | null;
}

export type ClassifyFn = (
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options?: { signal?: AbortSignal },
) => Promise<ClassifierResult>;

/**
 * Run the classification and interpret it: pick the highest-probability known
 * work type, return null when the classifier errored, answered off-type, or
 * the top probability is under `threshold` (caller uses its default model).
 */
export async function classifyWorkType(
  classify: ClassifyFn,
  model: ClassifierModel<ClassifierApi>,
  state: ClassifierState,
  opts: { threshold: number; signal?: AbortSignal },
): Promise<WorkClassification> {
  const context: ClassifierContext = {
    state: state as unknown as ClassifierContext["state"],
    questions: { workType: WORK_TYPE_QUESTION },
  };
  const result = await classify(model, context, { signal: opts.signal });
  if (result.stopReason !== "stop") {
    return { workType: null, probabilities: {}, confidence: 0, raw: result };
  }
  const answer = result.answers.workType;
  if (!answer || answer.type !== "choice") {
    return { workType: null, probabilities: {}, confidence: 0, raw: result };
  }
  const probabilities: Partial<Record<WorkType, number>> = {};
  let top: WorkType | null = null;
  let topProb = 0;
  for (const type of WORK_TYPES) {
    const p = answer.probabilities[type];
    if (typeof p === "number") {
      probabilities[type] = p;
      if (p > topProb) {
        top = type;
        topProb = p;
      }
    }
  }
  if (!top || topProb < opts.threshold) {
    return { workType: null, probabilities, confidence: topProb, raw: result };
  }
  return { workType: top, probabilities, confidence: topProb, raw: result };
}
