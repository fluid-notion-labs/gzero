#!/usr/bin/env node
// Smoke + timing harness for gzero-mcp.
//
// Spawns the MCP server over stdio with an isolated doc in a temp dir,
// drives a fixed sequence of tool calls one at a time, and reports the
// wall-clock duration of every request. Child stderr (gzero-sync and
// gzero-mcp timing lines) passes through live, so slow requests can be
// attributed to hub syncs.
//
// Modes:
//   default            — hub vars inherited (CX_HUB_URL/CX_TOKEN); uses an
//                        isolated bag so the real context doc is untouched
//   SMOKE_OFFLINE=1    — hub vars stripped: pure local-doc timings
//   SMOKE_REPEAT=N     — run the tool-call sequence N times
//   SMOKE_BAG=x        — override the isolated bag name
//
// Summary reports count / mean / max per request name.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.env.GZERO_BIN || "target/debug/gzero-mcp";
const repeat = Math.max(1, Number(process.env.SMOKE_REPEAT || 1));
const dir = mkdtempSync(join(tmpdir(), "gzero-smoke-"));

const env = {
  ...process.env,
  CX_WS_DB: join(dir, "smoke.ws"),
  CX_COMMS_DB: join(dir, "smoke-comms.ws"),
  CX_DB: join(dir, "smoke.db"),
  CX_BAG: process.env.SMOKE_BAG || "gzero-smoke-test",
  CX_SYNC_LOG: process.env.CX_SYNC_LOG || "1",
};
if (process.env.SMOKE_OFFLINE) {
  delete env.CX_HUB_URL;
  delete env.CX_TOKEN;
}

const child = spawn(bin, [], { env, stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", (code) => {
  console.error(`[smoke] server exited ${code}`);
  process.exit(code ?? 1);
});

let nextId = 1;
const pending = new Map(); // id -> resolve
let buf = "";

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

async function request(method, params) {
  const id = nextId++;
  const t0 = performance.now();
  const promise = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const msg = await promise;
  const ms = Math.round(performance.now() - t0);
  return { ms, ok: !msg.error, result: msg.result, error: msg.error };
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const atomText = `smoke atom ${stamp} #gzero-smoke`;

const calls = [
  ["resolve", {}],
  ["item_list", {}],
  ["plan_next", {}],
  ["tags", {}],
  ["sessions", {}],
  ["add", { operations: [{ action: "add", text: atomText }] }],
  ["add", { operations: [{ action: "remove", text: atomText }] }],
  ["resolve", {}],
];

const timings = []; // {name, ms, ok}

try {
  let r = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gzero-smoke", version: "0" },
  });
  timings.push({ name: "initialize", ms: r.ms, ok: r.ok });
  notify("notifications/initialized", {});

  r = await request("tools/list", {});
  timings.push({ name: "tools/list", ms: r.ms, ok: r.ok });

  for (let i = 0; i < repeat; i++) {
    for (const [name, args] of calls) {
      r = await request("tools/call", { name, arguments: args });
      timings.push({ name, ms: r.ms, ok: r.ok });
      if (!r.ok) {
        console.error(`[smoke] ${name} failed:`, JSON.stringify(r.error));
      }
    }
  }
} finally {
  child.kill();
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 200).unref?.();
}

// Report
const width = Math.max(...timings.map((t) => t.name.length)) + 2;
console.log(`\n[smoke] bin=${bin} bag=${env.CX_BAG} mode=${env.SMOKE_OFFLINE ? "offline" : "hub"} repeat=${repeat}`);
for (const t of timings) {
  console.log(`  ${t.name.padEnd(width)} ${String(t.ms).padStart(6)}ms ${t.ok ? "" : "FAILED"}`);
}

const byName = new Map();
for (const t of timings) {
  if (!byName.has(t.name)) byName.set(t.name, []);
  byName.get(t.name).push(t.ms);
}
console.log("\n[smoke] summary (min / mean / max)");
let total = 0;
for (const [name, msList] of byName) {
  const min = Math.min(...msList);
  const mean = Math.round(msList.reduce((a, b) => a + b, 0) / msList.length);
  const max = Math.max(...msList);
  total += msList.reduce((a, b) => a + b, 0);
  console.log(`  ${name.padEnd(width)} ${String(min).padStart(6)} / ${String(mean).padStart(6)} / ${String(max).padStart(6)} ms  (n=${msList.length})`);
}
console.log(`  ${"TOTAL".padEnd(width)} ${String(total).padStart(6)}ms over ${timings.length} requests`);
process.exit(0);
