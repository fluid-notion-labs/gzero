// Skills picker: alt-s (or /skills) browses the vendored agent skills —
// search by title/description, enter to read the full SKILL.md, esc to
// close. The bag holds distilled atoms; this is the window onto the depth
// they point at. Source of truth: the vendor/ clones that
// tools/skills/pull.py pulls from (CX_SKILLS_DIRS overrides, colon-separated).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  ScrollView,
  SelectList,
  Text,
  matchesKey,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";

interface SkillEntry {
  name: string;
  description: string;
  /** Vendor repo directory, e.g. "jj-skills". */
  vendor: string;
  file: string;
}

const MAX_VISIBLE = 12;

// --- discovery -----------------------------------------------------------

function vendorDirs(): string[] {
  const env = process.env.CX_SKILLS_DIRS;
  if (env?.trim()) return env.split(":").filter(Boolean);
  // Defaults, in order: the vendor dir beside the checkout that ships this
  // plugin; the known contextual repo location; any `vendor/` above cwd.
  const dirs = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "vendor"),
    join(homedir(), "projects", "explorations", "nursery", "contextual", "vendor"),
  ];
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    dirs.push(join(dir, "vendor"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(dirs)];
}

/** Recursively collect SKILL.md paths under a root, shallow (skip node_modules/.git). */
function walkSkillFiles(root: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".") || e === "node_modules" || e === "target") continue;
    const p = join(root, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkSkillFiles(p, out, depth + 1);
    else if (e === "SKILL.md") out.push(p);
  }
}

/** Minimal YAML frontmatter read: name + description, folded styles included. */
function frontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\n(.*?)\n---(?:\n|$)/s);
  if (!m) return {};
  let name: string | undefined;
  let description: string | undefined;
  let collecting: "description" | null = null;
  const buf: string[] = [];
  const endFold = () => {
    if (collecting) description = buf.join(" ");
    collecting = null;
  };
  for (const line of m[1].split("\n")) {
    if (collecting) {
      if (/^\s/.test(line)) {
        buf.push(line.trim());
        continue;
      }
      endFold();
    }
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name") {
      if (val) name = val;
    } else if (val && !/^[>|]/.test(val)) {
      description = val;
    } else {
      collecting = "description";
      buf.length = 0;
    }
  }
  endFold();
  return { name, description };
}

export function discoverSkills(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const dir of vendorDirs()) {
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walkSkillFiles(dir, files);
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const fm = frontmatter(text);
      const rel = relative(dir, file);
      const vendor = rel.split("/")[0] ?? dir;
      entries.push({
        name: fm.name ?? rel.split("/").slice(-2, -1)[0] ?? file,
        description: fm.description ?? "",
        vendor,
        file,
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** All whitespace-separated terms must appear (case-insensitive) in name or description. */
function matches(entry: SkillEntry, query: string): boolean {
  const hay = `${entry.name} ${entry.description} ${entry.vendor}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

function truncate(text: string, cap: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > width && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/** Body below the frontmatter — the actual skill content. */
function skillBody(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.replace(/^---\n.*?\n---(?:\n|$)/s, "").trim() || text;
  } catch (e) {
    return `could not read ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// --- picker component ------------------------------------------------------

/** One interaction = one instance: list (search + select) ↔ detail (read). */
class SkillsPicker implements Component {
  private mode: "list" | "detail" = "list";
  private input = new Input({ placeholder: "search title or description…" });
  private list: SelectList;
  private byValue = new Map<string, SkillEntry>();
  private current: SkillEntry | null = null;
  private scroll: ScrollView | null = null;

  constructor(
    private entries: SkillEntry[],
    private theme: Theme,
    private done: (result?: unknown) => void,
  ) {
    this.input.focused = true;
    this.list = this.rebuildList("");
  }

  private listTheme() {
    const t = this.theme;
    return {
      selectedPrefix: (text: string) => t.fg("accent", text),
      selectedText: (text: string) => t.fg("accent", text),
      description: (text: string) => t.fg("muted", text),
      scrollInfo: (text: string) => t.fg("dim", text),
      noMatch: (text: string) => t.fg("warning", text),
    };
  }

  private rebuildList(query: string): SelectList {
    const entries = this.entries.filter((e) => matches(e, query));
    this.byValue.clear();
    const items: SelectItem[] = entries.map((e) => {
      const value = e.file;
      this.byValue.set(value, e);
      return {
        value,
        label: e.name,
        description: `${truncate(e.description, 64)}  ·  ${e.vendor}`,
      };
    });
    const list = new SelectList(items, MAX_VISIBLE, this.listTheme());
    list.onSelect = (item) => {
      const entry = this.byValue.get(item.value);
      if (entry) this.openDetail(entry);
    };
    list.onCancel = () => this.done();
    return list;
  }

  private openDetail(entry: SkillEntry) {
    this.current = entry;
    this.scroll = new ScrollView(new Text(skillBody(entry.file), 1, 1), { scrollbar: "auto" });
    this.mode = "detail";
  }

  private backToList() {
    this.mode = "list";
    this.scroll = null;
    this.current = null;
  }

  handleInput(data: string): void {
    if (this.mode === "detail") {
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        this.backToList();
        return;
      }
      const s = this.scroll!;
      if (matchesKey(data, "up") || matchesKey(data, "k")) s.scrollBy(-3);
      else if (matchesKey(data, "down") || matchesKey(data, "j")) s.scrollBy(3);
      else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) s.scrollBy(-20);
      else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) s.scrollBy(20);
      else if (matchesKey(data, "home")) s.scrollToStart();
      else if (matchesKey(data, "end") || data === "G") s.scrollToEnd();
      else if (matchesKey(data, "g")) s.scrollToStart();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown")
    ) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, "return")) {
      const sel = this.list.getSelectedItem();
      const entry = sel ? this.byValue.get(sel.value) : undefined;
      if (entry) this.openDetail(entry);
      return;
    }
    this.input.handleInput(data);
    this.list = this.rebuildList(this.input.getValue());
  }

  invalidate(): void {
    this.list.invalidate();
    this.scroll?.invalidate();
  }

  render(width: number): string[] {
    const t = this.theme;
    if (this.mode === "detail" && this.current) {
      const head: string[] = [];
      head.push(t.fg("accent", t.bold(this.current.name)));
      for (const line of wrap(truncate(this.current.description, 400), Math.max(width - 2, 20))) {
        head.push(t.fg("muted", line));
      }
      head.push(t.fg("dim", `${this.current.vendor} · ${this.current.file}`));
      return [
        ...head.map((l) => ` ${l}`),
        t.fg("accent", "─".repeat(Math.max(width, 20))),
        ...(this.scroll?.render(width) ?? []),
        t.fg("accent", "─".repeat(Math.max(width, 20))),
        ` ${t.fg("dim", "esc/q back · j/k scroll · g/G top/end")}`,
      ];
    }
    return [
      ` ${t.fg("accent", t.bold("Skills"))}`,
      ...this.input.render(Math.max(width - 2, 20)).map((line) => ` ${line}`),
      ...this.list.render(width),
      ` ${t.fg("dim", "type to search · enter read · esc close")}`,
    ];
  }
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Skills picker is available in TUI mode (/skills)", "warning");
    return;
  }
  const skills = discoverSkills();
  if (skills.length === 0) {
    ctx.ui.notify(
      `No SKILL.md files found (looked in: ${vendorDirs().join(", ")}). Run tools/skills/pull.py to vendor some.`,
      "warning",
    );
    return;
  }
  await ctx.ui.custom((_tui, theme, _keybindings, done) => new SkillsPicker(skills, theme, done));
}

export function registerSkills(pi: ExtensionAPI): void {
  pi.registerShortcut(Key.alt("s"), {
    description: "Browse vendored agent skills",
    handler: async (ctx) => openPicker(ctx),
  });
  pi.registerCommand("skills", {
    description: "Browse vendored agent skills (search, read)",
    handler: async (_args, ctx) => openPicker(ctx),
  });
}
