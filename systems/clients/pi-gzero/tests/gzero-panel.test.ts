// Tests for the gzero panel (P0 skeleton): tree flattening,
// cursor movement, top-level jumps, expand/collapse, close keys, and
// the left-tree-with-content two-column render.
import { test } from "node:test";
import assert from "node:assert/strict";
const stripVTControlCodes = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
import {
  skillsSectionNodes,
  GzeroPanel,
  historyToNodes,
  routerToNodes,
  docsToNodes,
  flattenTree,
  fuzzyScore,
  headingTree,
  itemsToNodes,
  panelBodyRows,
  skillsToNodes,
  skillId,
  tiersToNodes,
  type ItemPatch,
  type PanelActions,
  type PanelNode,
  type PanelSkills,
} from "../gzero-panel.ts";
import type { RawItem } from "../items-tree.ts";

const item = (over: Partial<RawItem>): RawItem => ({
  id: "xxxx",
  title: "t",
  priority: 0,
  status: "open",
  assignee: "",
  labels: [],
  blocked_by: [],
  blocks: [],
  child_of: [],
  notes: {},
  created: 0,
  ...over,
});

const flatItem = (it: RawItem, depth: number) => ({ item: it, depth });

// Minimal stub theme: pass text through, enough for render().
const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

const tree = (): PanelNode[] => [
  {
    id: "tasks",
    label: "tasks",
    expanded: true,
    children: [{ id: "t1", label: "task one" }],
  },
  {
    id: "context",
    label: "context",
    expanded: true,
    children: [
      { id: "global", label: "global" },
      { id: "local", label: "local" },
      { id: "skills", label: "skills" },
    ],
  },
  {
    id: "documentation",
    label: "documentation",
    children: [{ id: "d1", label: "architecture" }],
  },
];

const make = (
  nodes: PanelNode[] = tree(),
  onDone: () => void = () => {},
  presence?: string,
) => new GzeroPanel(nodes, theme as never, onDone, undefined, undefined, undefined, presence);

test("flattenTree shows children only under expanded parents", () => {
  const rows = flattenTree(tree());
  const ids = rows.map((r) => r.node.id);
  assert.deepEqual(ids, ["tasks", "t1", "context", "global", "local", "skills", "documentation"]);
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[6].depth, 0);
});

test("panelBodyRows scales with terminal rows, with a floor", () => {
  assert.ok(panelBodyRows() >= 6);
});

test("up/down move the cursor within bounds", () => {
  const p = make();
  assert.equal(p.selected.node.id, "t1"); // tree starts inside tasks
  p.handleInput("\x1b[A"); // up at the top stays
  assert.equal(p.selected.node.id, "t1");
});

test("ctrl+q closes the panel (ctrl+q toggles, da36)", () => {
  let closed = false;
  const p = make(tree(), () => {
    closed = true;
  });
  p.handleInput("\x11"); // ctrl+q
  assert.equal(closed, true, "ctrl+q closes like esc");
});

test("showSection opens directly on a section with its first entry", () => {
  const p = make();
  p.showSection(2); // documentation
  assert.equal(get(p, "active"), 2);
  assert.equal(p.selected.node.id, "d1");
  p.showSection(1); // context
  assert.equal(get(p, "active"), 1);
  assert.equal(p.selected.node.id, "global");
  p.showSection(99); // out of range clamps to the last section
  assert.equal(get(p, "active"), 2);
});

test("tab / ctrl+up-down switch the active section, top bar tabs", () => {
  const p = make();
  p.handleInput("\x1b[1;5B"); // ctrl+down → context
  assert.equal(get(p, "active"), 1);
  assert.equal(p.selected.node.id, "global"); // first entry of the section
  p.handleInput("\x1b[1;5B"); // ctrl+down → documentation
  assert.equal(p.selected.node.id, "d1");
  p.handleInput("\t"); // tab wraps to tasks
  assert.equal(get(p, "active"), 0);
  assert.equal(p.selected.node.id, "t1");
  p.handleInput("\x1b[Z"); // shift+tab → back to documentation
  assert.equal(get(p, "active"), 2);
  // Cursor is remembered per section: tasks was on t1.
  p.handleInput("\x1b[Z");
  p.handleInput("\x1b[Z");
  assert.equal(p.selected.node.id, "t1");
});

test("enter toggles children; collapsed parents hide their subtree", () => {
  const p = make();
  p.handleInput("\x1b[1;5B"); // ctrl+down → context
  p.handleInput("\r"); // enter → collapse global (selected entry)
  assert.equal(p.selected.node.id, "global");
  const visible = flattenTree((p as unknown as { nodes: PanelNode[] }).nodes).map((r) => r.node.id);
  assert.ok(visible.includes("global"), "section entry stays visible");
  p.handleInput("\r"); // expand again
  assert.ok(visibleContains((p as unknown as { nodes: PanelNode[] }).nodes, "global"));
});

function visibleContains(nodes: PanelNode[], id: string): boolean {
  return flattenTree(nodes).some((r) => r.node.id === id);
}

test("collapsing above the cursor keeps the cursor valid", () => {
  const p = make(searchableTree());
  p.handleInput("\t"); // context: [tier-global, global-notes, stance, skills, product-stance]
  for (let i = 0; i < 4; i++) p.handleInput("\x1b[B"); // → product-stance (last)
  p.handleInput("\x1b[A\x1b[A"); // up twice → tier-global
  p.handleInput("\r"); // collapse → subtree hidden, rows shrink
  const sel = p.selected;
  assert.ok(["tier-global", "skills", "product-stance"].includes(sel.node.id));
});

test("done fires on escape, q and ctrl+q", () => {
  let closed = 0;
  const p = make(tree(), () => {
    closed++;
  });
  p.handleInput("\x1b");
  p.handleInput("q");
  p.handleInput("\x11"); // ctrl+q
  assert.equal(closed, 3);
});

test("render: sections live in the top bar, tree shows the active section", () => {
  const p = make();
  const out = plain(p.render(100));
  // After the box border, the gzero top bar: title + three tabs with counts.
  assert.ok(out[1].includes("gzero"));
  assert.ok(out[1].includes("tasks 1"));
  assert.ok(out[1].includes("context 3"));
  assert.ok(out[1].includes("documentation 1"));
  // The left tree lists the active section's entries, not the sections.
  const treeSide = out.map((l) => l.slice(0, 40));
  assert.ok(treeSide.some((l) => l.includes("task one")));
  assert.ok(!treeSide.some((l) => l.includes("documentation")), "sections not in the tree");
  // Content area shows the selected node (task one placeholder).
  assert.ok(out.some((l) => l.length > 45 && l.includes("task one")));
});

test("render: presence tag rides in the top bar, absent when empty", () => {
  const withPresence = make(tree(), () => {}, "2 other sessions here");
  const out = plain(withPresence.render(120));
  assert.ok(out[1].includes("⟨ 2 other sessions here ⟩"));

  const solo = make();
  const soloOut = plain(solo.render(120));
  assert.ok(!soloOut.some((l) => l.includes("other session")), "no presence tag when solo");
});

test("render: selection highlight follows the cursor", () => {
  const p = make();
  p.handleInput("\x1b[1;5B"); // ctrl+down → context section
  const out = plain(p.render(100));
  const selected = out.find((l) => l.slice(0, 40).includes("· global"));
  assert.ok(selected, "global row rendered in the tree");
  // Top bar marks the active tab.
  assert.ok(out[1].includes("context"));
});

const plain = (lines: string[]): string[] => lines.map((l) => stripVTControlCodes(l));

// ---- P1 data builders ----

test("itemsToNodes builds the child_of tree with status glyphs and detail", () => {
  const nodes = itemsToNodes([
    item({ id: "p1", title: "parent", status: "in_progress" }),
    item({ id: "c1", title: "child", child_of: ["p1"], priority: 2 }),
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "● parent");
  const child = nodes[0].children![0];
  assert.equal(child.label, "○ child");
  assert.equal(child.id, "c1");
  const detail = child.detail!(80, theme as never);
  assert.ok(detail.some((l) => l.includes("p2 · c1")));
});

test("itemsToNodes surfaces notes in the detail", () => {
  const nodes = itemsToNodes([item({ id: "n1", notes: { a: { text: "a note here" } } })]);
  const detail = nodes[0].detail!(80, theme as never).map((l) => stripVTControlCodes(l));
  assert.ok(detail.some((l) => l.includes("a note here")));
});

test("itemsToNodes renders string-valued notes (storage shape) without crashing", () => {
  // Storage writes plain strings; the {text} shape crashed truncateToWidth.
  const nodes = itemsToNodes([
    item({
      id: "n2",
      title: "write product.md",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notes: { "6881": "Obsolete: the vision section holds this." } as any,
    }),
  ]);
  const detail = nodes[0].detail!(80, theme as never).map((l) => stripVTControlCodes(l));
  assert.ok(detail.some((l) => l.includes("Obsolete: the vision section holds this.")));
});

test("itemDetail tolerates missing fields", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = itemsToNodes([{} as any]);
  const detail = nodes[0].detail!(80, theme as never).map((l) => stripVTControlCodes(l));
  assert.ok(detail[0].includes("(untitled)"));
});

test("tiersToNodes maps tier sections to children with text detail", () => {
  const nodes = tiersToNodes([
    { label: "global", nodes: [{ label: "global/notes", text: "line one\nline two" }] },
  ]);
  assert.equal(nodes[0].label, "global");
  const child = nodes[0].children![0];
  assert.equal(child.label, "notes", "child shows only the section name");
  assert.equal(child.id, "tier-global/global/notes", "id keeps the full header");
  const detail = child.detail!(40, theme as never);
  assert.ok(detail.some((l) => l.includes("line one")));
  assert.ok(detail.some((l) => l.includes("line two")));
});

test("tiersToNodes: local tier shows the scope URL beside it; children stay bare", () => {
  const nodes = tiersToNodes([
    {
      label: "local",
      nodes: [
        { label: "fluid-notion-labs/gzero/notes", text: "a" },
        { label: "fluid-notion-labs/gzero/skills-pipeline", text: "b" },
      ],
    },
  ]);
  assert.equal(nodes[0].label, "local — fluid-notion-labs/gzero");
  assert.deepEqual(nodes[0].children!.map((c) => c.label), ["notes", "skills-pipeline"]);
});

test("tiersToNodes: local without scoped headers keeps the plain label", () => {
  const nodes = tiersToNodes([{ label: "local", nodes: [{ label: "notes", text: "a" }] }]);
  assert.equal(nodes[0].label, "local");
  assert.equal(nodes[0].children![0].label, "notes");
});

test("skillsToNodes lists the catalog with description detail", () => {
  const nodes = skillsToNodes([
    { name: "my-skill", description: "does things", vendor: "fn", file: "/tmp/x/SKILL.md" },
  ]);
  assert.equal(nodes[0].label, "my-skill");
  assert.ok(nodes[0].id.startsWith("skill-fn/my-skill"));
  const detail = nodes[0].detail!(80, theme as never).map((l) => stripVTControlCodes(l));
  assert.ok(detail.some((l) => l.includes("fn · /tmp/x/SKILL.md")));
});

test("headingTree nests headings n-deep and attaches body text", () => {
  const nodes = headingTree(
    [
      "intro text before any heading",
      "# Top",
      "top body",
      "## Sub",
      "sub body",
      "### Deep",
      "deep body",
      "## Second",
      "second body",
    ].join("\n"),
  );
  assert.equal(nodes[0].label, "(intro)");
  const top = nodes[1];
  assert.equal(top.label, "Top");
  const sub = top.children![0];
  assert.equal(sub.label, "Sub");
  const deep = sub.children![0];
  assert.equal(deep.label, "Deep");
  // Deep body text belongs to Deep; Second is a sibling of Sub.
  const deepDetail = deep.detail!(40, theme as never);
  assert.ok(deepDetail.some((l) => l.includes("deep body")));
  assert.equal(top.children![1].label, "Second");
  const secondDetail = top.children![1].detail!(40, theme as never);
  assert.ok(secondDetail.some((l) => l.includes("second body")));
});

test("headingTree skips an over-nested jump (#### after ## nests under ##)", () => {
  const nodes = headingTree(["# A", "## B", "#### D"].join("\n"));
  const a = nodes[0];
  const b = a.children![0];
  assert.equal(b.children![0].label, "D");
});

test("docsToNodes wraps a section body in a heading tree or body fallback", () => {
  const withHeadings = docsToNodes([
    { label: "arch", nodes: [{ label: "Architecture", text: "# Overview\nstuff" }] },
  ]);
  assert.equal(withHeadings[0].label, "arch");
  assert.equal(withHeadings[0].children![0].label, "Overview");

  const plainBody = docsToNodes([
    { label: "now", nodes: [{ label: "Now", text: "just text" }] },
  ]);
  assert.equal(plainBody[0].children![0].label, "(body)");
  const detail = plainBody[0].children![0].detail!(40, theme as never);
  assert.ok(detail.some((l) => l.includes("just text")));
});

test("docsToNodes nests dotted names into a tree, labels show leaf segments", () => {
  const nodes = docsToNodes([
    { label: "cx.doc.tech-dept.cas-document-system", nodes: [{ label: "x", text: "# CAS\nbody" }] },
    { label: "plan.ingest-system", nodes: [{ label: "x", text: "# Ingest" }] },
    { label: "plan.search-index", nodes: [{ label: "x", text: "# Search" }] },
    { label: "polyphase-rename", nodes: [{ label: "x", text: "just text" }] },
  ]);
  const rows = flattenTree(nodes).map((r) => r.node);
  // Every segment is a level; leaf labels are segments, not full names.
  assert.deepEqual(
    rows.map((n) => n.id.replace(/^doc-/, "")),
    [
      "cx",
      "cx.doc",
      "cx.doc.tech-dept",
      "cx.doc.tech-dept.cas-document-system",
      "plan",
      "plan.ingest-system",
      "plan.search-index",
      "polyphase-rename",
    ],
  );
  assert.deepEqual(rows.map((n) => n.label), [
    "cx",
    "doc",
    "tech-dept",
    "cas-document-system",
    "plan",
    "ingest-system",
    "search-index",
    "polyphase-rename",
  ]);
  // The leaf keeps its heading tree; a plain body gets the body leaf.
  const cas = rows[3];
  assert.equal(cas.children![0].label, "CAS");
  const poly = rows[7];
  assert.equal(poly.children![0].label, "(body)");
});

// ---- P3 fuzzy search ----

test("fuzzyScore ranks substring over subsequence, null on no match", () => {
  assert.equal(fuzzyScore("jj", "jj workflow"), 100);
  assert.ok((fuzzyScore("jw", "jj workflow") ?? 0) > 0);
  assert.equal(fuzzyScore("xyz", "jj workflow"), null);
  assert.ok((fuzzyScore("jj", "jj x") ?? 0) > (fuzzyScore("jj", "a jj b jj") ?? 0)); // earliest wins
  assert.ok((fuzzyScore("jc", "j j c") ?? 0) > 0); // streaks help
});

const searchableTree = (): PanelNode[] => [
  {
    id: "tasks",
    label: "tasks",
    expanded: true,
    children: [
      { id: "aaa1", label: "○ fix login bug", searchText: "fix login bug", children: [], item: item({ id: "aaa1", title: "fix login bug", status: "open", priority: 0 }) },
      { id: "bbb2", label: "○ write product.md", searchText: "write product.md", children: [], item: item({ id: "bbb2", title: "write product.md", status: "open", priority: 1 }) },
    ],
  },
  {
    id: "context",
    label: "context",
    expanded: true,
    children: [
      { id: "tier-global", label: "global", children: [
        { id: "tier-global/global-notes", label: "global/notes", searchText: "Begin each task in a jj workspace", detail: () => [] },
      { id: "term-stance", label: "stance", searchText: "product stance definition", detail: () => [] },
      ] },
      { id: "skills", label: "skills", children: [
        { id: "skill-fn/product-stance", label: "product-stance", searchText: "product positioning and stance fn", detail: () => [] },
      ] },
    ],
  },
  { id: "documentation", label: "documentation", children: [
    { id: "doc-arch", label: "architecture", searchText: "ignored — docs are not searchable" },
  ] },
];

const get = (p: GzeroPanel, field: string): unknown =>
  (p as unknown as Record<string, unknown>)[field];

const hits = (p: GzeroPanel): { id: string; category: number }[] =>
  (get(p, "hits") as SearchHit[]).map((h) => ({ id: h.node.id, category: h.category }));

interface SearchHit {
  node: PanelNode;
  category: number;
  score: number;
}

test("slash enters search; scoped to the active section", () => {
  const p = make(searchableTree());
  p.handleInput("/");
  assert.equal(get(p, "mode"), "search");
  p.handleInput("prod"); // in tasks: only the task matches
  let ids = hits(p).map((h) => h.id);
  assert.deepEqual(ids, ["bbb2"]);
  p.handleInput("\t"); // tab → context section, search re-runs
  ids = hits(p).map((h) => h.id);
  assert.ok(ids.includes("skill-fn/product-stance"), "skill matches in context");
});

test("ordering: skills before terms within a section", () => {
  const p = make(searchableTree());
  p.handleInput("\t"); // context section
  p.handleInput("/");
  p.handleInput("product"); // matches skill + term
  const cats = hits(p).map((h) => h.category);
  assert.deepEqual(cats, [1, 2], "skill before term");
  p.handleInput("\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
  p.handleInput("workspace");
  assert.deepEqual(hits(p).map((h) => h.category), [2], "only the term matches");
});

test("documentation nodes are not part of the corpus", () => {
  const p = make(searchableTree());
  p.handleInput("\t\t"); // documentation section
  p.handleInput("/");
  p.handleInput("ignored");
  assert.equal(hits(p).length, 0);
});

test("enter jumps to the hit, expanding ancestors, and returns to tree mode", () => {
  const p = make(searchableTree());
  p.handleInput("\t"); // context section
  p.handleInput("/");
  p.handleInput("workspace"); // term under context > global
  p.handleInput("\r"); // enter → jump
  assert.equal(get(p, "mode"), "tree");
  assert.equal(p.selected.node.id, "tier-global/global-notes");
  // Ancestors expanded: the node is visible in the flattened rows.
  const rows = flattenTree((get(p, "nodes") as PanelNode[]));
  assert.ok(rows.some((r) => r.node.id === "tier-global/global-notes"));
});

test("typing q in search mode edits the query instead of closing", () => {
  let closed = 0;
  const p = make(searchableTree(), () => {
    closed++;
  });
  p.handleInput("/");
  p.handleInput("q");
  assert.equal(closed, 0);
  assert.equal(get(p, "query"), "q");
  p.handleInput("\x1b"); // esc leaves search mode, not the panel
  assert.equal(get(p, "mode"), "tree");
  assert.equal(closed, 0);
  p.handleInput("q"); // in tree mode, q closes
  assert.equal(closed, 1);
});

test("search content shows the query line and result tags", () => {
  const p = make(searchableTree());
  p.handleInput("/");
  p.handleInput("product");
  let out = plain(p.render(100)).join("\n");
  assert.ok(out.includes("/product"));
  assert.ok(out.includes("[task]"));
  p.handleInput("\t"); // context section → skill + term hits
  out = plain(p.render(100)).join("\n");
  assert.ok(out.includes("[skill]"));
});

// ---- P4 edit actions and scoped query ----

test("e opens the action menu on a task, not on other nodes", () => {
  const p = make([
    { id: "tasks", label: "tasks", expanded: true, children: [{ id: "x1", label: "not a task" }] },
  ]);
  p.handleInput("e");
  assert.equal(get(p, "mode"), "tree"); // no item on non-task nodes

  const real = new GzeroPanel(
    [{ id: "tasks", label: "tasks", expanded: true, children: itemsToNodes([item({ id: "t1", title: "do it", status: "open", priority: 1 })]) }],
    theme as never,
    () => {},
    undefined,
    { editItem: async () => {}, reloadItems: async () => [], moveItem: async () => {} },
  );
  real.handleInput("j"); // select the task
  real.handleInput("e");
  assert.equal(get(real, "mode"), "actions");
  const content = plain(real.render(100)).join("\n");
  assert.ok(content.includes("status → in_progress"));
  assert.ok(content.includes("status → closed"));
  assert.ok(content.includes("add note"));
});

test("action menu reflects current status; closed tasks can reopen", () => {
  const real = new GzeroPanel(
    [{ id: "tasks", label: "tasks", expanded: true, children: itemsToNodes([item({ id: "t1", title: "done thing", status: "closed", priority: 0 })]) }],
    theme as never,
    () => {},
    undefined,
    { editItem: async () => {}, reloadItems: async () => [], moveItem: async () => {} },
  );
  real.handleInput("j");
  real.handleInput("e");
  const content = plain(real.render(100)).join("\n");
  assert.ok(!content.includes("status → closed"), "no close action on a closed task");
  assert.ok(content.includes("status → open"));
});

async function actionFixture() {
  const edits: { id: string; patch: ItemPatch }[] = [];
  let items = [
    item({ id: "t1", title: "do it", status: "open", priority: 1 }),
    item({ id: "t2", title: "other", status: "open", priority: 2, child_of: ["t1"] }),
  ];
  const actions: PanelActions = {
    editItem: async (id, patch) => {
      edits.push({ id, patch });
      items = items.map((it) =>
        it.id === id
          ? { ...it, status: patch.status ?? it.status, priority: patch.priority ?? it.priority }
          : it,
      );
    },
    reloadItems: async () => items,
    moveItem: async () => {},
  };
  const p = new GzeroPanel(
    [{ id: "tasks", label: "tasks", expanded: true, children: itemsToNodes(items) }],
    theme as never,
    () => {},
    undefined,
    actions,
  );
  // Cursor starts on the first task (rows begin at the section's children).
  return { p, edits, getItems: () => items };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("enter runs an action, refreshes the tree, keeps the cursor", async () => {
  const { p, edits } = await actionFixture();
  p.handleInput("e");
  p.handleInput("\r"); // run first action: status → in_progress
  await flush();
  assert.deepEqual(edits, [{ id: "t1", patch: { status: "in_progress" } }]);
  assert.equal(get(p, "mode"), "tree");
  assert.equal(p.selected.node.id, "t1");
  assert.equal(p.selected.node.item?.status, "in_progress");
  // Child still in the tree after reload.
  assert.ok(flattenTree((get(p, "nodes") as PanelNode[])).some((r) => r.node.id === "t2"));
});

test("add note flow: menu → note input → typed text → enter saves", async () => {
  const { p, edits } = await actionFixture();
  p.handleInput("e");
  const noteIdx = 4; // last menu entry: add note…
  p.handleInput("\x1b[B");
  p.handleInput("\x1b[B");
  p.handleInput("\x1b[B");
  p.handleInput("\x1b[B");
  p.handleInput("\r");
  assert.equal(get(p, "mode"), "note");
  p.handleInput("remember the thing");
  p.handleInput("\r");
  await flush();
  assert.deepEqual(edits, [{ id: "t1", patch: { note: "remember the thing" } }]);
  assert.equal(get(p, "mode"), "tree");
});

test("esc from the note input returns to the action menu, not the tree", () => {
  let closed = 0;
  const p = new GzeroPanel(
    [{ id: "tasks", label: "tasks", expanded: true, children: itemsToNodes([item({ id: "t1", title: "do it", status: "open", priority: 1 })]) }],
    theme as never,
    () => {
      closed++;
    },
    undefined,
    { editItem: async () => {}, reloadItems: async () => [], moveItem: async () => {} },
  );
  p.handleInput("j");
  p.handleInput("e");
  for (let i = 0; i < 5; i++) p.handleInput("\x1b[B");
  p.handleInput("\r");
  p.handleInput("\x1b");
  assert.equal(get(p, "mode"), "actions");
  assert.equal(closed, 0);
  p.handleInput("\x1b");
  assert.equal(get(p, "mode"), "tree");
  assert.equal(closed, 0);
});

test("section switching scopes the search; tab back and forth", () => {
  const p = make(searchableTree());
  p.handleInput("\t"); // context section
  p.handleInput("/");
  p.handleInput("workspace");
  assert.equal(hits(p).length, 1); // term in context
  p.handleInput("\x1b[Z"); // shift+tab → back to tasks; search re-runs
  assert.equal(hits(p).length, 0, "term is outside the tasks section");
  p.handleInput("\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
  p.handleInput("login"); // a task in tasks
  assert.equal(hits(p).length, 1);
});

test("query tokens: is:open, is:active restrict to matching tasks; p<N> is plain text", () => {
  const p = make(searchableTree());
  p.handleInput("/");
  p.handleInput("is:open");
  const ids = hits(p).map((h) => h.id);
  assert.ok(ids.includes("aaa1") && ids.includes("bbb2"));
  // Token-only query (is:open): both open tasks match.
  assert.equal(hits(p).length, 2);
  p.handleInput("\x1b");
  p.handleInput("/");
  p.handleInput("is:active workspace");
  assert.equal(hits(p).length, 0, "token filter excludes non-tasks");
  // p<N> priority tokens were removed (d61e): treated as plain fuzzy text.
  p.handleInput("\x1b");
  p.handleInput("/");
  p.handleInput("p2");
  assert.equal(hits(p).length, 0, "no task is literally named p2");
});

// ---- queue reordering (m) ----

const moveTree = (): PanelNode[] => [
  {
    id: "tasks",
    label: "tasks",
    expanded: true,
    children: [
      { id: "r1", label: "○ root one", children: [], item: item({ id: "r1", title: "root one", status: "open", priority: 0, order: 1 }) },
      {
        id: "r2",
        label: "○ root two",
        expanded: true,
        item: item({ id: "r2", title: "root two", status: "open", priority: 0, order: 2 }),
        children: [
          { id: "c1", label: "○ child one", children: [], item: item({ id: "c1", title: "child one", status: "open", priority: 0, order: 3, child_of: ["r2"] }) },
          { id: "c2", label: "○ child two", children: [], item: item({ id: "c2", title: "child two", status: "open", priority: 0, order: 4, child_of: ["r2"] }) },
        ],
      },
      { id: "r3", label: "○ root three", children: [], item: item({ id: "r3", title: "root three", status: "open", priority: 0, order: 5 }) },
    ],
  },
];

async function moveFixture() {
  const moves: { id: string; rel: string; sibling: string }[] = [];
  let order: Record<string, number> = { r1: 1, r2: 2, c1: 3, c2: 4, r3: 5 };
  const items = (): RawItem[] =>
    [
      item({ id: "r1", title: "root one", status: "open", priority: 0 }),
      item({ id: "r2", title: "root two", status: "open", priority: 0, child_of: [] }),
      item({ id: "c1", title: "child one", status: "open", priority: 0, child_of: ["r2"] }),
      item({ id: "c2", title: "child two", status: "open", priority: 0, child_of: ["r2"] }),
      item({ id: "r3", title: "root three", status: "open", priority: 0 }),
    ].map((it) => ({ ...it, order: order[it.id] }));
  const actions = {
    editItem: async () => {},
    reloadItems: async () => items(),
    moveItem: async (id: string, rel: string, sibling: string) => {
      moves.push({ id, rel, sibling });
      // Emulate the queue: place id directly before/after sibling.
      const seq = Object.entries(order).sort((a, b) => a[1] - b[1]).map(([k]) => k).filter((k) => k !== id);
      const at = seq.indexOf(sibling) + (rel === "after" ? 1 : 0);
      seq.splice(at, 0, id);
      order = Object.fromEntries(seq.map((k, i) => [k, i + 1]));
    },
  };
  const p = new GzeroPanel(
    [{ id: "tasks", label: "tasks", expanded: true, children: itemsToNodes(items()) }],
    theme as never,
    () => {},
    undefined,
    actions,
  );
  return { p, moves, get order() { return order; } };
}

const flushMove = () => new Promise((resolve) => setImmediate(resolve));

// Select a node by id within the active section's tree.
function select(p: InstanceType<typeof GzeroPanel>, id: string): void {
  const nodes = get(p, "nodes") as PanelNode[];
  const rows = flattenTree(nodes[get(p, "active") as number]?.children ?? []);
  const idx = rows.findIndex((r) => r.node.id === id);
  set(p, "cursor", idx);
  set(p, "rows", rows);
}

// Stubs for the private accessors used in tests.
function set(obj: object, key: string, value: unknown): void {
  (obj as Record<string, unknown>)[key] = value;
}

test("moveStep: sibling swap, then climb to the parent at the edge", () => {
  const { p } = moveFixtureSync();
  select(p, "c2"); // second child of r2
  const step = get(p, "moveStep").call(p, -1);
  assert.deepEqual(step, { id: "c2", rel: "before", sibling: "c1" });
  select(p, "c1"); // first child → the parent r2 moves
  assert.deepEqual(get(p, "moveStep").call(p, -1), { id: "r2", rel: "before", sibling: "r1" });
  select(p, "r1"); // first root → cannot move up
  assert.equal(get(p, "moveStep").call(p, -1), null);
  // Downward mirror image.
  select(p, "c1");
  assert.deepEqual(get(p, "moveStep").call(p, 1), { id: "c1", rel: "after", sibling: "c2" });
  select(p, "c2");
  assert.deepEqual(get(p, "moveStep").call(p, 1), { id: "r2", rel: "after", sibling: "r3" });
  select(p, "r3");
  assert.equal(get(p, "moveStep").call(p, 1), null);
});

function moveFixtureSync() {
  const p = new GzeroPanel(moveTree(), theme as never, () => {}, undefined, {
    editItem: async () => {},
    reloadItems: async () => [],
    moveItem: async () => {},
  });
  return { p };
}

test("m enters move mode; arrow moves the queue and the tree follows", async () => {
  const { p, moves } = await moveFixture();
  select(p, "c1"); // first child of r2
  p.handleInput("m");
  assert.equal(get(p, "mode"), "move");
  p.handleInput("\x1b[A"); // up → r2 moves before r1
  await flushMove();
  assert.deepEqual(moves, [{ id: "r2", rel: "before", sibling: "r1" }]);
  assert.equal(get(p, "mode"), "move", "stays in move mode for repeat presses");
  // After the move, r2 (and its children) display before r1.
  const ids = flattenTree(get(p, "nodes") as PanelNode[]).map((r) => r.node.id);
  const r1 = ids.indexOf("r1");
  const r2 = ids.indexOf("r2");
  const c1 = ids.indexOf("c1");
  assert.ok(r2 < r1, "r2 moved above r1");
  assert.ok(c1 > r2, "child still under r2");
  assert.equal(p.selected.node.id, "c1", "cursor stays on the highlighted task");
  p.handleInput("\x1b");
  assert.equal(get(p, "mode"), "tree");
});

// ---- content-area paging ----

test("pgup/pgdn/home/end page long detail content; selection resets scroll", () => {
  const long = Array.from({ length: 60 }, (_, i) => `line-${i}`);
  const nodes: PanelNode[] = [
    {
      id: "context",
      label: "context",
      expanded: true,
      children: [
        {
          id: "s1",
          label: "rust-engineer",
          children: [],
          detail: (width: number) => long.map((l) => l.slice(0, width)),
        },
        { id: "s2", label: "short", children: [], detail: () => ["brief"] },
      ],
    },
  ];
  const p = new GzeroPanel(nodes, theme as never, () => {}, undefined);
  p.render(100); // populate the content window
  const win = get(p, "contentWin") as { scrollTop: number; viewport: number };
  const vp = win.viewport;
  assert.ok(long.length > vp, "content overflows the viewport");
  p.handleInput("\x1b[6~"); // pgdn
  assert.ok(win.scrollTop > 0, "paged down");
  p.handleInput("\x1b[6~"); // pgdn again → clamps at the end
  const end = win.scrollTop;
  p.handleInput("\x1b[6~");
  assert.equal(win.scrollTop, end, "clamped");
  p.handleInput("\x1b[5~"); // pgup
  assert.ok(win.scrollTop < end, "paged up");
  p.handleInput("\x1b[F"); // end
  assert.equal(win.scrollTop, end);
  p.handleInput("\x1b[H"); // home
  assert.equal(win.scrollTop, 0);
  p.handleInput("\x1b[B"); // move selection → scroll resets to top
  assert.equal(win.scrollTop, 0);
  p.render(100); // refreshed content reflects the new scroll
});

// ---- skills: loaded-only tree, catalog search to load ----

const skillEntry = (name: string, vendor = "fn", description = "") => ({
  name,
  description: description || `${name} skill description`,
  vendor,
  file: `/tmp/${vendor}/${name}/SKILL.md`,
});

async function skillsFixture() {
  const loaded = new Map<string, ReturnType<typeof skillEntry>>([
    ["skill-fn/loaded-one", skillEntry("loaded-one")],
  ]);
  const catalog = [skillEntry("loaded-one"), skillEntry("unloaded-one"), skillEntry("other", "acme")];
  const skills: PanelSkills = {
    catalog: () => catalog,
    activated: () => [...loaded.values()],
    activate: async (id) => {
      const entry = catalog.find((e) => skillId(e) === id);
      if (!entry) throw new Error(`unknown skill ${id}`);
      loaded.set(skillId(entry), entry);
    },
  };
  const nodes: PanelNode[] = [
    { id: "tasks", label: "tasks", expanded: true, children: [] },
    { id: "context", label: "context", expanded: true, children: [{ id: "tier-global", label: "global", children: [] }] },
    {
      id: "skills",
      label: "skills",
      expanded: true,
      children: skillsSectionNodes(skills.activated()),
    },
    { id: "documentation", label: "documentation", children: [] },
  ];
  const p = new GzeroPanel(nodes, theme as never, () => {}, undefined, undefined, skills);
  return { p, loaded, skills };
}

const flushSkill = () => new Promise((resolve) => setImmediate(resolve));

test("catalog search in the skills section finds unloaded skills; enter loads them", async () => {
  const { p, loaded } = await skillsFixture();
  p.handleInput("\t"); // context section
  p.handleInput("\t"); // skills section
  p.handleInput("/");
  p.handleInput("unloaded");
  const hitsList = hits(p);
  assert.deepEqual(hitsList.map((h) => h.id), ["skill-fn/unloaded-one"]);
  const out = plain(p.render(100)).join("\n");
  assert.ok(out.includes("[skill+]"), "catalog hit marked as loadable");
  p.handleInput("\r"); // enter loads the skill
  await flushSkill();
  assert.ok(loaded.has("skill-fn/unloaded-one"), "skill activated");
  // Now it's in the tree (the section lists enabled skills) and out of
  // the loadable set.
  const skillsNode = (get(p, "nodes") as PanelNode[]).find((n) => n.id === "skills");
  const hasNode = (ns: PanelNode[] | undefined, id: string): boolean =>
    (ns ?? []).some((n) => n.id === id || hasNode(n.children, id));
  assert.ok(hasNode(skillsNode?.children, "skill-fn/unloaded-one"), "enabled skill present in the section");
  assert.ok(!hasNode(skillsNode?.children, "skill-fn/other"), "never-enabled catalog skill stays out of the tree");
  const after = plain(p.render(100)).join("\n");
  assert.ok(after.includes("unloaded-one"), "enabled skill listed in the section");
  assert.ok(!after.includes("[skill+] unloaded-one"), "no loadable hits left for this query");
});

test("catalog is only searchable in the skills section", async () => {
  const { p } = await skillsFixture();
  p.handleInput("/"); // tasks section active
  p.handleInput("unloaded");
  assert.deepEqual(hits(p), []);
});

test("collapsed documentation sections keep the tree short", () => {
  const nodes = docsToNodes([
    { label: "arch", nodes: [{ label: "Architecture", text: "# Overview\nstuff" }] },
  ]);
  // PanelNode defaults to collapsed: heading children exist but stay hidden.
  assert.ok(nodes[0].children![0].children!.length >= 0);
  const rows = flattenTree(nodes);
  assert.deepEqual(rows.map((r) => r.node.label), ["arch"]);
});

// ---- skills / router / history sections (panel integration) ----

test("zero-data sections: empty catalog renders without crashing", () => {
  // Regression: "skills 0" — an empty catalog produced zero tree rows and
  // the panel crashed reading the selection (render and enter).
  const p = make([
    { id: "tasks", label: "tasks", expanded: true, children: [] },
    { id: "context", label: "context", expanded: true, children: [] },
    { id: "skills", label: "skills", expanded: true, children: skillsSectionNodes([]) },
    { id: "router", label: "router", expanded: true, children: [] },
    { id: "history", label: "history", expanded: true, children: [] },
    { id: "documentation", label: "documentation", children: [] },
  ]);
  const out = plain(p.render(100)).join("\n");
  assert.ok(out.includes("skills 0"), "tab count reflects the empty section");
  assert.ok(out.includes("(empty)"), "detail pane shows a stub, not a crash");
  p.handleInput("\r"); // enter on an empty section must not throw
  p.handleInput("j");
  p.handleInput("k");
  p.handleInput("\\");
  assert.ok(true);
});

test("skillsSectionNodes lists only enabled skills", () => {
  const loaded = skillEntry("loaded-one");
  const nodes = skillsSectionNodes([loaded]);
  assert.deepEqual(
    nodes.map((n) => n.label),
    ["loaded-one"],
  );
  assert.equal(nodes[0].id, skillId(loaded));
});

test("skills section shows the placeholder when nothing is enabled; search still loads", async () => {
  const loaded = new Set<string>();
  const catalog = [skillEntry("loaded-one"), skillEntry("unloaded-one")];
  const skills: PanelSkills = {
    catalog: () => catalog,
    activated: () => catalog.filter((e) => loaded.has(skillId(e))),
    activate: async (id) => {
      loaded.add(id);
    },
  };
  const nodes: PanelNode[] = [
    { id: "tasks", label: "tasks", expanded: true, children: [] },
    { id: "context", label: "context", expanded: true, children: [] },
    { id: "skills", label: "skills", expanded: true, children: skillsSectionNodes([]) },
    { id: "documentation", label: "documentation", children: [] },
  ];
  const p = new GzeroPanel(nodes, theme as never, () => {}, undefined, undefined, skills);
  p.handleInput("\t"); // context
  p.handleInput("\t"); // skills section
  // Nothing enabled: the tree is empty; navigation and enter stay safe.
  p.handleInput("j");
  p.handleInput("k");
  p.handleInput("\r");
  await flushSkill();
  assert.ok(loaded.size === 0, "enter on the empty section activates nothing");
  // The catalog is still reachable through search.
  p.handleInput("/");
  p.handleInput("unloaded");
  p.handleInput("\r"); // enter on the search hit loads it
  await flushSkill();
  assert.ok(loaded.has("skill-fn/unloaded-one"), "search hit load still works");
});

test("enter on a history prompt inserts its text and closes the panel", () => {
  // loadHistory returns newest first; historyToNodes preserves order.
  const entries = [
    { text: "newer prompt", timestamp: "2026-10-18T02:00:00Z", sessionId: "def67890-xyz" },
    { text: "first prompt\nsecond line", timestamp: "2026-10-18T01:00:00Z", sessionId: "abc12345-xyz" },
  ];
  const nodes: PanelNode[] = [
    { id: "tasks", label: "tasks", expanded: true, children: [] },
    { id: "history", label: "history", expanded: true, children: historyToNodes(entries) },
  ];
  const inserted: string[] = [];
  let closed = 0;
  const p = new GzeroPanel(
    nodes,
    theme as never,
    () => {
      closed++;
    },
    undefined,
    undefined,
    undefined,
    "",
    (text) => inserted.push(text),
  );
  p.handleInput("\t"); // history section
  p.handleInput("\r"); // enter on the newest prompt
  assert.deepEqual(inserted, ["newer prompt"], "insertText passes the full prompt text");
  assert.equal(closed, 1, "panel closes after an insert");
});

test("historyToNodes labels by first line, searchable by full text", () => {
  const nodes = historyToNodes([
    { text: "fix the\nwrapper bug", timestamp: "t", sessionId: "sid" },
  ]);
  assert.equal(nodes[0].label, "fix the");
  const p = new GzeroPanel(
    [{ id: "history", label: "history", expanded: true, children: nodes }],
    theme as never,
    () => {},
  );
  p.handleInput("/");
  p.handleInput("wrapper");
  assert.equal(hits(p).length, 1, "full prompt text is searchable");
});

test("routerToNodes: status, one node per work type, ledger summary", () => {
  const snap = {
    pinned: "fix-errors",
    classifier: "cloudflare/clef-flash",
    threshold: 0.55,
    default: "cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash",
    last: { workType: "research", confidence: 0.9 },
    blessed: [
      { workType: "plan", model: "glm", delegated: false },
      { workType: "fix-errors", model: "qwen", delegated: true },
    ],
  };
  const ledger = {
    total: 3,
    byKind: { classification: 1, route: 1, dispatch: 1 },
    routesByType: { research: 1 },
    dispatchOk: 1,
    dispatchFailed: 0,
    recent: [{ ts: "2026-10-18T01:02:03.000Z", kind: "route", workType: "research", ref: "a/b" }],
  };
  const nodes = routerToNodes(snap, ledger);
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["router-status", "router-types", "router-ledger"],
  );
  const types = nodes[1].children!;
  assert.deepEqual(
    types.map((n) => n.label),
    ["plan → glm", "fix-errors → qwen ⤴"],
  );
  const p = new GzeroPanel(
    [{ id: "router", label: "router", expanded: true, children: nodes }],
    theme as never,
    () => {},
  );
  const out = plain(p.render(100)).join("\n");
  assert.ok(out.includes("pinned: fix-errors"), "status shows the pin");
  // rows: status, work types (+ its 2 children), ledger
  p.handleInput("j");
  p.handleInput("j");
  p.handleInput("j");
  p.handleInput("j"); // ledger node
  const ledgerOut = plain(p.render(100)).join("\n");
  assert.ok(ledgerOut.includes("dispatches: 1 ok, 0 failed"), "ledger summary renders");
});
