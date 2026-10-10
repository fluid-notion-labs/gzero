// contextual pi plugin — connects the context system to pi sessions.
//
// Speaks to contextual only via MCP: registers cx-mcp for the model's
// tools, and injects the resolved default context (global + project
// tiers) into the system prompt at the first prompt of a session.
//
// Spec: research/context/pi-plugin.md. Curation policy:
// research/context/curation.md.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";

const REPO = "https://github.com/fluid-notion-labs/contextual";
const INSTALL_CMD = `cargo install --git ${REPO}`;

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
 * One-shot MCP stdio session against cx-mcp: initialize, call one tool,
 * return its text. Needed because event handlers get plain
 * ExtensionContext — no executeTool — so injection cannot go through
 * pi's own MCP connection. Same server, same protocol, no logic duplication.
 */
function mcpCall(cxMcp: string, tool: string, args: unknown, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cxMcp, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`cx-mcp ${tool}: timed out`))),
      timeoutMs,
    );
    child.on("error", (e) => done(() => reject(e)));
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      let msg: {
        id?: number;
        result?: { content?: { type: string; text?: string }[] };
      };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== 2) return; // initialize reply or notification
      const text = (msg.result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      done(() => resolve(text));
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
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  });
}

/** Framing block injected before the resolved atoms (curation.md §4). */
const PREAMBLE = `The context below is persistent memory: carried across sessions and machines, present in every session. Tagged knowledge is not shown here — when the user names technologies or domains, pull it via mcp__context__resolve with tags; discover hashtags with search. Facts that belong here apply to every session; task-specific learnings get tags instead. When saving: declarative facts, never imperatives to yourself; batch changes; consolidate rather than skip.`;

export default function (pi: ExtensionAPI) {
  let injected = false;
  let cxMcpPath: string | null | undefined;

  const findCxMcp = async (): Promise<string | null> => {
    if (cxMcpPath === undefined) cxMcpPath = await which("cx-mcp");
    return cxMcpPath;
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
    injected = false; // fresh session → inject again
    if (await findCxMcp()) return;
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
  });

  pi.on("before_agent_start", async (event) => {
    if (injected) return;
    injected = true;
    const cxMcp = await findCxMcp();
    if (!cxMcp) return; // offline degradation: no server, AGENTS.md fallback remains
    try {
      const text = await mcpCall(cxMcp, "resolve", {});
      const body = text.trim();
      if (!body || body === "(no matching context)") return;
      event.systemPromptOptions.sections["context"] = `<context>\n${PREAMBLE}\n\n${body}\n</context>`;
    } catch {
      // Degrade silently: pi still works without injection.
    }
  });
}
