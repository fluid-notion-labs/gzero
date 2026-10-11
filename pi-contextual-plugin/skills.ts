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
import {
  Input,
  Key,
  SelectList,
  Text,
  matchesKey,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { boxFrame, LineWindow, modalViewport, wrapPlain } from "./window.ts";

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

/** Body below the frontmatter — the actual skill content. */
export function skillBody(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.replace(/^---\n.*?\n---(?:\n|$)/s, "").trim() || text;
  } catch (e) {
    return `could not read ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// --- #skill autocomplete --------------------------------------------------

/**
 * Stacks on the built-in provider: when the token at the cursor starts with
 * `#skill` (optionally `#skill:` + query), it suggests skill references like
 * `#skill:systematic-debugging`. Every other token — including plain `#`
 * hashtags — is delegated to the wrapped provider, so nothing changes for
 * the `@` and `/` flows.
 */
export class SkillsAutocomplete implements AutocompleteProvider {
  triggerCharacters = ["#"];

  constructor(
    private fallback: AutocompleteProvider,
    /** Current skills, or null when discovery hasn't finished yet. */
    private getSkills: () => SkillEntry[] | null,
  ) {}

  private tokenAt(line: string, cursorCol: number): string {
    let start = cursorCol;
    while (start > 0 && !/\s/.test(line[start - 1] ?? " ")) start--;
    return line.slice(start, cursorCol);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const token = this.tokenAt(lines[cursorLine] ?? "", cursorCol);
    if (/^#skill/i.test(token)) {
      const skills = this.getSkills();
      if (skills) {
        const query = (token.match(/^#skill:?(.*)$/i)?.[1] ?? "").toLowerCase();
        const items: AutocompleteItem[] = skills
          .filter((s) => `${s.name} ${s.vendor}`.toLowerCase().includes(query))
          .slice(0, 20)
          .map((s) => ({
            value: `#skill:${s.name} `,
            label: s.name,
            description: `${truncate(s.description, 80)} · ${s.vendor}`,
          }));
        return items.length > 0 ? { items, prefix: token } : null;
      }
    }
    return this.fallback.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol - prefix.length);
    const after = line.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = before + item.value + after;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
  }
}

/** Skill names referenced as `#skill:<name>` in a prompt. */
export function extractSkillRefs(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/#skill:([\w.-]+)/g)].map((m) => m[1].toLowerCase()))];
}

// --- picker component ------------------------------------------------------

/** One interaction = one instance: list (search + select) ↔ detail (read). */
class SkillsPicker implements Component {
  private mode: "list" | "detail" = "list";
  private input = new Input({ placeholder: "search title or description…" });
  private list: SelectList;
  private byValue = new Map<string, SkillEntry>();
  private current: SkillEntry | null = null;
  private window = new LineWindow(modalViewport());
  /** Wrapped detail body, cached per (file, width). */
  private bodyCache: { file: string; width: number; lines: string[] } | null = null;

  constructor(
    private entries: SkillEntry[],
    private theme: Theme,
    private done: (result?: string) => void,
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
    this.bodyCache = null;
    this.window = new LineWindow(modalViewport());
    this.mode = "detail";
  }

  private backToList() {
    this.mode = "list";
    this.current = null;
    this.bodyCache = null;
  }

  handleInput(data: string): void {
    if (this.mode === "detail") {
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        this.backToList();
        return;
      }
      if (matchesKey(data, "ctrl+return") || matchesKey(data, "ctrl+enter")) {
        if (this.current) this.done(`#skill:${this.current.name} `);
        return;
      }
      const s = this.window;
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
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(width - 2, 20);
    const rail = (s: string) => t.fg("borderMuted", s);
    if (this.mode === "detail" && this.current) {
      if (!this.bodyCache || this.bodyCache.file !== this.current.file || this.bodyCache.width !== width) {
        this.bodyCache = {
          file: this.current.file,
          width,
          lines: wrapPlain(skillBody(this.current.file), Math.max(inner - 3, 20)),
        };
        this.window.setLines(this.bodyCache.lines);
      }
      const pos = this.window.scrollable ? ` · ${Math.round(this.window.position * 100)}%` : "";
      return boxFrame(width, [
        ...new Text(t.fg("accent", t.bold(this.current.name)), 1).render(inner),
        ...new Text(t.fg("muted", truncate(this.current.description, 400)), 1).render(inner),
        ...new Text(t.fg("dim", `${this.current.vendor} · ${this.current.file}`), 1).render(inner),
        "",
        ...this.window.render().map((line) => ` ${line}`),
        ...new Text(t.fg("dim", `esc/q back · ctrl+↵ reference · j/k scroll · g/G top/end${pos}`), 1).render(inner),
      ], rail);
    }
    return boxFrame(width, [
      ...new Text(t.fg("accent", t.bold("Skills")), 1).render(inner),
      ...new Text(t.fg("dim", "vendored agent skills — search title & description, enter to read"), 1).render(inner),
      ...this.input.render(Math.max(inner - 2, 20)).map((line) => ` ${line}`),
      ...this.list.render(inner),
      ...new Text(t.fg("dim", "type to filter · ↑↓ select · enter read · esc close"), 1).render(inner),
    ], rail);
  }
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Skills picker is available in TUI mode (/skills)", "warning");
    return;
  }
  const cached = getSkillsCache();
  const skills = cached.length > 0 ? cached : discoverSkills();
  if (skills.length === 0) {
    ctx.ui.notify(
      `No SKILL.md files found (looked in: ${vendorDirs().join(", ")}). Run tools/skills/pull.py to vendor some.`,
      "warning",
    );
    return;
  }
  const reference = await ctx.ui.custom<string | undefined>(
    (_tui, theme, _keybindings, done) => new SkillsPicker(skills, theme, done),
    {
      overlay: true,
      overlayOptions: { width: "75%", minWidth: 70, maxHeight: "85%", anchor: "center" },
    },
  );
  if (reference) ctx.ui.pasteToEditor(reference);
}

// Skills discovered this session; filled shortly after session start and
// shared by the picker and the #skill autocomplete. Accessor functions, not
// an exported binding, so reassignment survives jiti's module interop.
let skillsCache: SkillEntry[] = [];

export function getSkillsCache(): SkillEntry[] {
  return skillsCache;
}

let discovery: Promise<SkillEntry[]> | null = null;

/** Kick off skill discovery without blocking the caller (fills the cache on a microtask). */
export function startDiscovery(): void {
  if (discovery) return;
  discovery = Promise.resolve().then(() => {
    skillsCache = discoverSkills();
    return skillsCache;
  });
}

/** Skills, awaiting a pending discovery when the cache is still empty. */
export async function ensureSkills(): Promise<SkillEntry[]> {
  if (skillsCache.length > 0) return skillsCache;
  if (!discovery) startDiscovery();
  return discovery!;
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
