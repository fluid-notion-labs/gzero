// index.ts — pi-router-plugin extension entry.
//
// Registers the `router/auto` virtual model (classify each user turn into a
// work type with clef-flash, route to the blessed model), the delegate_fix
// tool (fresh-context subagent for the 32k qwen tier), the /router and
// /fixfresh commands, and footer status.
//
// Design decisions: gzero workflow section `model-router`. The harness
// context: /mnt/data/projects/explorations/research/ai-harness-memory/index.md.

import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fixAssistantNullContent } from "./compat.ts";
import { classifyWorkType, buildClassifierState, type ClassifyFn, type WorkClassification } from "./classifier.ts";
import { DELEGATED_TYPES, loadRouterConfig, WORK_TYPES, type RouterConfig, type WorkType } from "./config.ts";
import { buildDispatch, dispatchWork, formatDispatchResult, spawnRunner } from "./delegate.ts";
import { DEFAULT_LEDGER_PATH, Ledger, toUsageRecord } from "./ledger.ts";
import { buildSeed } from "./seed.ts";
import { decideRoute, estimateTokens, type RouterState } from "./routing.ts";

const PROVIDER = "router";
const ID = "auto";

/** This file's URL, so spawned subagents can load the same extension (for the compat fix). */
const extensionUrl = new URL(import.meta.url).pathname;

function lastUserText(messages: readonly Message[]): string {
  const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** Concatenated tail of tool results since the last user message (most recent last). */
function recentToolOutput(messages: readonly Message[]): string {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const parts: string[] = [];
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role !== "toolResult") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Workers AI quirk: assistant tool-call messages with content: null are
  // rejected — replace with "". Applies to parent and subagent alike.
  pi.on("before_provider_request", (event) => fixAssistantNullContent(event.payload));

  let config: RouterConfig = loadRouterConfig().config;
  let pinnedType: WorkType | null = null;
  let lastClassification: (WorkClassification & { workType: WorkType | null }) | null = null;
  const ledger = new Ledger(process.env.PI_ROUTER_LEDGER || DEFAULT_LEDGER_PATH);

  const setStatus = (ctx: ExtensionContext, text: string) => {
    ctx.ui.setStatus("router", text);
  };

  const describeRoute = (workType: WorkType | null, ref: string, delegated: boolean) =>
    workType ? `${workType} → ${ref}${delegated ? " (delegate suggested)" : ""}` : `unclassified → ${ref}`;

  pi.registerVirtualModel<RouterState>({
    provider: PROVIDER,
    id: ID,
    name: "Router (Clef)",
    async route(request, ctx) {
      // Outside the agent loop: default model, no state, no classification.
      if (request.reason === "direct") {
        return { model: resolveModel(ctx, config.default.provider, config.default.id), thinkingLevel: request.thinkingLevel };
      }

      const sticky = request.previous ?? (request.failed ? { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel } : undefined);

      // Continuations and retries never switch models (prompt cache stays valid).
      if (request.reason !== "user") {
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
        const state = request.state;
        if (state) return { model: resolveModel(ctx, state.provider, state.id), thinkingLevel: request.thinkingLevel };
        return { model: resolveModel(ctx, config.default.provider, config.default.id), thinkingLevel: request.thinkingLevel };
      }

      // User turn: classify (unless pinned).
      let workType: WorkType | null = pinnedType;
      if (workType === null) {
        const classifier = ctx.modelRegistry.findOfType("classifier", config.classifier.provider, config.classifier.id);
        if (!classifier) {
          lastClassification = null;
        } else {
          const state = buildClassifierState({
            prompt: lastUserText(request.messages),
            recentToolOutput: recentToolOutput(request.messages),
            lastWorkType: request.state?.workType ?? null,
          });
          const classify: ClassifyFn = (model, context, options) =>
            ctx.modelRegistry.classify(model as Parameters<ClassifyFn>[0], context, options as never);
          const classifyStart = Date.now();
          const result = await classifyWorkType(classify, classifier as never, state, {
            threshold: config.classifier.threshold,
            signal: request.signal,
          });
          lastClassification = result;
          workType = result.workType;
          ledger.append({
            kind: "classification",
            cwd: ctx.cwd,
            classifier: `${config.classifier.provider}/${config.classifier.id}`,
            workType: result.workType,
            confidence: result.confidence,
            usage: toUsageRecord(result.raw?.usage),
            durationMs: Date.now() - classifyStart,
          });
        }
      }

      const decision = decideRoute({
        workType,
        state: request.state,
        hasSticky: sticky !== undefined,
        estimateTokens: estimateTokens(request.messages),
        config,
      });

      // cacheEvent: switching models re-prices the next request's prefix;
      // sticky keeps it — the §3.6 post-miss proxy.
      ledger.append({
        kind: "route",
        cwd: ctx.cwd,
        workType: decision.workType,
        ref: decision.ref === "sticky" ? `sticky:${sticky?.model.provider}/${sticky?.model.id}` : `${decision.ref.provider}/${decision.ref.id}`,
        sticky: decision.ref === "sticky",
        cacheEvent: decision.ref === "sticky" && sticky ? "kept" : "switch",
        estimateTokens: estimateTokens(request.messages),
        delegationSuggested: decision.delegationSuggested,
      });

      let ref: typeof config.default;
      if (decision.ref === "sticky") {
        if (!sticky) throw new Error("router: sticky route without a previous model");
        setStatus(ctx, describeRoute(decision.workType, `${sticky.model.provider}/${sticky.model.id}`, decision.delegationSuggested));
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel, state: nextState(decision.workType, sticky.model.provider, sticky.model.id, decision.delegationSuggested, request.state) };
      }
      ref = decision.ref;
      const refId = `${ref.provider}/${ref.id}`;
      setStatus(ctx, describeRoute(decision.workType, refId, decision.delegationSuggested));
      return {
        model: resolveModel(ctx, ref.provider, ref.id),
        thinkingLevel: request.thinkingLevel,
        state: nextState(decision.workType, ref.provider, ref.id, decision.delegationSuggested, request.state),
      };
    },
  });

  function nextState(workType: WorkType | null, provider: string, id: string, delegated: boolean, prev: RouterState | undefined): RouterState {
    if (prev && prev.workType === workType && prev.provider === provider && prev.id === id && prev.delegationSuggested === delegated) {
      return prev; // unchanged → keep identity so pi doesn't churn state
    }
    return { workType, provider, id, delegationSuggested: delegated || undefined };
  }

  function resolveModel(ctx: ExtensionContext, provider: string, id: string) {
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) throw new Error(`router: model ${provider}/${id} is not in the catalog`);
    return model;
  }

  // ---- delegate_fix: the fresh-context subagent for the qwen tier ----

  pi.registerTool({
    name: "delegate_fix",
    label: "Delegate fix to fresh-context subagent",
    description:
      "Dispatch a small fix (easy codefix, compiler/linter warnings, or compile/runtime errors) to a fresh-context " +
      "subagent running the cheap model. The subagent gets only what you pass: the verbatim diagnostics and a task " +
      "statement — it pulls the files it needs itself and edits the working tree directly. Use this when the " +
      "conversation is long or the fix is mechanical; do not use it for design or multi-file work.",
    promptGuidelines: [
      "When the user asks to fix compiler/linter errors or warnings and the session is long, pass the verbatim " +
        "error output to delegate_fix instead of fixing in-session.",
    ],
    parameters: Type.Object({
      work_type: Type.Union(DELEGATED_TYPES.map((t) => Type.Literal(t)) as never, {
        description: "The kind of fix: easy-codefix, fix-warnings, or fix-errors",
      }),
      recent_output: Type.Optional(
        Type.String({ description: "Verbatim compiler/linter/test output the fix is about. Include it fully." }),
      ),
      task_statement: Type.Optional(
        Type.String({ description: "One or two sentences on what to accomplish, if the output alone is unclear." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const seed = buildSeed({
        workType: params.work_type,
        recentOutput: params.recent_output ?? "",
        cwd: ctx.cwd,
        config,
        taskStatement: params.task_statement,
      });
      const plan = buildDispatch({ workType: params.work_type, seed, config, extensionPath: extensionUrl });
      const result = await dispatchWork({ plan, cwd: ctx.cwd, config, runner: spawnRunner, signal });
      ledger.append({
        kind: "dispatch",
        cwd: ctx.cwd,
        workType: params.work_type,
        model: result.model,
        ok: result.ok,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        seedChars: seed.length,
        summaryChars: result.summary.length,
      });
      const text = formatDispatchResult(result);
      return {
        content: [{ type: "text", text }],
        details: { ok: result.ok, model: result.model, durationMs: result.durationMs, workType: params.work_type },
        isError: !result.ok,
      };
    },
  });

  // ---- commands ----

  pi.registerCommand("router", {
    description: "Show router status; `/router reload` reloads config; `/router <work-type>` pins a type; `/router clear` unpins",
    async handler(args, ctx) {
      const arg = args.trim();
      if (arg === "reload") {
        config = loadRouterConfig().config;
        ctx.ui.notify("router: config reloaded", "info");
        return;
      }
      if (arg === "clear") {
        pinnedType = null;
        ctx.ui.notify("router: pin cleared", "info");
        return;
      }
      if (arg) {
        if (!WORK_TYPES.includes(arg as WorkType)) {
          ctx.ui.notify(`router: unknown work type "${arg}" (expected ${WORK_TYPES.join(", ")})`, "error");
          return;
        }
        pinnedType = arg as WorkType;
        ctx.ui.notify(`router: pinned to ${pinnedType}`, "info");
        return;
      }
      const cls = lastClassification;
      const lines = [
        `pinned: ${pinnedType ?? "(none)"}`,
        `classifier: ${config.classifier.provider}/${config.classifier.id} (threshold ${config.classifier.threshold})`,
        `last classification: ${cls ? `${cls.workType ?? "unclassified"} (top p=${cls.confidence.toFixed(2)})` : "(none yet)"}`,
        `delegation threshold: ${config.delegation.directRouteMaxTokens} tokens`,
        `blessed: ${WORK_TYPES.map((t) => `${t}=${config.blessed[t].id}`).join(", ")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("fixfresh", {
    description: "Dispatch the given task statement to a fresh-context subagent now (/fixfresh <what to fix>)",
    async handler(args, ctx) {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("usage: /fixfresh <task statement>", "warning");
        return;
      }
      // A manual dispatch has no captured tool output; the task statement carries the context.
      const workType = pinnedType ?? "fix-errors";
      const seed = buildSeed({ workType, recentOutput: "", cwd: ctx.cwd, config, taskStatement: task });
      const plan = buildDispatch({ workType, seed, config, extensionPath: extensionUrl });
      ctx.ui.notify(`router: dispatching to ${plan.model}…`, "info");
      const result = await dispatchWork({ plan, cwd: ctx.cwd, config, runner: spawnRunner });
      ledger.append({
        kind: "dispatch",
        cwd: ctx.cwd,
        via: "/fixfresh",
        workType,
        model: result.model,
        ok: result.ok,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        seedChars: seed.length,
        summaryChars: result.summary.length,
      });
      pi.appendEntry("router.dispatch", { workType, model: result.model, ok: result.ok, durationMs: result.durationMs });
      ctx.ui.notify(formatDispatchResult(result), result.ok ? "info" : "error");
    },
  });
}
