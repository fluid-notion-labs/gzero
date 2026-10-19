// history.ts — read user prompts from pi session files.
//
// Sessions live under ~/.pi/agent/sessions/<project-slug>/<session>.jsonl.
// Project scope = the folder the current session file lives in, so the
// history shows this project's prompts across sessions. Entries are user
// role messages; the injected <context> block is stripped; pure filler
// ("yep", "ok, continue", ...) is dropped via filler.ts.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isFiller } from "./filler.ts";

export interface PromptEntry {
  text: string;
  timestamp: string;
  sessionId: string;
}

/** Strip injected blocks and trim; returns "" when nothing user-typed remains. */
function cleanPrompt(text: string): string {
  let t = text;
  const cut = t.indexOf("<context>");
  if (cut !== -1) t = t.slice(0, cut);
  return t.trim();
}

/** Extract user prompts from one session file, oldest first. */
export function extractPrompts(sessionPath: string): PromptEntry[] {
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
  const entries: PromptEntry[] = [];
  let file: string;
  try {
    file = readFileSync(sessionPath, "utf8");
  } catch {
    return entries;
  }
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
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const content = e.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
              .join("\n")
          : "";
    const clean = cleanPrompt(text);
    if (!clean || isFiller(clean)) continue;
    entries.push({ text: clean, timestamp: e.timestamp ?? "", sessionId });
  }
  return entries;
}

/**
 * Load the project's prompt history: every session in the same sessions
 * folder as `currentSessionFile` (or the folder itself), newest first.
 */
export function loadHistory(currentSessionFile: string): PromptEntry[] {
  const dir = dirname(currentSessionFile);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const all: PromptEntry[] = [];
  for (const f of files) {
    all.push(...extractPrompts(join(dir, f)));
  }
  // chronological (oldest first): the panel reads like the chat, newest
  // at the bottom by the editor, time fading upwards
  return all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}
