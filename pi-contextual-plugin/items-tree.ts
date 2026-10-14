// items-tree.ts — pure logic behind the Ctrl+W work items viewer:
// parent/child tree construction, flattening, and row padding.
//
// Kept free of TUI/session concerns so node:test can drive it directly.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface RawItem {
  id: string;
  title: string;
  priority: number;
  status: string;
  assignee: string;
  labels: string[];
  blocked_by: string[];
  blocks: string[];
  child_of: string[];
  notes: Record<string, { text: string }>;
  created: number;
  /** Position in the scope's display queue (Storage-owned); falls back to created. */
  order?: number;
  /** When the item closed (millis), set by Storage on close; null for legacy. */
  closed_at?: number | null;
}

export interface ItemNode {
  item: RawItem;
  children: ItemNode[];
}

export interface FlatRow {
  item: RawItem;
  depth: number;
}

/** Queue position: explicit `order` from Storage, falling back to created. */
export function queueOrder(item: RawItem): number {
  return typeof item.order === "number" && item.order > 0 ? item.order : item.created;
}

export function padToVisible(styled: string, width: number): string {
  const fitted = truncateToWidth(styled, width);
  const vw = visibleWidth(fitted);
  if (vw >= width) return fitted;
  return fitted + " ".repeat(width - vw);
}

/**
 * Shared comparator: queue order, then id. Status and priority are
 * deliberately NOT sort keys — position is explicit data owned by
 * Storage (see distributed-architecture-debt, DEBT-001).
 */
function compareNodes(a: ItemNode, b: ItemNode): number {
  return (
    queueOrder(a.item) - queueOrder(b.item) ||
    a.item.id.localeCompare(b.item.id)
  );
}

/**
 * Build the parent/child forest. `child_of` edges are CRDT OR-sets merged
 * across replicas, so the backend cannot guarantee acyclicity (two replicas
 * can concurrently claim each other's children). Two hazards this guards
 * against, both of which could previously lose or explode the display:
 *
 * - cycles: an item that is (transitively) its own ancestor never qualifies
 *   as a root, so the old roots-filter dropped the entire cycle — and any
 *   items hanging off it — from the view;
 * - duplication/re-expansion: an item reachable via two parents (a diamond,
 *   or a cycle entered twice) was copied into both subtrees, compounding
 *   exponentially down the tree.
 *
 * Every item is therefore placed exactly once: under its first in-list
 * parent encountered in a single traversal, and leftover cycle members are
 * recovered as roots so no data silently disappears.
 */
export function buildItemTree(items: RawItem[]): ItemNode[] {
  const byId = new Map<string, RawItem>();
  for (const it of items) byId.set(it.id, it);

  const childrenOf = new Map<string, RawItem[]>();
  for (const it of items) {
    for (const parent of it.child_of) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(it);
    }
  }

  const roots = items.filter(
    (it) => it.child_of.length === 0 || it.child_of.every((p) => !byId.has(p)),
  );

  const placed = new Set<string>();
  function addChildren(node: ItemNode): void {
    const kids = childrenOf.get(node.item.id) ?? [];
    for (const kid of kids) {
      // Already placed under another parent (or mid-cycle): skip. This is
      // what breaks cycles and diamonds — each item renders exactly once.
      if (placed.has(kid.id)) continue;
      placed.add(kid.id);
      const childNode: ItemNode = { item: kid, children: [] };
      addChildren(childNode);
      node.children.push(childNode);
    }
  }

  function placeRoot(root: RawItem): void {
    if (placed.has(root.id)) return;
    placed.add(root.id);
    const node: ItemNode = { item: root, children: [] };
    addChildren(node);
    rootNodes.push(node);
  }

  const rootNodes: ItemNode[] = [];
  for (const root of roots) placeRoot(root);
  // Cycle members have an in-list parent, so the roots-filter skipped them
  // and they were never placed. Recover them as roots — visible beats lost.
  for (const it of items) placeRoot(it);

  const sortLevel = (nodes: ItemNode[]): void => {
    nodes.sort(compareNodes);
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(rootNodes);
  return rootNodes;
}

export function flattenTree(nodes: ItemNode[]): FlatRow[] {
  const rows: FlatRow[] = [];
  function walk(n: ItemNode, depth: number): void {
    rows.push({ item: n.item, depth });
    for (const c of n.children) walk(c, depth + 1);
  }
  for (const n of nodes) walk(n, 0);
  return rows;
}
