// Skills picker: alt-s (or /skills) browses the vendored agent skills —
// search by title/description, enter to read the full SKILL.md, esc to
// close. The bag holds distilled atoms; this is the window onto the depth
// they point at. Source of truth: the vendor/ clones that
// tools/skills/pull.py pulls from (CX_SKILLS_DIRS overrides, colon-separated).

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

export interface SkillEntry {
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

/** Chunked async walk: yields to the event loop every few directories so
 * traversal of large vendor trees never blocks the main thread for long. */
async function walkSkillFilesChunked(
  root: string,
  out: string[],
  depth: number,
  state: { dirs: number },
): Promise<void> {
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
    if (st.isDirectory()) {
      await walkSkillFilesChunked(p, out, depth + 1, state);
      if (++state.dirs % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    } else if (e === "SKILL.md") {
      out.push(p);
    }
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
 * Stacks on the built-in provider: any token starting with `#` suggests
 * skill references like `#skill:systematic-debugging`, filtered by what
 * follows the `#` (`#sk` matches names containing "sk"; `#skill:j` the
 * same). Works like `@` does for files — a plain hashtag still types fine,
 * the popup just offers skills while you type. All other tokens are
 * delegated to the wrapped provider (`@` files, `/` commands).
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
    if (token.startsWith("#")) {
      const skills = this.getSkills();
      if (skills) {
        const m = token.match(/^#skill:?(.*)$/i);
        const query = (m ? m[1] : token.slice(1)).toLowerCase();
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
    // Only our own #-prefixed completions take the fast path — everything
    // else (slash commands re-add the "/", @ paths, arguments) has special
    // handling in the wrapped provider that we must not bypass.
    if (!prefix.startsWith("#")) {
      return this.fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol - prefix.length);
    const after = line.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = before + item.value + after;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.fallback.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}

// Skills loaded directly via ctrl+enter in the picker: injected into every
// turn of the session without a chat message. Accessors, not an exported
// binding, so reassignment survives jiti's module interop.
const loadedSkills = new Map<string, SkillEntry>();

export function addLoadedSkill(entry: SkillEntry): void {
  loadedSkills.set(`${entry.vendor}/${entry.name.toLowerCase()}`, entry);
}

export function getLoadedSkills(): SkillEntry[] {
  return [...loadedSkills.values()];
}

/** Skill names referenced as `#skill:<name>` in a prompt. */
export function extractSkillRefs(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/#skill:([\w.-]+)/g)].map((m) => m[1].toLowerCase()))];
}

// --- distillation into the skillbag ---------------------------------------

// Mirrors tools/skills/pull.py's distiller: terse atoms — summary line plus
// one highlight per ## heading. Exact wording only needs to be
// self-consistent: bag atoms dedupe by text, and skills that pull.py already
// imported are skipped by node-header check before we ever add.

const SUMMARY_CAP = 160;
const SECTION_CAP = 140;
const MAX_SECTIONS = 6;
const NOISY = ["|", "dot ", "graph ", "label=", "```"];

function firstSentence(text: string, cap: number): string {
  let t = text.replace(/\*\*/g, "").replace(/```/g, " ").replace(/`/g, "");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^[\-* ]+/, "");
  let sentence = t.split(/(?<=\.)\s/)[0] ?? t;
  if (sentence.length > cap) sentence = `${sentence.slice(0, cap - 1).trimEnd()}…`;
  return sentence;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One atom per line: summary + section highlights, tags riding on each. */
export function distillSkill(entry: SkillEntry): { text: string; tags: string[] }[] {
  let body = "";
  try {
    body = readFileSync(entry.file, "utf8").replace(/^---\n.*?\n---\n?/s, "");
  } catch {
    return [];
  }
  const tags = [
    ...new Set(
      [
        ...Array.from(entry.description.matchAll(/#([a-zA-Z0-9_-]+)/g), (m) => m[1]),
        entry.name,
        entry.vendor,
      ].map((t) => t.toLowerCase()),
    ),
  ];
  const tagSuffix = tags.length > 0 ? ` ${tags.map((t) => `#${t}`).join(" ")}` : "";

  const lines = [`${firstSentence(entry.description, SUMMARY_CAP)}${tagSuffix}`];
  const headings = [...body.matchAll(/^## (.+)$/gm)]
    .map((m) => m[1].split("#")[0].trim())
    .filter((h) => h && h.toLowerCase() !== "overview")
    .slice(0, MAX_SECTIONS);
  for (const heading of headings) {
    const pattern = new RegExp(
      `^## ${escapeRegExp(heading)}.*?\\n\\n(.+?)(?:\\n\\n|\\n#)`,
      "ms",
    );
    const m = body.match(pattern);
    if (!m) continue;
    const under = m[1].replace(/^\s+/, "");
    if (NOISY.some((n) => under.startsWith(n))) continue;
    const slug = heading.toLowerCase().replace(/\s+/g, "-");
    lines.push(`${slug}: ${firstSentence(under, SECTION_CAP)}${tagSuffix}`);
  }
  return lines.map((text) => ({ text, tags }));
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
    private done: (result?: SkillEntry) => void,
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

  /** Ctrl+Enter in all terminal encodings: kitty/CSI report it directly;
   * legacy terminals send LF, which matches only ctrl+j (and return). */
  private isReferenceKey(data: string): boolean {
    return (
      matchesKey(data, "ctrl+return") ||
      matchesKey(data, "ctrl+enter") ||
      matchesKey(data, "ctrl+j")
    );
  }

  handleInput(data: string): void {
    // Diagnostic: CX_SKILLS_KEY_DEBUG=<file> logs every key's hex so unknown
    // terminal encodings can be identified.
    const debugLog = process.env.CX_SKILLS_KEY_DEBUG;
    if (debugLog) {
      try {
        appendFileSync(debugLog, `${Buffer.from(data, "binary").toString("hex")}\n`);
      } catch {
        /* ignore */
      }
    }
    if (this.mode === "detail") {
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        this.backToList();
        return;
      }
      if (
        this.isReferenceKey(data) ||
        matchesKey(data, "return") ||
        matchesKey(data, "enter")
      ) {
        // Enter loads too: terminals that send plain CR for ctrl+enter make
        // the two physically indistinguishable, and Enter has no other use here.
        if (this.current) this.done(this.current);
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
    if (this.isReferenceKey(data)) {
      // Load from the list itself: use the current selection.
      const sel = this.list.getSelectedItem();
      const entry = sel ? this.byValue.get(sel.value) : undefined;
      if (entry) this.done(entry);
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
        ...new Text(t.fg("dim", `esc/q back · enter or ctrl+↵ load for session · j/k scroll · g/G top/end${pos}`), 1).render(inner),
      ], rail);
    }
    return boxFrame(width, [
      ...new Text(t.fg("accent", t.bold("Skills")), 1).render(inner),
      ...new Text(t.fg("dim", "vendored agent skills — search title & description, enter to read"), 1).render(inner),
      ...this.input.render(Math.max(inner - 2, 20)).map((line) => ` ${line}`),
      ...this.list.render(inner),
      ...new Text(t.fg("dim", "type to filter · ↑↓ select · enter read · ctrl+↵ load · esc close"), 1).render(inner),
    ], rail);
  }
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Skills picker is available in TUI mode (/skills)", "warning");
    return;
  }
  const skills = await ensureSkills();
  if (skills.length === 0) {
    ctx.ui.notify(
      `No SKILL.md files found (looked in: ${vendorDirs().join(", ")}). Run tools/skills/pull.py to vendor some.`,
      "warning",
    );
    return;
  }
  const loaded = await ctx.ui.custom<SkillEntry | undefined>(
    (_tui, theme, _keybindings, done) => new SkillsPicker(skills, theme, done),
    {
      overlay: true,
      overlayOptions: { width: "75%", minWidth: 70, maxHeight: "85%", anchor: "center" },
    },
  );
  if (loaded) {
    addLoadedSkill(loaded);
    ctx.ui.notify(
      `${loaded.name} loaded — its full instructions apply to every turn this session (distills into the skillbag on your next message)`,
      "info",
    );
  }
}

// Skills discovered this session; filled shortly after session start and
// shared by the picker and the #skill autocomplete. Accessor functions, not
// an exported binding, so reassignment survives jiti's module interop.
let skillsCache: SkillEntry[] = [];

export function getSkillsCache(): SkillEntry[] {
  return skillsCache;
}

let discovery: Promise<SkillEntry[]> | null = null;

/**
 * Discovery in chunks: reading ~1000 SKILL.md files in one synchronous pass
 * blocks the main thread for ~350ms, which hitches session start and
 /reload. Read in batches, yielding to the event loop between them, so the
 cache fills progressively without a single long stall.
 */
async function discoverChunked(): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const BATCH = 40;
  for (const dir of vendorDirs()) {
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    await walkSkillFilesChunked(dir, files, 0, { dirs: 0 });
    for (let i = 0; i < files.length; i += BATCH) {
      for (const file of files.slice(i, i + BATCH)) {
        try {
          const text = readFileSync(file, "utf8");
          const fm = frontmatter(text);
          const rel = relative(dir, file);
          const vendor = rel.split("/")[0] ?? dir;
          entries.push({
            name: fm.name ?? rel.split("/").slice(-2, -1)[0] ?? file,
            description: fm.description ?? "",
            vendor,
            file,
          });
        } catch {
          continue;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  skillsCache = entries;
  return entries;
}

/** Kick off skill discovery without blocking the caller (fills the cache progressively). */
export function startDiscovery(): void {
  if (discovery) return;
  discovery = discoverChunked();
}

/** Skills, awaiting any in-flight (possibly chunked) discovery for the full list. */
export async function ensureSkills(): Promise<SkillEntry[]> {
  if (!discovery && skillsCache.length === 0) startDiscovery();
  if (discovery) return discovery;
  return skillsCache;
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
