/**
 * Contexture state semantics — the server-side merge, mirroring `contextual`:
 *
 * - identity of an atom is its text
 * - `remove` tombstones by text and records the full atom (exact identity
 *   travels in snapshots so remote replicas can match their add)
 * - a `put` of a tombstoned text stays hidden (OR-set: remove wins)
 * - put of a live text: latest put wins (scope/node/tags replaced)
 * - all operations are idempotent, order-free
 */

export interface Atom {
  text: string;
  scope: string;
  node: string;
  tags: string[];
}

export interface Op {
  op: "put" | "remove";
  atom: Atom;
}

export interface Snapshot {
  version: 1;
  atoms: Atom[];
  tombstones: Atom[];
}

export function validAtom(a: unknown): a is Atom {
  if (typeof a !== "object" || a === null) return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.text === "string" &&
    x.text.trim().length > 0 &&
    typeof x.scope === "string" &&
    typeof x.node === "string" &&
    Array.isArray(x.tags) &&
    x.tags.every((t) => typeof t === "string")
  );
}

export function validOps(ops: unknown): ops is Op[] {
  if (!Array.isArray(ops)) return false;
  return ops.every((o) => {
    if (typeof o !== "object" || o === null) return false;
    const x = o as Record<string, unknown>;
    return (x.op === "put" || x.op === "remove") && validAtom(x.atom);
  });
}

/**
 * The state state as plain maps; the worker holds this in memory and
 * persists `snapshot()` debounced. Pure functions so tests stay trivial.
 */
export class LegacyMerge {
  readonly atoms: Map<string, Atom> = new Map(); // text -> atom
  readonly tombstones: Map<string, Atom> = new Map(); // text -> atom

  load(snapshot: Snapshot | null | undefined): void {
    if (!snapshot) return;
    for (const a of snapshot.tombstones ?? []) this.tombstones.set(a.text, a);
    for (const a of snapshot.atoms ?? []) {
      if (!this.tombstones.has(a.text)) this.atoms.set(a.text, a);
    }
  }

  apply(ops: Op[]): boolean {
    let changed = false;
    for (const { op, atom } of ops) {
      if (op === "remove") {
        if (!this.tombstones.has(atom.text)) {
          this.tombstones.set(atom.text, atom);
          changed = true;
        }
        if (this.atoms.delete(atom.text)) changed = true;
      } else {
        if (this.tombstones.has(atom.text)) continue; // tombstone wins
        const existing = this.atoms.get(atom.text);
        if (!existing || !sameAtom(existing, atom)) {
          this.atoms.set(atom.text, atom);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Absorb a client's full snapshot (bulk sync / initial pull). */
  absorb(snap: Snapshot): boolean {
    const ops: Op[] = [
      ...snap.tombstones.map((atom): Op => ({ op: "remove", atom })),
      ...snap.atoms.map((atom): Op => ({ op: "put", atom })),
    ];
    return this.apply(ops);
  }

  snapshot(): Snapshot {
    const byText = (a: Atom, b: Atom) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
    return {
      version: 1,
      atoms: [...this.atoms.values()].sort(byText),
      tombstones: [...this.tombstones.values()].sort(byText),
    };
  }
}

function sameAtom(a: Atom, b: Atom): boolean {
  return (
    a.text === b.text &&
    a.scope === b.scope &&
    a.node === b.node &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}
