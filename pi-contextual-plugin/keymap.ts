// Shared keymap layer for the plugin's modal viewers.
//
// Navigation resolves through the injected KeybindingsManager, so user
// rebinding in keybindings.json (and pi's /hotkeys truth) applies to
// plugin screens: tui.select.up/down/pageUp/pageDown/confirm/cancel.
// Extras pi's own components never bind — q, j/k, g/G, b/space,
// home/end, tab switching — stay hardcoded matchesKey, in canonical
// key-id form (e.g. "shift+g", not a raw "G" compare, which only works
// on legacy terminals; matchesKey handles the Kitty protocol too).
// There is no extension API to register new action ids, so plugin-only
// keys can't become rebindable actions; footers show the effective
// bindings for the standard ids instead (keyHint).

import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";

/** Navigation predicates shared by the modal viewers. */
export interface ViewerNav {
  /** escape / ctrl+c (tui.select.cancel). Pickers with a text input use
   * this alone; read-only viewers add `q` on top. */
  cancel(data: string): boolean;
  /** enter (tui.select.confirm). */
  confirm(data: string): boolean;
  /** tui.select.up — one line up. */
  up(data: string): boolean;
  /** tui.select.down — one line down. */
  down(data: string): boolean;
  /** tui.select.pageUp. */
  pageUp(data: string): boolean;
  /** tui.select.pageDown. */
  pageDown(data: string): boolean;
}

/**
 * Standard ids resolve via the manager when one is injected (tests
 * construct viewers without one and get the default bindings).
 */
export function viewerNav(kb: KeybindingsManager | undefined): ViewerNav {
  const id = (binding: Keybinding, fallback: KeyId) => (data: string) =>
    kb ? kb.matches(data, binding) : matchesKey(data, fallback);
  return {
    cancel: id("tui.select.cancel", "escape"),
    confirm: id("tui.select.confirm", "return"),
    up: id("tui.select.up", "up"),
    down: id("tui.select.down", "down"),
    pageUp: id("tui.select.pageUp", "pageUp"),
    pageDown: id("tui.select.pageDown", "pageDown"),
  };
}

/** Pretty forms for hint footers: last segment of a key id. */
const PRETTY: Record<string, string> = {
  escape: "esc",
  pageUp: "pgup",
  pageDown: "pgdn",
  return: "enter",
  enter: "enter",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** "ctrl+pageUp" → "ctrl+pgup"; plain ids map through PRETTY. */
export function prettyKey(key: string): string {
  const parts = key.split("+");
  const last = parts.length - 1;
  parts[last] = PRETTY[parts[last]] ?? parts[last];
  return parts.join("+");
}

/**
 * First key currently bound to a standard action, prettified for a hint
 * footer. Falls back when no manager is injected or the action is
 * unbound, so tests and degenerate configs still show the default.
 */
export function keyHint(
  kb: KeybindingsManager | undefined,
  binding: Keybinding,
  fallback: string,
): string {
  const keys = kb?.getKeys(binding);
  const first = keys?.[0];
  return first ? prettyKey(first) : fallback;
}
