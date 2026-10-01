export type Confidence = 'high' | 'medium' | 'low';

/** Evidence gathered by the retriever for one query. */
export interface Signals {
  hitCount: number;
  /** Share of query terms found in the top results, 0 to 1. */
  coverage: number;
  /** The query named an error code or model number. */
  codeRequested: boolean;
  /** Every requested code appears in the top results. */
  codeMatched: boolean;
  /** Cosine similarity between the query and the best of the top results. */
  topCosine: number;
  /** The search was not scoped to a product and other products score about as well. */
  ambiguousProduct: boolean;
  /** Share of query terms that appear nowhere in the corpus, 0 to 1. The user is describing something the docs never mention. */
  unknownShare: number;
}

export interface Thresholds {
  /** Minimum term coverage and cosine for high confidence. */
  highCoverage: number;
  highCosine: number;
  /** Minimum term coverage and cosine for medium confidence. */
  mediumCoverage: number;
  mediumCosine: number;
}

/**
 * Cosine thresholds are tuned for all-MiniLM-L6-v2 against the synthetic corpus.
 * Re-tune them (see test/retrieval.eval.test.ts) when the embedding model changes.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  highCoverage: 0.75,
  highCosine: 0.3,
  mediumCoverage: 0.5,
  mediumCosine: 0.2,
};

/** Unknown terms at or above this share of the query lower the confidence by one level. */
const UNKNOWN_DEMOTES_AT = 1 / 3;

/**
 * Deterministic sufficiency check: is what was retrieved enough to answer from?
 * An exact code the user gave that appears nowhere in the results is always low,
 * because the results are then about something else.
 */
export function assessSufficiency(signals: Signals, thresholds: Thresholds = DEFAULT_THRESHOLDS): Confidence {
  if (signals.hitCount === 0) return 'low';
  if (signals.codeRequested && !signals.codeMatched) return 'low';

  const exact = signals.codeRequested && signals.codeMatched;
  let confidence: Confidence = 'low';
  if (exact || (signals.coverage >= thresholds.mediumCoverage && signals.topCosine >= thresholds.mediumCosine)) {
    confidence = 'medium';
  }
  if (
    (exact && signals.coverage >= thresholds.mediumCoverage) ||
    (signals.coverage >= thresholds.highCoverage && signals.topCosine >= thresholds.highCosine)
  ) {
    confidence = 'high';
  }

  // Words the documentation never uses: never fully confident, and mostly-unknown queries drop a level.
  if (signals.unknownShare > 0 && confidence === 'high') confidence = 'medium';
  if (signals.unknownShare >= UNKNOWN_DEMOTES_AT && !exact) confidence = confidence === 'medium' ? 'low' : confidence;

  // Several products match equally well: the evidence may describe the wrong machine.
  if (signals.ambiguousProduct && confidence === 'high') confidence = 'medium';
  return confidence;
}
