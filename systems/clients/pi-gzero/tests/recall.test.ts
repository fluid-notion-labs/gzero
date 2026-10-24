// Tests for recall.ts: query parsing, atom parsing, hybrid ranking,
// lexical fallback, and the hash-diff math (docs.palette plan).
// The vector parts (LanceDB, fastembed) are exercised live, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectEntries,
  entryHash,
  lexicalScore,
  parseAtoms,
  parseQuery,
  rank,
  REGION_PREFIXES,
  type RecallEntry,
} from "../recall.ts";

function entry(partial: Partial<RecallEntry> & Pick<RecallEntry, "id" | "region" | "title" | "text">): RecallEntry {
  return { ...partial };
}

test("parseQuery: bare text has no region", () => {
  const p = parseQuery("passkey auth");
  assert.equal(p.region, null);
  assert.equal(p.text, "passkey auth");
});

test("parseQuery: every documented prefix maps to its region", () => {
  assert.equal(REGION_PREFIXES.t, "item");
  assert.equal(REGION_PREFIXES.d, "doc");
  assert.equal(REGION_PREFIXES.x, "atom");
  assert.equal(REGION_PREFIXES.b, "branch");
  assert.equal(REGION_PREFIXES.c, "commit");
  assert.equal(REGION_PREFIXES.k, "skill");
  const p = parseQuery("t: login");
  assert.equal(p.region, "item");
  assert.equal(p.text, "login");
});

test("parseQuery: unknown prefixes stay text", () => {
  const p = parseQuery("z: nope");
  assert.equal(p.region, null);
  assert.equal(p.text, "z: nope");
});

test("parseAtoms: headers scope the bullets", () => {
  const md = `# global/notes
- alpha fact
- beta fact

# gzero/notes
- gamma fact`;
  const atoms = parseAtoms(md);
  assert.equal(atoms.length, 3);
  assert.equal(atoms[0].text, "alpha fact");
  assert.equal(atoms[0].region, "atom");
  assert.equal(atoms[2].tags, "gzero/notes");
  // stable ids from content
  assert.equal(atoms[0].id, atoms[0].id);
  assert.notEqual(atoms[0].id, atoms[2].id);
});

test("parseAtoms: empty and placeholder bodies yield nothing", () => {
  assert.deepEqual(parseAtoms("(no matching context)"), []);
  assert.deepEqual(parseAtoms("# a/b\n- \n"), []);
});

test("lexicalScore: exact title substring beats body-only", () => {
  const t = entry({ id: "1", region: "item", title: "passkey auth", text: "more words" });
  const b = entry({ id: "2", region: "doc", title: "something else", text: "about passkey auth" });
  assert.ok(lexicalScore("passkey auth", t) > lexicalScore("passkey auth", b));
  // full phrase in title (0.6) plus both words in title (+0.25)
  assert.equal(lexicalScore("passkey auth", t), 0.85);
});

test("lexicalScore: multi-word partial matches score proportionally", () => {
  const e = entry({ id: "1", region: "atom", title: "unrelated", text: "login page bug" });
  const s = lexicalScore("login bug", e);
  assert.ok(s > 0 && s < 0.6);
});

test("lexicalScore: empty query scores zero", () => {
  assert.equal(lexicalScore("", entry({ id: "1", region: "doc", title: "x", text: "y" })), 0);
});

test("rank without similarity: lexical order with recency nudge", () => {
  const now = Date.now();
  const old = entry({ id: "o", region: "commit", title: "fix bug", text: "fix bug", updated: now - 90 * 86_400_000 });
  const fresh = entry({ id: "f", region: "commit", title: "fix bug", text: "fix bug", updated: now });
  const ranked = rank(
    [
      { entry: old },
      { entry: fresh },
      { entry: entry({ id: "n", region: "doc", title: "nothing", text: "else" }) },
    ],
    "fix bug",
    now,
  );
  assert.equal(ranked[0].entry.id, "f"); // fresh beats old on recency
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[2].score < ranked[0].score);
});

test("rank with similarity: semantic can outrank lexical, but exact lexical is strong", () => {
  const exact = entry({ id: "e", region: "atom", title: "gz1_ device tokens", text: "gz1_ device tokens hashed" });
  const fuzzy = entry({ id: "fz", region: "doc", title: "tokens overview", text: "about tokens" });
  const ranked = rank(
    [
      { entry: exact }, // lexical 0.6
      { entry: fuzzy, similarity: 0.95 }, // semantic 0.57 + tiny lexical
    ],
    "gz1_ device tokens",
  );
  assert.equal(ranked[0].entry.id, "e");
});

test("collectEntries: item notes as string or missing never throw (crash regression)", async () => {
  // The live crash: item_list returned notes as a plain string; the
  // old code called .join on it and the unhandled rejection killed pi.
  const entries = await collectEntries({
    items: () =>
      Promise.resolve([
        { id: "a1", title: "string notes", notes: "single note text" },
        { id: "a2", title: "array notes", notes: ["one", "two"] },
        { id: "a3", title: "no notes" },
        { id: "a4", title: "weird notes", notes: 42 },
        null,
      ] as unknown as { id: string; title: string; notes?: string[] | string }[]),
  });
  const byId = new Map(entries.map((e) => [e.id, e]));
  assert.ok(byId.has("item:a1"));
  assert.match(byId.get("item:a1")!.text, /single note text/);
  assert.match(byId.get("item:a2")!.text, /one two/);
  assert.ok(byId.has("item:a3"));
  assert.ok(byId.has("item:a4")); // coerced away, not fatal
  assert.equal(entries.length, 4);
});

test("entryHash: content-sensitive and stable", () => {
  const a = entry({ id: "1", region: "doc", title: "t", text: "body" });
  const b = entry({ id: "1", region: "doc", title: "t", text: "body" });
  const c = entry({ id: "1", region: "doc", title: "t", text: "body2" });
  assert.equal(entryHash(a), entryHash(b));
  assert.notEqual(entryHash(a), entryHash(c));
});
