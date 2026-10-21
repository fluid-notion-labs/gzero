// summary.ts — a compact "what happened here" summary of the current
// session, shown below the prompt list in the F1 history panel.
//
// The summarizer runs as a fresh ephemeral pi session (pi -p --no-session
// --no-extensions): the plugin hands it the session's transcript with
// stable [index] numbers — user prompts AND agent responses — and gets
// back a short summary that cites the indices, so any point in it can be
// traced back into the history, and any referenced section can later be
// pulled in full by its index.
//
// The result is cached per session (~/.pi/pi-gzero/history-summary/) with
// the number of transcript entries it covers; reopening the panel only
// re-dispatches when the session has grown, sending the previous summary
// plus the new entries.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { isFiller } from "./filler.ts";
import { cleanPrompt } from "./history.ts";

/** One numbered transcript entry handed to the summarizer. */
export interface TranscriptEntry {
  /** Stable 1-based index into the session's message queue. */
  index: number;
  role: "user" | "assistant";
  timestamp: string;
  text: string;
}

/** Per-entry character budget in the summarizer prompt. */
const ENTRY_CLIP = 800;

/** Extract the current session's transcript (user + agent text turns),
 * oldest first, with stable 1-based queue indices. Filler user prompts
 * ("yep", "ok, continue", ...) are dropped; injected <context> blocks are
 * stripped from user turns. */
export function extractTranscript(sessionPath: string): TranscriptEntry[] {
  let file: string;
  try {
    file = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of file.split("\n")) {
    if (!line) continue;
    let e: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message") continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = e.message?.content;
    const raw =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
              .join("\n")
          : "";
    const text = role === "user" ? cleanPrompt(raw) : raw.trim();
    if (!text) continue;
    if (role === "user" && isFiller(text)) continue;
    entries.push({ index: entries.length + 1, role, timestamp: e.timestamp ?? "", text });
  }
  return entries;
}

/** One line of the numbered transcript payload, clipped. */
function payloadLine(entry: TranscriptEntry): string {
  const who = entry.role === "user" ? "user" : "agent";
  const text = entry.text.replace(/\s+/g, " ").trim();
  const clipped = text.length <= ENTRY_CLIP ? text : text.slice(0, ENTRY_CLIP - 1) + "…";
  return `[${entry.index}] ${who}: ${clipped}`;
}

/** Build the summarization prompt: full transcript, or the previous
 * summary plus only the entries it doesn't yet cover. */
export function buildPrompt(
  entries: TranscriptEntry[],
  prev?: { summary: string; covered: number },
): string {
  if (prev) {
    const fresh = entries.filter((e) => e.index > prev.covered);
    return [
      "Below is a numbered transcript excerpt (user and agent turns) and the",
      "current summary of this coding session. Update the summary to include",
      "what happened in the newer turns, keeping it compact (max ~10 lines).",
      "Write it as a few short paragraphs separated by blank lines.",
      "Cite the relevant [index] numbers inline, like [3] or [3][7].",
      "Plain text only — no headings, no markdown.",
      "Output only the updated summary text, nothing else.",
      "",
      `Current summary (covers entries [1..${prev.covered}]):`,
      prev.summary,
      "",
      "Newer transcript entries:",
      ...fresh.map(payloadLine),
    ].join("\n");
  }
  return [
    "Below is a numbered transcript of a coding-agent session (user and",
    "agent turns). Write a compact summary (max ~10 lines) of what the",
    "person was working on and what got done. Write it as a few short",
    "paragraphs separated by blank lines. Cite the relevant [index]",
    "numbers inline, like [3] or [3][7]. Plain text only — no headings,",
    "no markdown. Output only the summary.",
    "",
    ...entries.map(payloadLine),
  ].join("\n");
}

/** Cached summary for one session, with coverage bookkeeping. */
export interface SummaryCache {
  summary: string;
  /** Number of transcript entries the summary covers. */
  covered: number;
  updatedAt: string;
}

/** Cache location: one JSON file per session file. */
export function summaryCachePath(sessionFile: string, baseDir?: string): string {
  const id = basename(sessionFile).replace(/\.jsonl$/, "");
  return join(baseDir ?? join(homedir(), ".pi", "pi-gzero", "history-summary"), `${id}.json`);
}

export function loadSummaryCache(sessionFile: string, baseDir?: string): SummaryCache | null {
  const path = summaryCachePath(sessionFile, baseDir);
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as SummaryCache;
    if (typeof c.summary !== "string" || typeof c.covered !== "number") return null;
    return c;
  } catch {
    return null;
  }
}

export function saveSummaryCache(sessionFile: string, cache: SummaryCache, baseDir?: string): void {
  const path = summaryCachePath(sessionFile, baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + "\n");
}

/** Hard cap on a summarization request, so a hung child can never wedge
 * the panel's spinner forever. */
export const SUMMARY_TIMEOUT_MS = 120_000;

export interface ExecLike {
  (command: string, args: string[], options?: { timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
}

/**
 * Summarize via a fresh ephemeral pi session: `pi -p --no-session
 * --no-extensions --no-mcp -nt @<file>`. The numbered transcript goes to a
 * temp file attached with pi's `@file` syntax — the command line stays
 * small (a multi-KB argv prompt made the child hang) and the child's
 * context is just the transcript, not the whole session (a full-session
 * fork was tested and is far too slow).
 *
 * Ephemeral is essential — a saved session would land in the same sessions
 * folder and pollute the history the panel shows (and its own summary input).
 */
export async function requestSummary(exec: ExecLike, prompt: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gzero-summary-"));
  const file = join(dir, "transcript.txt");
  try {
    writeFileSync(file, prompt);
    const res = await exec(
      "pi",
      ["-p", "--no-session", "--no-extensions", "--no-mcp", "-nt", `@${file}`],
      { timeout: SUMMARY_TIMEOUT_MS },
    );
    if (res.killed) throw new Error("summarization timed out");
    if (res.code !== 0) throw new Error(res.stderr.trim() || `pi exited with code ${res.code}`);
    const text = res.stdout.trim();
    if (!text) throw new Error("empty summary response");
    return text;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
