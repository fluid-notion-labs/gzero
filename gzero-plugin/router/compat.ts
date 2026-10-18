// compat.ts — wire-format fixes for provider quirks that pi's
// openai-completions serialization doesn't cover.
//
// Workers AI's chat endpoint rejects assistant messages that carry
// tool_calls with content: null (the OpenAI standard allows it; Workers AI's
// schema requires a string). pi pushes content: null for tool-call-only
// assistant turns, so any multi-turn tool loop on a @cf/ model dies with
// "oneOf at '/' not met" on the second request. Replace null with "".
//
// If this gets fixed upstream in pi (a compat flag), this module shrinks to
// nothing.

export function fixAssistantNullContent(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (typeof p.model !== "string" || !p.model.startsWith("@cf/")) return payload;
  if (!Array.isArray(p.messages)) return payload;
  let changed = false;
  const messages = p.messages.map((m) => {
    if (
      m && typeof m === "object" &&
      (m as Record<string, unknown>).role === "assistant" &&
      Array.isArray((m as Record<string, unknown>).tool_calls) &&
      ((m as Record<string, unknown>).content === null || (m as Record<string, unknown>).content === undefined)
    ) {
      changed = true;
      return { ...(m as Record<string, unknown>), content: "" };
    }
    return m;
  });
  return changed ? { ...p, messages } : payload;
}
