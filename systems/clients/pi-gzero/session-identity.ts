/**
 * Session + machine identity (S1 presence), stable across extension
 * reloads.
 *
 * A pi session must keep ONE identity no matter how many times the
 * extension factory re-runs (reinstall mid-session, extension reload,
 * dev snapshot swap): the comms inbox is addressed by session id, so a
 * rotated id strands every message sent to the previous one (observed
 * 2026-11-06: a mid-session reinstall orphaned a live message). The
 * anchor is PI_SESSION_FILE — one file per pi session, stable within
 * it — hashed to a UUID-shaped id. Outside pi (CLI, tests) the id is
 * random, matching the old behavior.
 */
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** UUID v5-shaped id derived from a seed: deterministic, same format
 * the presence rows have always carried. */
export function uuidFromSeed(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The pi session anchor: basename of PI_SESSION_FILE without its
 * extension; undefined when not running under pi. */
export function sessionKey(): string | undefined {
  const file = process.env.PI_SESSION_FILE;
  if (!file) return undefined;
  const stem = path.basename(file).replace(/\.[^.]*$/, "");
  return stem || undefined;
}

export function sessionIdentity(): { sessionId: string; machineId: string } {
  const key = sessionKey();
  const sessionId = key ? uuidFromSeed(key) : randomUUID();
  const machineFile = path.join(os.homedir(), ".pi", "agent", "machine-id");
  let machineId: string;
  try {
    machineId = readFileSync(machineFile, "utf8").trim();
    if (!machineId) throw new Error("empty");
  } catch {
    machineId = randomUUID();
    try {
      mkdirSync(path.dirname(machineFile), { recursive: true });
      writeFileSync(machineFile, machineId + "\n");
    } catch {
      // best-effort; an ephemeral id still distinguishes machines poorly
      // but works locally
    }
  }
  return { sessionId, machineId };
}
