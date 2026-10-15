// Tests for the loaded-skills column (skills-strip.ts): the pure strip
// model, the env toggle, listener-driven updates, and rendering with a
// stub theme. Loaded skills are session-global state, so render tests
// only assert their own skills are present, not exact totals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type Theme, type TUI } from "@earendil-works/pi-tui";
import { SkillsStrip, initialSkillsStripMode, skillCells } from "../skills-strip.ts";
import {
  SKILLS_STRIP_RIGHT,
  SKILLS_STRIP_WIDTH,
} from "../skills-strip.ts";
import { addLoadedSkill, getLoadedSkills, onSkillsChanged, type SkillEntry } from "../skills.ts";

// Minimal stub theme: pass text through, enough for render().
const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

const entry = (name: string, vendor = "fn-skills"): SkillEntry => ({
  name,
  description: `${name} — test skill`,
  vendor,
  file: `/${vendor}/${name}/SKILL.md`,
});

test("skillCells: truncates long names to the column width", () => {
  const { names } = skillCells(["averyverylongskillname"], 5);
  // width 14 -> name budget 12; truncateToWidth ellipsizes with ANSI
  // escapes around the dots, so assert by visible width.
  assert.equal(visibleWidth(names[0]), 12);
  assert.ok(names[0].startsWith("averyvery"));
});

test("skillCells: caps entries and flags overflow", () => {
  const { names, more } = skillCells(["a", "b", "c"], 2);
  assert.deepEqual(names, ["a", "b"]);
  assert.equal(more, true, "a hidden skill sets the overflow flag");
});

test("skillCells: below cap shows all, no overflow", () => {
  const { names, more } = skillCells(["a", "b", "c"], 5);
  assert.deepEqual(names, ["a", "b", "c"]);
  assert.equal(more, false);
});

test("skillCells: cap never drops below one line", () => {
  const { names } = skillCells(["abcdefgh"], 0, 8);
  assert.equal(names.length, 1);
  assert.ok(visibleWidth(names[0]) <= 6, "width-2 bounds the name");
});

test("initialSkillsStripMode: CX_SKILLS_STRIP=0 disables", () => {
  assert.equal(initialSkillsStripMode({ CX_SKILLS_STRIP: "0" }), "off");
  assert.equal(initialSkillsStripMode({}), "strip");
});

test("geometry: column sits left of the 5-wide rail with a one-cell gap", () => {
  assert.equal(SKILLS_STRIP_RIGHT, 7);
  assert.equal(SKILLS_STRIP_WIDTH, 14);
});

test("addLoadedSkill notifies skills-changed listeners; unsubscribe stops it", () => {
  const calls: string[] = [];
  const off = onSkillsChanged(() => calls.push("fired"));
  addLoadedSkill(entry("listener-skill-a"));
  assert.equal(calls.length, 1);
  off();
  addLoadedSkill(entry("listener-skill-b"));
  assert.equal(calls.length, 1, "unsubscribed listener stays silent");
  assert.ok(getLoadedSkills().some((s) => s.name === "listener-skill-b"));
});

test("SkillsStrip render: one glyph+name line per loaded skill", () => {
  const strip = new SkillsStrip();
  strip.attach(tui, theme);
  addLoadedSkill(entry("alpha-skill")); // 11 chars: fits the 12-char budget
  addLoadedSkill(entry("beta-skill"));
  const lines = strip.render(SKILLS_STRIP_WIDTH);
  const matching = lines.filter((l) => l.includes("alpha-skill") || l.includes("beta-skill"));
  assert.equal(matching.length, 2, "both added skills appear");
  for (const line of matching) assert.match(line, /✦/);
});

test("SkillsStrip render: overflow marker when more skills than the cap", () => {
  const strip = new SkillsStrip();
  strip.attach(tui, theme);
  // Stuff the column past the terminal-height cap (rows-4, min 1).
  const originalRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 8, configurable: true });
  try {
    for (let i = 0; i < 10; i++) addLoadedSkill(entry(`overflow-skill-${i}`));
    const lines = strip.render(SKILLS_STRIP_WIDTH);
    assert.equal(lines.length, 5, "cap = rows-4");
    assert.match(lines[lines.length - 1], /⋮/, "last line is the overflow marker");
  } finally {
    Object.defineProperty(process.stdout, "rows", {
      value: originalRows,
      configurable: true,
    });
  }
});

test("SkillsStrip render: empty when nothing is loaded", () => {
  // Can't clear the global map from outside; instead assert the contract
  // on a fresh strip with no theme (never attached).
  const strip = new SkillsStrip();
  assert.deepEqual(strip.render(SKILLS_STRIP_WIDTH), []);
});
