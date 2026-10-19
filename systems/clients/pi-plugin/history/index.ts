// index.ts — pi-history-plugin entry.
//
// ctrl+` (and /history) opens the prompt-history overlay: every user prompt
// from this project's pi sessions, newest first, with pure filler ("yep",
// "ok, continue", ...) filtered out. Enter inserts the selected prompt into
// the editor; esc closes.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadHistory } from "./history.ts";
import { HistoryPanel } from "./panel.ts";

export default function (pi: ExtensionAPI) {
  const open = (ctx: ExtensionCommandContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("history: no session file yet", "warning");
      return;
    }
    const entries = loadHistory(sessionFile);
    ctx.ui.custom(
      (_tui, theme, keybindings, done) =>
        new HistoryPanel(entries, theme, keybindings, {
          onClose: () => done(undefined),
          onPick: (entry) => {
            ctx.ui.setEditorText(entry.text);
            done(undefined);
          },
        }),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: 28, anchor: "top-center", margin: { top: 1 } },
      },
    );
  };

  // ctrl+` is unusable: it decodes as ctrl+space (NUL) in legacy terminal
  // encoding, which the gzero plugin's workstyles picker owns, and
  // alt+` is the window switcher on the user's desktop. F1 decodes
  // distinctly everywhere and was free in pi and the other plugins.
  pi.registerShortcut("f1", {
    description: "Toggle prompt history (filler filtered)",
    handler: async (ctx) => open(ctx as ExtensionCommandContext),
  });

  pi.registerCommand("history", {
    description: "Show prompt history for this project (filler filtered)",
    handler: async (_args, ctx) => open(ctx),
  });
}
