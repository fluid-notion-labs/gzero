// state.ts — module-level router state, shared between the routing
// extension (index.ts) and the gzero panel's router section. The
// router runs in this same extension process, so the panel reads
// live values when it opens.

import type { WorkClassification } from "./classifier.ts";
import { DELEGATED_TYPES, WORK_TYPES, type RouterConfig, type WorkType } from "./config.ts";
import { DEFAULT_LEDGER_PATH, Ledger } from "./ledger.ts";

/** The usage ledger (path overridable via PI_ROUTER_LEDGER). */
export const ledger = new Ledger(process.env.PI_ROUTER_LEDGER || DEFAULT_LEDGER_PATH);

export interface RouterSnapshot {
  pinned: WorkType | null;
  classifier: string;
  threshold: number;
  default: string;
  last: { workType: WorkType | null; confidence: number } | null;
  blessed: { workType: WorkType; model: string; delegated: boolean }[];
}

/** Live router state; index.ts mutates, the panel reads. */
export const routerState: {
  config: RouterConfig;
  pinned: WorkType | null;
  lastClassification: (WorkClassification & { workType: WorkType | null }) | null;
} = {
  config: {} as RouterConfig, // replaced by index.ts at setup
  pinned: null,
  lastClassification: null,
};

/** Read-only view for the gzero panel's router section. */
export function routerSnapshot(): RouterSnapshot {
  const c = routerState.config;
  const last = routerState.lastClassification;
  return {
    pinned: routerState.pinned,
    classifier: `${c.classifier.provider}/${c.classifier.id}`,
    threshold: c.classifier.threshold,
    default: `${c.default.provider}/${c.default.id}`,
    last: last ? { workType: last.workType, confidence: last.confidence } : null,
    blessed: WORK_TYPES.map((workType) => ({
      workType,
      model: c.blessed[workType].id,
      delegated: (DELEGATED_TYPES as readonly WorkType[]).includes(workType),
    })),
  };
}
