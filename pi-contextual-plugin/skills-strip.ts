// skills-strip.ts — a passive, always-on column of loaded skill names,
// one per line, sitting just left of the tasks rail (top-right corner).
//
// Display only: loading/unloading stays in the skills picker and the
// contexture panel. The column re-renders when a skill is loaded
// (addLoadedSkill fires the skills-changed listeners registered here).
// Content is derived live from the loaded-skills map on every render, so
// there is no cache to invalidate. CX_SKILLS_STRIP=0 disables the column.

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getLoadedSkills, onSkillsChanged } from "./skills.ts";

/** Strip mode toggle: CX_SKILLS_STRIP=0 turns the column off. */
export function initialSkillsStripMode(env: NodeJS.ProcessEnv = process.env): "strip" | "off" {
  return env.CX_SKILLS_STRIP === "0" ? "off" : "strip";
}

/** Overlay geometry: sits left of the 5-wide rail (rail margin 1 + 5 + gap 1). */
export const SKILLS_STRIP_WIDTH = 14;
export const SKILLS_STRIP_RIGHT = 7;

/** Pure model: display names truncated to the column width, capped at
 * `cap` entries, plus an overflow flag when more are loaded than shown. */
export function skillCells(
  names: string[],
  cap: number,
  width: number = SKILLS_STRIP_WIDTH,
): { names: string[]; more: boolean } {
  const limit = Math.max(1, cap);
  const trimmed = names.slice(0, limit).map((n) => truncateToWidth(n, width - 2));
  return { names: trimmed, more: names.length > limit };
}

/**
 * The loaded-skills column. Passive: no input handling, no spinner, no
 * refresh cycle — the render reads the live loaded-skills map, and a
 * skills-changed notification triggers a re-render.
 */
export class SkillsStrip implements Component {
  private theme: Theme | null = null;
  private tui: TUI | null = null;
  private off: (() => void) | null = null;

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
    this.off ??= onSkillsChanged(() => this.tui?.requestRender());
  }

  /** Detach the skills-changed listener (controller calls this on close). */
  dispose(): void {
    this.off?.();
    this.off = null;
  }

  /** No cache to invalidate — content is derived live on each render. */
  invalidate(): void {}

  render(_width: number): string[] {
    const theme = this.theme;
    if (!theme) return [];
    const skills = getLoadedSkills();
    if (skills.length === 0) return [];
    // Leave headroom so the column never reaches the chat area.
    const cap = Math.max(1, (process.stdout.rows ?? 40) - 4);
    const { names, more } = skillCells(
      skills.map((s) => s.name),
      cap,
    );
    const lines: string[] = [];
    for (const name of names) {
      lines.push(theme.fg("accent", "✦") + " " + name);
    }
    if (more) lines.push(theme.fg("dim", "  ⋮"));
    return lines;
  }
}
