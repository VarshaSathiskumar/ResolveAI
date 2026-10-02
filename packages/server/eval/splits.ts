import type { EvalQuery } from './metrics.js';

/** Every fourth main query is held out: changes are tuned on dev, then checked on held out. */
export const isHeldOut = (index: number) => index % 4 === 3;

export function splitMain(main: EvalQuery[]): { dev: EvalQuery[]; heldout: EvalQuery[] } {
  return {
    dev: main.filter((_, index) => !isHeldOut(index)),
    heldout: main.filter((_, index) => isHeldOut(index)),
  };
}

export interface SplitIds {
  dev: string[];
  heldout: string[];
  fresh: string[];
}

/**
 * Fitting may only see dev queries. This stops a fresh (frozen) or held-out query from leaking into a fit,
 * whether by a mistake in a script or by a convenient edit later.
 */
export function assertTrainingSet(trainIds: string[], splits: SplitIds): void {
  const dev = new Set(splits.dev);
  const outside = trainIds.filter((id) => !dev.has(id));
  if (outside.length > 0) {
    const heldout = new Set(splits.heldout);
    const fresh = new Set(splits.fresh);
    const kind = (id: string) => (fresh.has(id) ? 'fresh (frozen)' : heldout.has(id) ? 'held-out' : 'unknown');
    throw new Error(
      `Training set must be dev queries only, but contains: ${outside.map((id) => `${id} (${kind(id)})`).join(', ')}`,
    );
  }
  if (new Set(trainIds).size !== trainIds.length) throw new Error('Training set contains a duplicate query id');
}
