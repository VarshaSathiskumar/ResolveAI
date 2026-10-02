import type { RetrieverOptions } from './retriever.js';

/**
 * Reranker settings the shipped calibration model was fitted under (eval variant "rerank:keep=2,ctx=1"). The model's
 * signals only mean the same thing under the same settings, so these live in one place and a test ties them to the
 * model's recorded fit.
 */
export const RERANK_SETTINGS = { rerankTop: 10, rerankWeight: 1, rerankKeep: 2, rerankContext: true } as const;
export const RERANK_VARIANT = 'rerank:keep=2,ctx=1';

/**
 * The retrieval configuration the server runs, chosen from the benchmarks in eval/README.md.
 * - Product-level ambiguity is always on.
 * - With a reranker: re-score the top 10, never evict the fused top 2, and rate confidence with the model calibrated
 *   for that configuration. Without one: the original hand-set confidence rules, because the calibration fitted
 *   without a reranker did not hold up on held-out and fresh queries.
 */
export function productionRetrieval(hasReranker: boolean): Partial<RetrieverOptions> {
  return {
    productAmbiguity: 'v2',
    ambiguityFraction: 0.75,
    sufficiency: hasReranker ? 'v2' : 'v1',
    ...(hasReranker ? RERANK_SETTINGS : {}),
  };
}
