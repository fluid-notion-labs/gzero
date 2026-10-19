import { describe, expect, it } from "vitest";
import { LegacyMerge, Op, Snapshot, validOps } from "../src/legacy-merge";

const atom = (text: string, node = "n", tags: string[] = []): Op["atom"] => ({
  text,
  scope: "s",
  node,
  tags,
});

describe("merge semantics", () => {
  it("puts and resolves", () => {
    const merge = new LegacyMerge();
    merge.apply([{ op: "put", atom: atom("keep it terse") }]);
    const snap = merge.snapshot();
    expect(snap.atoms).toHaveLength(1);
    expect(snap.atoms[0].text).toBe("keep it terse");
    expect(snap.tombstones).toHaveLength(0);
  });

  it("remove wins over concurrent/replayed put (OR-set)", () => {
    const merge = new LegacyMerge();
    merge.apply([{ op: "put", atom: atom("x") }]);
    merge.apply([{ op: "remove", atom: atom("x") }]);
    merge.apply([{ op: "put", atom: atom("x") }]); // replay / concurrent add
    expect(merge.snapshot().atoms).toHaveLength(0);
    expect(merge.snapshot().tombstones.map((a) => a.text)).toEqual(["x"]);
  });

  it("remove without prior put still records the tombstone (kill switch)", () => {
    const merge = new LegacyMerge();
    merge.apply([{ op: "remove", atom: atom("never seen here") }]);
    merge.apply([{ op: "put", atom: atom("never seen here") }]);
    expect(merge.snapshot().atoms).toHaveLength(0);
  });

  it("is idempotent: replaying the same ops changes nothing", () => {
    const merge = new LegacyMerge();
    const ops: Op[] = [
      { op: "put", atom: atom("a", "n1") },
      { op: "put", atom: atom("b") },
      { op: "remove", atom: atom("a") },
    ];
    merge.apply(ops);
    const once = merge.snapshot();
    merge.apply(ops);
    expect(merge.snapshot()).toEqual(once);
  });

  it("latest put wins for an existing text", () => {
    const merge = new LegacyMerge();
    merge.apply([{ op: "put", atom: atom("x", "old", []) }]);
    merge.apply([{ op: "put", atom: atom("x", "new", ["rust"]) }]);
    const [only] = merge.snapshot().atoms;
    expect(only.node).toBe("new");
    expect(only.tags).toEqual(["rust"]);
  });

  it("absorbs a client snapshot: atoms and tombstones", () => {
    const merge = new LegacyMerge();
    const clientSnap: Snapshot = {
      version: 1,
      atoms: [atom("from client")],
      tombstones: [atom("dead thing")],
    };
    merge.absorb(clientSnap);
    merge.absorb(clientSnap); // idempotent
    const snap = merge.snapshot();
    expect(snap.atoms.map((a) => a.text)).toEqual(["from client"]);
    expect(snap.tombstones.map((a) => a.text)).toEqual(["dead thing"]);
    // tombstone from client dominates the hub's own atoms
    merge.apply([{ op: "put", atom: atom("dead thing") }]);
    expect(merge.snapshot().atoms.map((a) => a.text)).toEqual(["from client"]);
  });

  it("empty text and malformed ops are rejected", () => {
    expect(validOps([{ op: "put", atom: { text: "", scope: "s", node: "n", tags: [] } }])).toBe(false);
    expect(validOps([{ op: "delete", atom: atom("x") }])).toBe(false);
    expect(validOps([{ op: "put", atom: { text: "ok", scope: "s", node: "n", tags: [] } }])).toBe(true);
  });

  it("snapshot is deterministic and sorted", () => {
    const merge = new LegacyMerge();
    merge.apply([
      { op: "put", atom: atom("zeta") },
      { op: "put", atom: atom("alpha") },
    ]);
    expect(merge.snapshot().atoms.map((a) => a.text)).toEqual(["alpha", "zeta"]);
    expect(JSON.parse(JSON.stringify(merge.snapshot()))).toEqual(merge.snapshot());
  });
});
