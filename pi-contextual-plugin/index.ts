// contextual pi plugin — connects the context system to pi sessions.
//
// Speaks to contextual only via MCP: registers cx-mcp for the model's
// tools, injects the resolved default context (global + project tiers)
// into the system prompt on every turn, and adds /context commands.
//
// Spec: research/context/pi-plugin.md. Curation policy:
// research/context/curation.md.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ScrollView,
  Text,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { registerSkills } from "./skills.ts";
import { execFile, spawn } from "node:child_process";

const REPO = "https://github.com/fluid-notion-labs/contextual";
const INSTALL_CMD = `cargo install --git ${REPO}`;

/** Tools every cx-mcp must expose; a stale install warns instead of failing. */
const EXPECTED_TOOLS = ["resolve", "search", "add", "remove", "tags"];

/** Look up a binary on PATH (a lookup, not a long-running process). */
function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [bin], (err, stdout) => {
      const p = stdout.trim();
      resolve(err || !p ? null : p);
    });
  });
}

/**
 * One MCP request over a fresh stdio session: spawn cx-mcp, initialize,
 * send one request, resolve with its result. Needed because event and
 * command handlers get no executeTool — a session of our own is the only
 * way to speak MCP. Same server, same protocol, no logic duplication.
 */
function mcpRequest(cxMcp: string, method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(cxMcp, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const requestId = 2; // 1 is the initialize reply
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`cx-mcp ${method}: timed out`))),
      timeoutMs,
    );
    child.on("error", (e) => finish(() => reject(e)));
    child.stdout.on("data", (d) => {
      buf += d;
      // A chunk may carry several lines (initialize + call replies often
      // coalesce); drain the whole buffer, not just the first line.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== requestId) continue; // initialize reply or notification
        if (msg.error) {
          const m = typeof msg.error === "object" && msg.error !== null && "message" in msg.error
            ? String((msg.error as { message: unknown }).message)
            : JSON.stringify(msg.error);
          finish(() => reject(new Error(`cx-mcp ${method}: ${m}`)));
          return;
        }
        finish(() => resolve(msg.result));
        return;
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-plugin-context", version: "0.1.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: requestId, method, params });
  });
}

/** Tool text from a one-shot tools/call. */
async function mcpCall(cxMcp: string, tool: string, args: unknown): Promise<string> {
  const result = await mcpRequest(cxMcp, "tools/call", { name: tool, arguments: args });
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** Tool names from a one-shot tools/list. */
async function mcpTools(cxMcp: string): Promise<string[]> {
  const result = await mcpRequest(cxMcp, "tools/list", {});
  return ((result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
}

/** Framing block injected before the resolved atoms (curation.md §4). */
const PREAMBLE = `The context below is persistent memory: carried across sessions and machines, present in every session. Tagged knowledge is not shown here — when the user names technologies or domains, pull it via mcp__context__resolve with tags; discover hashtags with search. Facts that belong here apply to every session; task-specific learnings get tags instead. When saving: declarative facts, never imperatives to yourself; batch changes; consolidate rather than skip.`;

interface TierSection {
  label: string;
  text: string;
}

/**
 * Split rendered atoms into the three browsable tiers by scope header:
 * `# global/…` → global, `# skills/…` → skillbag, everything else → local
 * (the project tier, whatever its repo identity is).
 */
export function bucketTiers(rendered: string): TierSection[] {
  const buckets: Record<string, string[]> = { global: [], local: [], skillbag: [] };
  let current: string[] = buckets.local;
  for (const line of rendered.split("\n")) {
    if (line.startsWith("# ")) {
      const scope = line.slice(2).split("/")[0].toLowerCase();
      current = buckets[scope === "global" ? "global" : scope === "skills" ? "skillbag" : "local"];
    }
    current.push(line);
  }
  return ([
    { label: "global", text: buckets.global.join("\n").trim() },
    { label: "local", text: buckets.local.join("\n").trim() },
    { label: "skillbag", text: buckets.skillbag.join("\n").trim() },
  ]);
}

/**
 * Read-only overlay viewer for the bag, tabbed by tier: global (always
 * active), local (project), skillbag (the distilled skills). 1/2/3 or
 * tab/←→ switch tabs; j/k scroll; esc/q close.
 */
class TierViewer implements Component, Focusable {
  focused = false;
  private tab = 0;
  private scroll: ScrollView;

  constructor(
    private sections: TierSection[],
    private theme: Theme,
    private done: (result?: unknown) => void,
  ) {
    this.scroll = this.makeScroll();
  }

  invalidate(): void {
    this.scroll.invalidate();
  }

  private makeScroll(): ScrollView {
    const text = this.sections[this.tab]?.text || "(empty)";
    return new ScrollView(new Text(text, 1, 1), { scrollbar: "auto" });
  }

  private switchTo(tab: number) {
    if (tab === this.tab || tab < 0 || tab >= this.sections.length) return;
    this.tab = tab;
    this.scroll = this.makeScroll();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
    } else if (matchesKey(data, "1")) {
      this.switchTo(0);
    } else if (matchesKey(data, "2")) {
      this.switchTo(1);
    } else if (matchesKey(data, "3")) {
      this.switchTo(2);
    } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.switchTo((this.tab + 1) % this.sections.length);
    } else if (matchesKey(data, "left")) {
      this.switchTo((this.tab + this.sections.length - 1) % this.sections.length);
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll.scrollBy(-3);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll.scrollBy(3);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll.scrollBy(-20);
    } else if (matchesKey(data, "pageDown")) {
      this.scroll.scrollBy(20);
    } else if (matchesKey(data, "home")) {
      this.scroll.scrollToStart();
    } else if (matchesKey(data, "end") || data === "G") {
      this.scroll.scrollToEnd();
    } else if (matchesKey(data, "g")) {
      this.scroll.scrollToStart();
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const tabs = this.sections
      .map((s, i) => {
        const label = ` ${i + 1} ${s.label} `;
        return i === this.tab ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
      })
      .join(t.fg("dim", "│"));
    return [tabs, t.fg("accent", "─".repeat(Math.max(width, 20))), ...this.scroll.render(width)];
  }
}

export default function (pi: ExtensionAPI) {
  let cxMcpPath: string | null | undefined;
  /** Resolved default context for this session; injected every turn. */
  let resolvedBody: string | null = null;

  const findCxMcp = async (): Promise<string | null> => {
    if (cxMcpPath === undefined) cxMcpPath = await which("cx-mcp");
    return cxMcpPath;
  };

  /** Resolve once and cache; returns null when nothing usable came back. */
  const resolveContext = async (cxMcp: string): Promise<string | null> => {
    const text = await mcpCall(cxMcp, "resolve", {});
    const body = text.trim();
    if (!body || body === "(no matching context)") return null;
    return body;
  };

  // The model's MCP tools. Registered in the factory; pi connects the
  // server when the session starts. A user mcp.json entry named "context"
  // wins — that is the escape hatch for custom flags.
  pi.registerMcpServer("context", {
    command: "cx-mcp",
    env: Object.fromEntries(
      ["CX_DB", "CX_HUB_URL", "CX_TOKEN"]
        .map((k) => [k, process.env[k]])
        .filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });

  pi.on("session_start", async (_event, ctx) => {
    resolvedBody = null; // fresh session → resolve again
    const cxMcp = await findCxMcp();
    if (!cxMcp) {
      if (!ctx.hasUI) {
        console.error(`contextual pi plugin: cx-mcp not found; install with: ${INSTALL_CMD}`);
        return;
      }
      if (!(await which("cargo"))) {
        ctx.ui.notify(
          `contextual is not installed and cargo is unavailable. Install manually from ${REPO}`,
          "warning",
        );
        return;
      }
      const ok = await ctx.ui.confirm(
        "contextual is not installed",
        `Install it now? Runs: ${INSTALL_CMD} (provides cx and cx-mcp).`,
      );
      if (!ok) return;
      ctx.ui.notify("Installing contextual in the background…", "info");
      // Detached so the install survives the session; notified on completion.
      const child = spawn("cargo", ["install", "--git", REPO], {
        stdio: "ignore",
        detached: true,
      });
      child.on("exit", (code) => {
        ctx.ui.notify(
          code === 0
            ? "contextual installed — restart pi to connect it"
            : `contextual install failed (exit ${code})`,
          code === 0 ? "info" : "error",
        );
      });
      child.unref();
      return;
    }
    // Stale-install check: tools/list must show the full surface.
    try {
      const tools = await mcpTools(cxMcp);
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
      if (missing.length > 0) {
        ctx.ui.notify(
          `cx-mcp is missing tools: ${missing.join(", ")}. Update with: ${INSTALL_CMD}`,
          "warning",
        );
      }
    } catch {
      // tools/list failure shouldn't block the session; injection degrades anyway.
    }
  });

  pi.on("before_agent_start", async (event) => {
    const cxMcp = await findCxMcp();
    if (!cxMcp) return; // offline degradation: no server, AGENTS.md fallback remains
    try {
      if (resolvedBody === null) resolvedBody = await resolveContext(cxMcp);
      if (resolvedBody !== null) {
        // A fresh normalized copy arrives every turn; the returned options
        // become the turn's system prompt, so the section must be set
        // every turn or it is dropped from the prompt diff.
        event.systemPromptOptions.sections["context"] =
          `<context>\n${PREAMBLE}\n\n${resolvedBody}\n</context>`;
      }
    } catch (e) {
      resolvedBody = null; // resolve failed → retry next turn
      // Degrade silently: pi still works without injection.
    }
  });

  pi.registerCommand("context", {
    description: "Browse the bag by tier (global/local/skillbag); 'reload' re-resolves; 'add <text>' saves an atom",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cxMcp = await findCxMcp();
      if (!cxMcp) {
        ctx.ui.notify(`cx-mcp not found. Install with: ${INSTALL_CMD}`, "error");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/);
      const argText = rest.join(" ").trim();

      if (sub === "reload") {
        try {
          resolvedBody = await resolveContext(cxMcp);
          ctx.ui.notify(
            resolvedBody === null
              ? "Context reloaded: nothing resolved for this project"
              : `Context reloaded (${resolvedBody.length} chars) — applies to the next turn`,
            "info",
          );
        } catch (e) {
          ctx.ui.notify(`Reload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (sub === "add") {
        const text = argText || (await ctx.ui.input("Add to context", "the terse assertion"));
        if (!text?.trim()) return;
        const tags = await ctx.ui.input("Tags (optional)", "comma-separated hashtags");
        const confirmed = await ctx.ui.confirm(
          "Add to context",
          `"${text.trim()}"${tags?.trim() ? `\ntags: ${tags.trim()}` : ""}`,
        );
        if (!confirmed) return;
        try {
          const result = await mcpCall(cxMcp, "add", {
            text: text.trim(),
            tags: tags?.trim() || undefined,
          });
          ctx.ui.notify(`Context: ${result}`, "info");
        } catch (e) {
          ctx.ui.notify(`Add failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (sub !== undefined && sub !== "") {
        ctx.ui.notify("Usage: /context [reload|add <text>]", "warning");
        return;
      }

      // Plain /context: show what the model is injected. In TUI mode a
      // scrollable overlay; elsewhere a notification.
      if (resolvedBody === null) {
        try {
          resolvedBody = await resolveContext(cxMcp);
        } catch {
          ctx.ui.notify("Could not resolve context", "error");
          return;
        }
      }
      if (resolvedBody === null) {
        ctx.ui.notify("Nothing resolved for this project — /context add or tagged pulls", "info");
        return;
      }
      // Tabbed viewer over the whole bag (global / local / skillbag);
      // injected context remains the tiered default shown on every turn.
      if (ctx.mode === "tui") {
        try {
          const rendered = await mcpCall(cxMcp, "resolve", { scope_prefix: "" });
          const sections = bucketTiers(rendered).filter((s) => s.text);
          if (sections.length === 0) {
            ctx.ui.notify("The bag is empty — /context add to start it", "info");
            return;
          }
          await ctx.ui.custom(
            (_tui, theme, _keybindings, done) => new TierViewer(sections, theme, done),
          );
        } catch (e) {
          ctx.ui.notify(`Could not load the bag: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
      } else {
        const full = `<context>\n${PREAMBLE}\n\n${resolvedBody}\n</context>`;
        ctx.ui.notify(full.length > 400 ? `${full.slice(0, 400)}…` : full, "info");
      }
    },
  });

  registerSkills(pi);
}
