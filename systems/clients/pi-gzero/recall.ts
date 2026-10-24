// recall.ts — the everything-palette engine (docs.palette plan).
//
// A LanceDB sidecar at ~/.pi/agent/recall.lance indexes everything
// worth finding — work items, workflow docs, context atoms, git
// commits, branches, skills — with local fastembed vectors (BGESmall,
// 384-d, no API). Queries are hybrid: semantic ANN plus a lexical
// score so exact ids and hashes always win. The index updates by
// hash diff: only changed entries are re-embedded.
//
// Two degradation paths, both intentional:
// - no LanceDB/fastembed installed  → lexical-only ranking over the
//   freshly collected entries (palette still works);
// - embedder fails at runtime       → same, semantic score just drops.
//
// Data collection is injected (Collectors interface) so tests can run
// the scoring and diff logic without MCP or git.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const run = promisify(execFile);

// ---- regions --------------------------------------------------------

export type RecallRegion =
  | "item"
  | "doc"
  | "atom"
  | "branch"
  | "commit"
  | "skill";

/** The locked legend (docs.palette): one icon per region, always the
 * same, so the eye learns the map. */
export const REGION_ICONS: Record<RecallRegion, string> = {
  item: "☑️",
  doc: "📄",
  atom: "🧠",
  branch: "🌿",
  commit: "⚫",
  skill: "⚡",
};

export const REGION_LABELS: Record<RecallRegion, string> = {
  item: "item",
  doc: "doc",
  atom: "context",
  branch: "branch",
  commit: "commit",
  skill: "skill",
};

/** Region-prefix filters typed into the palette query: "t:login" →
 * items matching login. */
export const REGION_PREFIXES: Record<string, RecallRegion> = {
  t: "item",
  d: "doc",
  x: "atom",
  b: "branch",
  c: "commit",
  k: "skill",
};

/** Split a query into (region filter | null, remaining text). */
export function parseQuery(
  query: string,
): { region: RecallRegion | null; text: string } {
  const m = /^([a-z]):\s*(.*)$/.exec(query.trim());
  if (m && REGION_PREFIXES[m[1]]) {
    return { region: REGION_PREFIXES[m[1]], text: m[2] };
  }
  return { region: null, text: query.trim() };
}

// ---- entries --------------------------------------------------------

export interface RecallEntry {
  /** Stable id, e.g. "item:3d88", "commit:abc1234", "atom:<fnv>". */
  id: string;
  region: RecallRegion;
  /** One-line display label. */
  title: string;
  /** Searchable body (title is searched too). */
  text: string;
  /** Action payload: item id, doc name, commit hash, atom text. */
  ref?: string;
  tags?: string;
  /** Epoch ms, for the recency nudge. */
  updated?: number;
}

/** FNV-1a: cheap stable content hash for the diff. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function entryHash(e: RecallEntry): string {
  return fnv(`${e.region}|${e.title}|${e.text}|${e.ref ?? ""}`);
}

// ---- collectors -----------------------------------------------------

export interface Collectors {
  atoms?: () => Promise<string>; // rendered resolve {scope_prefix:""}
  items?: () => Promise<unknown[]>; // item_list json
  docs?: () => Promise<{ name: string; title: string; body: string }[]>;
  skills?: () => Promise<{ name: string; description: string }[]>;
  /** Repo root for git collection; null → skip git regions. */
  repoRoot?: string | null;
}

/** Parse `resolve {scope_prefix:""}` markdown: `# scope/node` headers
 * with `- text` bullets. */
export function parseAtoms(markdown: string): RecallEntry[] {
  const out: RecallEntry[] = [];
  let scope = "";
  for (const line of markdown.split("\n")) {
    const h = /^# (.+)$/.exec(line.trim());
    if (h) {
      scope = h[1];
      continue;
    }
    const b = /^- (.+)$/.exec(line.trim());
    if (b && b[1].trim() && b[1] !== "(no matching context)") {
      const text = b[1].trim();
      out.push({
        id: `atom:${fnv(text)}`,
        region: "atom",
        title: text.length > 72 ? text.slice(0, 69) + "…" : text,
        text,
        ref: text,
        tags: scope,
      });
    }
  }
  return out;
}

interface RawItem {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  /** item_list shape varies by version: string notes or a list. */
  notes?: string[] | string;
  labels?: string[];
}

/** Collect git commits and branches from the repo root. jj-colocated
 * repos get their bookmarks via `jj bookmark list`; commits come from
 * git log (works everywhere, includes workspace commits). */
export async function collectGit(
  repoRoot: string,
): Promise<{ commits: RecallEntry[]; branches: RecallEntry[] }> {
  const commits: RecallEntry[] = [];
  const branches: RecallEntry[] = [];
  try {
    const { stdout } = await run("git", ["log", "--max-count=300", "--format=%H%x09%h%x09%s%x09%cI"], {
      cwd: repoRoot,
    });
    for (const line of stdout.split("\n")) {
      const [hash, short, subject, date] = line.split("\t");
      if (!hash || !subject) continue;
      commits.push({
        id: `commit:${short}`,
        region: "commit",
        title: `${short} ${subject}`,
        text: `${short} ${subject} ${hash}`,
        ref: short,
        updated: date ? Date.parse(date) : undefined,
      });
    }
  } catch {
    // not a git repo / git missing — no commit region
  }
  try {
    const { stdout } = await run("jj", ["bookmark", "list"], { cwd: repoRoot });
    for (const line of stdout.split("\n")) {
      const m = /^(\S+): (\S+)/.exec(line.trim());
      if (m && !m[1].startsWith("push-")) {
        branches.push({
          id: `branch:${m[1]}`,
          region: "branch",
          title: m[1],
          text: `branch ${m[1]} ${m[2]}`,
          ref: m[1],
        });
      }
    }
  } catch {
    // plain git repo — fall back to local branches
    try {
      const { stdout } = await run("git", ["branch", "--format=%(refname:short)"], {
        cwd: repoRoot,
      });
      for (const name of stdout.split("\n")) {
        const b = name.trim();
        if (b) {
          branches.push({
            id: `branch:${b}`,
            region: "branch",
            title: b,
            text: `branch ${b}`,
            ref: b,
          });
        }
      }
    } catch {
      // no branches region
    }
  }
  return { commits, branches };
}

/** Gather entries from all collectors; each source fails soft. */
export async function collectEntries(c: Collectors): Promise<RecallEntry[]> {
  const results = await Promise.allSettled([
    c.atoms?.() ?? Promise.resolve(null),
    c.items?.() ?? Promise.resolve(null),
    c.docs?.() ?? Promise.resolve(null),
    c.skills?.() ?? Promise.resolve(null),
    c.repoRoot ? collectGit(c.repoRoot) : Promise.resolve(null),
  ]);
  const entries: RecallEntry[] = [];
  const [atomsR, itemsR, docsR, skillsR, gitR] = results;

  if (atomsR.status === "fulfilled" && typeof atomsR.value === "string") {
    entries.push(...parseAtoms(atomsR.value));
  }
  if (itemsR.status === "fulfilled" && Array.isArray(itemsR.value)) {
    for (const raw of itemsR.value as RawItem[]) {
      if (!raw?.id) continue;
      const notes = Array.isArray(raw.notes)
        ? raw.notes.map(String).join(" ")
        : typeof raw.notes === "string"
          ? raw.notes
          : "";
      entries.push({
        id: `item:${raw.id}`,
        region: "item",
        title: `${raw.id} ${raw.title}`,
        text: `${raw.id} ${raw.title} ${raw.status ?? ""} ${(raw.labels ?? []).join(" ")} ${notes}`.trim(),
        ref: raw.id,
      });
    }
  }
  if (docsR.status === "fulfilled" && Array.isArray(docsR.value)) {
    for (const d of docsR.value) {
      if (!d?.name) continue;
      entries.push({
        id: `doc:${d.name}`,
        region: "doc",
        title: d.title || d.name,
        text: `${d.name} ${d.title} ${d.body}`.trim(),
        ref: d.name,
      });
    }
  }
  if (skillsR.status === "fulfilled" && Array.isArray(skillsR.value)) {
    for (const s of skillsR.value) {
      if (!s?.name) continue;
      entries.push({
        id: `skill:${s.name}`,
        region: "skill",
        title: s.name,
        text: `${s.name} ${s.description}`,
        ref: s.name,
      });
    }
  }
  if (gitR.status === "fulfilled" && gitR.value) {
    entries.push(...gitR.value.commits, ...gitR.value.branches);
  }
  return entries;
}

// ---- ranking --------------------------------------------------------

/** Lexical score in [0,1]: exact substring and per-word hits on the
 * title (weighted double) and body. Deterministic, no dependencies —
 * the floor under the semantic score and the whole ranking when the
 * vector side is unavailable. */
export function lexicalScore(query: string, e: RecallEntry): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const title = e.title.toLowerCase();
  const text = e.text.toLowerCase();
  let score = 0;
  if (title.includes(q)) score += 0.6;
  else if (text.includes(q)) score += 0.35;
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 1) {
    let hits = 0;
    for (const w of words) {
      // title hits weigh double — the title is what the eye reads first
      if (title.includes(w)) hits += 1;
      else if (text.includes(w)) hits += 0.5;
    }
    score += 0.25 * (hits / words.length);
  }
  return Math.min(1, score);
}

/** Recency nudge in [0,0.1]: full for entries touched in the last day,
 * fading over a month. */
export function recencyScore(e: RecallEntry, now: number): number {
  if (!e.updated) return 0;
  const days = Math.max(0, (now - e.updated) / 86_400_000);
  return 0.1 * Math.max(0, 1 - days / 30);
}

export interface ScoredEntry {
  entry: RecallEntry;
  score: number;
  /** Pure lexical fallback/boost, surfaced for tests and debug. */
  lexical: number;
  /** Semantic similarity in [0,1] when vectors were used. */
  semantic?: number;
}

/** Hybrid ranking over already-gathered candidates. With similarities
 * (from ANN) it's 0.6 semantic + 0.3 lexical + recency; without, it's
 * lexical + recency. Pure — tests run this directly. */
export function rank(
  candidates: { entry: RecallEntry; similarity?: number }[],
  query: string,
  now = Date.now(),
): ScoredEntry[] {
  const scored = candidates.map((c) => {
    const lexical = lexicalScore(query, c.entry);
    const semantic = c.similarity;
    const score =
      semantic !== undefined
        ? 0.6 * semantic + 0.3 * lexical + recencyScore(c.entry, now)
        : lexical + recencyScore(c.entry, now);
    return { entry: c.entry, score, lexical, semantic };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---- the index ------------------------------------------------------

const DIMS = 384; // fastembed BGESmall

/** Hashes by id, read out of the table for the diff. */
export interface ExistingHashes {
  [id: string]: string;
}

export class RecallIndex {
  private table: any | undefined;
  private embedder:
    | { embed: (texts: string[]) => Promise<number[][]> }
    | undefined;
  private embedderTried = false;
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), ".pi", "agent", "recall.lance");
  }

  get available(): boolean {
    return this.table !== undefined;
  }

  /** True once the embedder is usable (or known-unusable). */
  get semantic(): boolean {
    return this.embedder !== undefined;
  }

  /** Open/create the table; returns false when LanceDB is missing. */
  async open(): Promise<boolean> {
    if (this.table) return true;
    try {
      const lancedb = await import("@lancedb/lancedb");
      const arrow = await import("apache-arrow");
      const db = await lancedb.connect(this.dir);
      const schema = new arrow.Schema([
        new arrow.Field("id", new arrow.Utf8()),
        new arrow.Field("region", new arrow.Utf8()),
        new arrow.Field("title", new arrow.Utf8()),
        new arrow.Field("text", new arrow.Utf8()),
        new arrow.Field("ref", new arrow.Utf8()),
        new arrow.Field("hash", new arrow.Utf8()),
        new arrow.Field("updated", new arrow.Float64()),
        new arrow.Field(
          "vec",
          new arrow.FixedSizeList(DIMS, new arrow.Field("item", new arrow.Float32(), true)),
        ),
      ]);
      const names = await db.tableNames();
      this.table = names.includes("entries")
        ? await db.openTable("entries")
        : await db.createTable("entries", [], { schema });
      return true;
    } catch {
      this.table = undefined;
      return false;
    }
  }

  /** Lazy fastembed init; null when unavailable (no download attempt
   * is made twice). */
  private async getEmbedder() {
    if (this.embedderTried) return this.embedder;
    this.embedderTried = true;
    try {
      const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
      // BGE-small-en: 384-d, the model the docs.palette plan chose.
      // cacheDir defaults to './local_cache' relative to the CWD — pin
      // it to the user cache so the ~127MB model downloads once, no
      // matter which directory the session started in.
      const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
      const fe = await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallEN,
        cacheDir: path.join(cacheRoot, "fastembed"),
      });
      this.embedder = {
        embed: async (texts: string[]) => {
          const iter = await fe.embed(texts);
          // embed yields batches: each next() is an array of vectors.
          const out: number[][] = [];
          for await (const batch of iter) out.push(...batch);
          return out;
        },
      };
    } catch {
      this.embedder = undefined;
    }
    return this.embedder;
  }

  private async embedTexts(texts: string[]): Promise<number[][] | null> {
    const emb = await this.getEmbedder();
    if (!emb) return null;
    try {
      return await emb.embed(texts);
    } catch {
      return null;
    }
  }

  /** Read existing hashes for the diff. */
  async existingHashes(): Promise<ExistingHashes> {
    if (!this.table) return {};
    try {
      const rows = await this.table.query().select(["id", "hash"]).toArray();
      const out: ExistingHashes = {};
      for (const r of rows) out[r.id] = r.hash ?? "";
      return out;
    } catch {
      return {};
    }
  }

  /** Diff the given entries against the table: upsert changed, delete
   * vanished. Returns {upserted, removed} counts. Never throws — a
   * failed update leaves the stale index searchable. */
  async update(entries: RecallEntry[]): Promise<{ upserted: number; removed: number }> {
    if (!this.table) return { upserted: 0, removed: 0 };
    const existing = await this.existingHashes();
    const wanted = new Set(entries.map((e) => e.id));
    const changed = entries.filter((e) => existing[e.id] !== entryHash(e));
    const removed = Object.keys(existing).filter((id) => !wanted.has(id));

    try {
      let vectors: number[][] | null = null;
      if (changed.length > 0) {
        vectors = await this.embedTexts(
          changed.map((e) => `${e.title}\n${e.text.slice(0, 2000)}`),
        );
      }
      if (removed.length > 0) {
        const list = removed.map((id) => `'${id.replace(/'/g, "")}'`).join(",");
        await this.table.delete(`id IN (${list})`);
      }
      if (changed.length > 0) {
        const rows = changed.map((e, i) => ({
          id: e.id,
          region: e.region,
          title: e.title,
          text: e.text.slice(0, 8000),
          ref: e.ref ?? "",
          hash: entryHash(e),
          updated: e.updated ?? 0,
          vec: vectors ? vectors[i] : [],
        }));
        await this.table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(rows);
      }
      return { upserted: changed.length, removed: removed.length };
    } catch {
      return { upserted: 0, removed: 0 };
    }
  }

  /** Hybrid search: ANN (prefiltered by region) plus lexical, merged by
   * rank(). Falls back to pure lexical over `fallbackEntries` when the
   * table or vectors are unavailable. */
  async search(
    query: string,
    opts: {
      region?: RecallRegion | null;
      limit?: number;
      fallbackEntries?: RecallEntry[];
    } = {},
  ): Promise<ScoredEntry[]> {
    const limit = opts.limit ?? 12;
    const parsed = opts.region ? { region: opts.region, text: query } : parseQuery(query);
    if (!parsed.text) return [];

    const candidates: { entry: RecallEntry; similarity?: number }[] = [];
    if (this.table) {
      try {
        const vector = await this.embedTexts([parsed.text]);
        // .search() lives on the table (vector query builder), not on
        // query(); both take .where() and .limit().
        let q = vector
          ? this.table.search(Array.from(vector[0]))
          : this.table.query();
        if (parsed.region) {
          q = q.where(`region = '${parsed.region}'`);
        }
        q = q.limit(vector ? 64 : 500);
        const rows = await q.toArray();
        for (const r of rows) {
          candidates.push({
            entry: {
              id: r.id,
              region: r.region,
              title: r.title,
              text: r.text,
              ref: r.ref,
              updated: r.updated ? Number(r.updated) : undefined,
            },
            similarity: r._distance !== undefined ? 1 / (1 + Number(r._distance)) : undefined,
          });
        }
      } catch {
        // stale/broken index — fall through to fallback entries
      }
    }
    if (candidates.length === 0 && opts.fallbackEntries?.length) {
      const { region, text } = parsed;
      for (const e of opts.fallbackEntries) {
        if (region && e.region !== region) continue;
        candidates.push({ entry: e });
      }
    }
    return rank(candidates, parsed.text).slice(0, limit);
  }
}
