// routing.ts — the pure route decision, extracted from the extension entry
// so it can be tested without the harness. The entry resolves ModelRefs to
// catalog models and does the classify call; this module decides where a
// turn goes.
//
// Invariants (from the model-router section + ai-harness-memory cache rules):
// - continuations/retries never switch models (prompt cache stays valid)
// - the qwen tier's 32k window is never handed a session estimated larger
//   than directRouteMaxTokens — instead the current/default model keeps the
//   turn and delegation via delegate_fix is suggested
// - unclassified or low-confidence turns stay put when a model is already
//   running, else fall back to the default model

import { DELEGATED_TYPES, type ModelRef, type RouterConfig, type WorkType } from "./config.ts";

export interface RouterState {
  workType: WorkType | null;
  provider: string;
  id: string;
  delegationSuggested?: boolean;
}

/** `"sticky"` = keep whatever model the session already runs. */
export type RouteDecision = {
  ref: ModelRef | "sticky";
  workType: WorkType | null;
  delegationSuggested: boolean;
};

export function decideRoute(opts: {
  /** Classified work type; null when unclassified or below threshold. */
  workType: WorkType | null;
  state: RouterState | undefined;
  hasSticky: boolean;
  estimateTokens: number;
  config: RouterConfig;
}): RouteDecision {
  if (opts.workType === null) {
    if (opts.hasSticky) return { ref: "sticky", workType: opts.state?.workType ?? null, delegationSuggested: false };
    return { ref: opts.config.default, workType: null, delegationSuggested: false };
  }

  if (DELEGATED_TYPES.includes(opts.workType) && opts.estimateTokens > opts.config.delegation.directRouteMaxTokens) {
    // Too big for the 32k window: keep the session where it is (or default),
    // and let the delegate_fix tool carry the actual work.
    if (opts.hasSticky) {
      return { ref: "sticky", workType: opts.workType, delegationSuggested: true };
    }
    return { ref: opts.config.default, workType: opts.workType, delegationSuggested: true };
  }

  return { ref: opts.config.blessed[opts.workType], workType: opts.workType, delegationSuggested: false };
}

/** Crude token estimate: all text content across messages, chars/4. */
export function estimateTokens(messages: readonly { content: unknown }[]): number {
  let chars = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
          chars += (block as { text: string }).text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
