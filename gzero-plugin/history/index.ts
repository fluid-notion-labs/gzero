// index.ts — pi-history-plugin entry.
//
// F1 (and /history) opens the history overlay: projects → sessions → the
// branch tree (item dca8). Enter picks a prompt (inserted into the editor)
// exactly as before; esc backs out a level, f1/q close from the top level.

import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listProjects, loadSessions } from "./history.ts";
import { HistoryPanel } from "./panel.ts";

export default function (pi: ExtensionAPI) {
  const open = (ctx: ExtensionCommandContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("history: no session file yet", "warning");
      return;
    }
    const { projects, current } = listProjects(sessionFile);
    ctx.ui.custom(
      (_tui, theme, keybindings, done) =>
        new HistoryPanel(projects, current, theme, keybindings, {
          onClose: () => done(undefined),
          onPick: (entry) => {
            ctx.ui.setEditorText(entry.text);
            done(undefined);
          },
          loadSessions: (projectDir) => loadSessions(projectDir),
          sessionDir: (project) => join(dirname(dirname(sessionFile)), project),
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
    description: "Toggle history (projects → sessions → branch tree)",
    handler: async (ctx) => open(ctx as ExtensionCommandContext),
  });

  pi.registerCommand("history", {
    description: "Show history: projects, sessions, branch tree (filler filtered)",
    handler: async (_args, ctx) => open(ctx),
  });
}
