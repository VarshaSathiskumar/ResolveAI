import type { Reranker } from '../src/retrieval/rerank.js';
import type { RetrieverOptions } from '../src/retrieval/retriever.js';

/**
 * Variants are '+' separated change names, so each change can be benchmarked alone and in combination.
 * `baseline` is the current behaviour. The calibration script uses the same strings, so a model is always fitted
 * under exactly the settings it will run with.
 *
 *   filler                 drop generic filler words from query terms
 *   calibration[:noguard]  confidence from the model fitted on dev (its filler setting follows how it was fitted);
 *                          the unknown-word guard from v1 is on unless :noguard
 *   ambiguity[:fraction]   product-level evidence for "which product?" (default fraction 0.75)
 *   rerank[:k=v,...]       cross-encoder reranking; settings w (blend weight), top, keep (recall floor), ctx (title context)
 */
export function variantOptions(variant: string, crossEncoder: Reranker): Partial<RetrieverOptions> {
  const options: Partial<RetrieverOptions> = {};
  for (const part of variant.split('+')) {
    if (part === 'baseline') continue;
    else if (part === 'filler') options.fillerStopwords = true;
    else if (part === 'calibration' || part === 'calibration:noguard') {
      options.sufficiency = 'v2';
      if (part === 'calibration:noguard') options.unknownGuard = false;
    }
    else if (part === 'ambiguity' || part.startsWith('ambiguity:')) {
      options.productAmbiguity = 'v2';
      if (part.includes(':')) options.ambiguityFraction = Number(part.split(':')[1]);
    } else if (part === 'rerank' || part.startsWith('rerank:')) {
      options.reranker = crossEncoder;
      for (const pair of (part.split(':')[1] ?? '').split(',').filter(Boolean)) {
        const [key, value] = pair.split('=');
        if (key === 'w') options.rerankWeight = Number(value);
        else if (key === 'top') options.rerankTop = Number(value);
        else if (key === 'keep') options.rerankKeep = Number(value);
        else if (key === 'ctx') options.rerankContext = value === '1';
        else throw new Error(`Unknown rerank setting "${pair}"`);
      }
    } else throw new Error(`Unknown variant part "${part}" in "${variant}"`);
  }
  return options;
}
