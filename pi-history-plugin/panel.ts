// panel.ts — the prompt-history overlay: a scrollable list of the
// project's user prompts (filler already removed).
//
// Styled like the chat: entries are blue blocks (userMessageBg, same token
// the chat uses for user messages), anchored at the top of the screen, and
// chronological — oldest at top, newest at bottom by the editor, so time
// "fades upwards" and ↑ walks to older prompts exactly like ctrl+up walks
// up through the chat history.
//
// Standalone copy of the shared keymap pattern (pi-contextual-plugin's
// keymap.ts) — plugins are blessed standalone, so no cross-package imports.
// Standard ids resolve through the injected KeybindingsManager so user
// rebinds apply; q is a hardcoded extra since plugin-only keys can't be
// rebindable actions.

import { matchesKey, type Keybinding, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PromptEntry } from "./history.ts";

/** How many list lines render at once. */
const WINDOW = 20;

function id(binding: Keybinding, fallback: KeyId) {
  return (data: string, kb?: KeybindingsManager) => (kb ? kb.matches(data, binding) : matchesKey(data, fallback));
}

const CANCEL = id("tui.select.cancel", "escape");
const CONFIRM = id("tui.select.confirm", "return");
const UP = id("tui.select.up", "up");
const DOWN = id("tui.select.down", "down");
const PAGE_UP = id("tui.select.pageUp", "pageUp");
const PAGE_DOWN = id("tui.select.pageDown", "pageDown");

export interface HistoryPanelOptions {
  onClose: () => void;
  /** Enter: pick the prompt (the opener inserts it into the editor) and close. */
  onPick: (entry: PromptEntry) => void;
}

export class HistoryPanel {
  private scroll = 0;

  constructor(
    // chronological, oldest first (as loadHistory now returns)
    private readonly entries: PromptEntry[],
    private readonly theme: Theme,
    private readonly kb: KeybindingsManager | undefined,
    private readonly opts: HistoryPanelOptions,
  ) {
    // start on the newest prompt (bottom row, by the editor)
    this.selected = Math.max(0, entries.length - 1);
  }

  private selected = 0;

  invalidate(): void {}

  private keepVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + WINDOW) this.scroll = this.selected - WINDOW + 1;
    if (this.scroll < 0) this.scroll = 0;
    const maxScroll = Math.max(0, this.entries.length - WINDOW);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
  }

  handleInput(data: string): void {
    // F1 toggles: the same key that opened the panel closes it.
    if (CANCEL(data, this.kb) || data === "q" || matchesKey(data, "f1")) {
      this.opts.onClose();
      return;
    }
    if (CONFIRM(data, this.kb)) {
      const entry = this.entries[this.selected];
      if (entry) this.opts.onPick(entry);
      return;
    }
    const last = this.entries.length - 1;
    if (UP(data, this.kb) || data === "k") {
      // up = older, like ctrl+up through chat history
      this.selected = Math.max(0, this.selected - 1);
    } else if (DOWN(data, this.kb) || data === "j") {
      this.selected = Math.min(last, this.selected + 1);
    } else if (PAGE_UP(data, this.kb) || data === "g") {
      this.selected = Math.max(0, this.selected - WINDOW);
    } else if (PAGE_DOWN(data, this.kb) || data === "G") {
      this.selected = Math.min(last, this.selected + WINDOW);
    }
    this.keepVisible();
  }

  private label(entry: PromptEntry): string {
    // date is enough for recall; time-of-day noise isn't worth the columns
    const date = entry.timestamp ? entry.timestamp.slice(0, 10) : "?";
    return `${date}  ${entry.text}`;
  }

  render(width: number): string[] {
    const total = this.entries.length;
    const lines: string[] = [];
    lines.push(this.theme.fg("dim", ` prompt history — ${total} prompt${total === 1 ? "" : "s"}, filler filtered`));

    if (total === 0) {
      lines.push(this.theme.fg("dim", " no prompts yet"));
    } else {
      this.keepVisible();
      for (let i = this.scroll; i < Math.min(total, this.scroll + WINDOW); i++) {
        const marker = i === this.selected ? "▸ " : "  ";
        const body = ` ${marker}${truncate(this.label(this.entries[i]), width - 4)}`;
        // full-width blue block, like a chat user message
        lines.push(this.theme.bg("userMessageBg", body.padEnd(width - 1)));
      }
    }
    lines.push(
      this.theme.fg(
        "dim",
        "  ↑ older · ↓ newer · enter insert · esc/f1 close" +
          (total > WINDOW ? ` · ${this.scroll + 1}-${Math.min(total, this.scroll + WINDOW)} of ${total}` : ""),
      ),
    );
    return lines;
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n+/g, " ↵ ");
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + "…";
}
