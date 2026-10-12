// Post-turn review hook — the pi version of hermes' background review
// (research/context/curation.md §3). A forked model call reviews batches of
// turns and saves durable facts to the bag, never touching the main
// conversation or its prompt cache: the call is fire-and-forget network I/O
// from a turn_end handler, so it runs concurrently with the next prompt.
//
// Cost model: every turn is captured into a pending list; one review covers
// the batch when the list reaches CX_REVIEW_BATCH (default 5; 1 = review
// every turn). Model: the session's model (CX_REVIEW=0 disables).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ReviewDeps {
  findCxMcp: () => Promise<string | null>;
  mcpCall: (cxMcp: string, tool: string, args: unknown) => Promise<string>;
}

interface ReviewSave {
  scope: "global" | "project";
  text: string;
  tags: string[];
}

/** Extract plain text from a message whose content is a string or parts. */
export function messageText(message: { role?: string; content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

function summarize(userText: string, assistantText: string, turnIndex: number): string | null {
  const u = userText.trim().slice(0, 1500);
  const a = assistantText.trim().slice(0, 2000);
  if (!u && !a) return null;
  return `### Turn ${turnIndex}\nUser: ${u || "(tool-driven turn)"}\nAssistant: ${a || "(no text)"}`;
}

function buildPrompt(known: string, turns: string[]): string {
  return `You are a background reviewer for a persistent memory system: a "context bag" of terse, tagged instruction atoms. Review the conversation turns below and decide whether any durable facts should be saved.

A fact belongs in the bag only if it applies beyond this task:
- WHO the user is or how they work → output scope "global"
- stable environment facts (tools, machines, setup) → scope "global"
- standing conventions of the current project → scope "project"
- task-specific learnings that may matter in this project later → scope "project", with a hashtag so it loads on demand

Do NOT save: task progress or status, one-off details, facts stale within a week, procedures or step-by-step workflows (those belong in skills), anything already covered by the known context below, trivia. When in doubt, do not save. Batch-consolidate: prefer one corrected atom over several near-duplicates.

Reply with EXACTLY "Nothing to save." or one line per fact, no other text:
- <scope>: <one terse declarative sentence> #tag1 #tag2

Known context (do not repeat any of it):
<known>
${known.trim() || "(empty)"}
</known>

Conversation turns:
<turns>
${turns.join("\n\n")}
</turns>`;
}

function parseSaves(text: string): ReviewSave[] {
  const saves: ReviewSave[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s*(global|project):\s*(.+)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (!raw) continue;
    const tags = [...raw.matchAll(/#([a-zA-Z0-9_-]+)/g)].map((t) => t[1]);
    saves.push({ scope: m[1] as ReviewSave["scope"], text: raw, tags });
  }
  return saves;
}

export function registerReview(pi: ExtensionAPI, deps: ReviewDeps): void {
  let lastUserText = "";
  let pending: string[] = [];
  let busy = false;
  let turnIndex = 0;

  pi.on("session_start", async () => {
    pending = [];
    turnIndex = 0;
  });

  pi.on("message_start", async (event) => {
    if ((event.message as { role?: string }).role === "user") {
      lastUserText = messageText(event.message as { content?: unknown });
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (process.env.CX_REVIEW === "0") return;
    turnIndex += 1;
    const assistantText = messageText(event.message as { content?: unknown });
    const summary = summarize(lastUserText, assistantText, turnIndex);
    lastUserText = "";
    if (!summary) return;
    pending.push(summary);
    const batch = Math.max(1, Number(process.env.CX_REVIEW_BATCH ?? 5) || 5);
    if (busy || pending.length < batch) return;
    const turns = pending.splice(0);
    busy = true;
    const run = review(turns, ctx, deps)
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
    if (ctx.mode !== "tui") {
      // Headless/RPC runs exit after the turn — an unawaited review would
      // be cut off. Interactive stays fire-and-forget.
      await run;
    }
  });
}

async function review(turns: string[], ctx: ExtensionContext, deps: ReviewDeps): Promise<void> {
  const model = ctx.model;
  if (!model) return;
  const cxMcp = await deps.findCxMcp();
  if (!cxMcp) return;

  let known = "";
  try {
    known = await deps.mcpCall(cxMcp, "resolve", {});
  } catch {
    // review without known context; the model errs on the side of not saving
  }

  const result = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        { role: "user", content: buildPrompt(known, turns), timestamp: Date.now() },
      ],
    },
    { maxTokens: 600 },
  );
  const reply = messageText(result);
  const saves = parseSaves(reply);
  if (saves.length === 0) return;

  for (const s of saves) {
    await deps.mcpCall(cxMcp, "add", {
      text: s.text,
      tags: s.tags.length > 0 ? s.tags.join(",") : undefined,
      scope: s.scope === "global" ? "global" : undefined,
    });
  }
  if (ctx.hasUI) {
    ctx.ui.notify(`review: saved ${saves.length} fact${saves.length === 1 ? "" : "s"} to the bag`, "info");
  }
}
