// index.ts — pi-history-plugin entry.
//
// F1 (and /history) opens the prompt-history overlay: every user prompt
// from this project's pi sessions, newest first, with pure filler ("yep",
// "ok, continue", ...) filtered out. Enter inserts the selected prompt into
// the editor; esc closes.
//
// Below the list, a compact summary of the current session is shown. It is
// produced by a fresh ephemeral pi session (see summary.ts), dispatched
// automatically when the panel opens, asynchronously — the history appears
// immediately, the summary pops in when it's ready. The summary cites
// [index] numbers into the session's transcript queue (user + agent turns),
// so any point in it can be traced back to its message.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadHistory } from "./history.ts";
import { HistoryPanel, type SummaryState } from "./panel.ts";
import {
  buildPrompt,
  extractTranscript,
  loadSummaryCache,
  requestSummary,
  saveSummaryCache,
  type TranscriptEntry,
} from "./summary.ts";

export default function (pi: ExtensionAPI) {
  // In-flight summarization per session file: reopening the panel while a
  // request runs reuses it instead of spawning another pi process. A
  // request started for an older transcript may still resolve later; its
  // result is cached and shown on the next open.
  const pending = new Map<string, Promise<SummaryState>>();

  const open = (ctx: ExtensionCommandContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("history: no session file yet", "warning");
      return;
    }
    const entries = loadHistory(sessionFile);

    // Summary scope is the current session (for now).
    const transcript = extractTranscript(sessionFile);
    const cache = loadSummaryCache(sessionFile);
    const initial: SummaryState =
      transcript.length === 0
        ? { status: "idle" }
        : cache && cache.covered === transcript.length
          ? { status: "ready", text: cache.summary }
          : cache
            ? { status: "stale", text: cache.summary }
            : { status: "pending" };

    let panel: HistoryPanel | null = null;
    let requestRender: (() => void) | null = null;
    const closed = ctx.ui.custom(
      (tui, theme, keybindings, done) => {
        panel = new HistoryPanel(entries, theme, keybindings, {
          onClose: () => done(undefined),
          onPick: (entry) => {
            ctx.ui.setEditorText(entry.text);
            done(undefined);
          },
        });
        panel.attach(tui);
        panel.setSummary(initial);
        requestRender = () => tui.requestRender();
        return panel;
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: 28, anchor: "top-center", margin: { top: 1 } },
      },
    );

    if (initial.status !== "idle" && !(cache && cache.covered === transcript.length)) {
      const key = sessionFile;
      let statePromise = pending.get(key);
      if (!statePromise) {
        statePromise = summarize(pi, sessionFile, transcript, cache);
        pending.set(key, statePromise);
        statePromise.finally(() => {
          if (pending.get(key) === statePromise) pending.delete(key);
        });
      }
      void statePromise.then(
        (state) => {
          panel?.setSummary(state);
          requestRender?.();
        },
        (err: unknown) => {
          panel?.setSummary({ status: "error", text: String(err instanceof Error ? err.message : err) });
          requestRender?.();
        },
      );
    }

    return closed;
  };

  async function summarize(
    pi: ExtensionAPI,
    sessionFile: string,
    transcript: TranscriptEntry[],
    cache: ReturnType<typeof loadSummaryCache>,
  ): Promise<SummaryState> {
    // Incremental when the session grew since the cached summary; full
    // re-run when it shrank (compaction rewrites the file, indices shift).
    const incremental =
      cache && cache.covered > 0 && cache.covered < transcript.length
        ? { summary: cache.summary, covered: cache.covered }
        : undefined;
    const prompt = buildPrompt(transcript, incremental);
    const summary = await requestSummary((cmd, args) => pi.exec(cmd, args), prompt);
    const state: SummaryState = { status: "ready", text: summary };
    saveSummaryCache(sessionFile, { summary, covered: transcript.length, updatedAt: new Date().toISOString() });
    return state;
  }

  // ctrl+` is unusable: it decodes as ctrl+space (NUL) in legacy terminal
  // encoding, which the gzero plugin's workstyles picker owns, and
  // alt+` is the window switcher on the user's desktop. F1 decodes
  // distinctly everywhere and was free in pi and the other plugins.
  pi.registerShortcut("f1", {
    description: "Toggle prompt history (filler filtered)",
    handler: async (ctx) => {
      await open(ctx as ExtensionCommandContext);
    },
  });

  pi.registerCommand("history", {
    description: "Show prompt history for this project (filler filtered)",
    handler: async (_args, ctx) => {
      await open(ctx);
    },
  });
}
