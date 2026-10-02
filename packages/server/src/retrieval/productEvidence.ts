export interface ScoredCandidate {
  productId: string;
  /** Fused (RRF) score before any reranking. */
  score: number;
}

export interface ProductEvidence {
  productId: string;
  /** Sum of the product's two best candidate scores: a product with two supporting chunks beats one lucky chunk. */
  evidence: number;
  best: number;
  chunks: number;
}

/**
 * Evidence for each product among the top `k` candidates, strongest first. Built from the pre-rerank fused scores,
 * so it measures what the candidate generators found, not what a later stage preferred.
 */
export function productEvidence(candidates: ScoredCandidate[], k = 10): ProductEvidence[] {
  const byProduct = new Map<string, number[]>();
  for (const candidate of candidates.slice(0, k)) {
    byProduct.set(candidate.productId, [...(byProduct.get(candidate.productId) ?? []), candidate.score]);
  }
  return [...byProduct.entries()]
    .map(([productId, scores]) => {
      const sorted = [...scores].sort((a, b) => b - a);
      return { productId, evidence: (sorted[0] ?? 0) + (sorted[1] ?? 0), best: sorted[0] ?? 0, chunks: sorted.length };
    })
    .sort((a, b) => b.evidence - a.evidence || a.productId.localeCompare(b.productId));
}

/**
 * The products whose evidence is within `fraction` of the leader's, when there are at least two of them: the
 * user has not said which product they mean and the documentation cannot tell them apart. Empty otherwise.
 */
export function competingProducts(evidence: ProductEvidence[], fraction: number): ProductEvidence[] {
  const leader = evidence[0];
  if (!leader || leader.evidence <= 0) return [];
  const close = evidence.filter((entry) => entry.evidence >= fraction * leader.evidence);
  return close.length >= 2 ? close : [];
}
