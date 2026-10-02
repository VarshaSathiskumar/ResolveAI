import { DEFAULT_THRESHOLDS, FEATURES, RERANK_FEATURES, UNKNOWN_DEMOTES_AT } from '../../../../config.js';
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
  /**
   * Candidate-generation signal, fixed before any reranking: the top fused (RRF) candidate is within the top 2 of
   * both the keyword list and the vector list, so the two independent retrievers agree on it.
   */
  agreement: boolean;
  /** Candidate-generation signal, fixed before any reranking: how far the top fused score is ahead of the second, 0 to 1. */
  margin: number;
  /** Reranker only: the cross-encoder's first choice is within the top 2 of the fused order. Never replaces `agreement`. */
  rerankTopMatchesRrfTop?: boolean;
  /** Reranker only: raw score gap between the cross-encoder's first and second choice. */
  rerankMargin?: number;
  /** Reranker only: raw cross-encoder score of the returned top hit. */
  rerankTopScore?: number;
  /**
   * How far the best returned hit's cosine stands above the cosines of everything the vector search ranked, in
   * standard deviations. Unlike the raw cosine it does not penalise short queries (which are far from every chunk) and
   * it is flat for a query the corpus cannot answer, because nothing stands out.
   */
  cosineProminence: number;
  /** Share of query terms found in the single best returned hit, 0 to 1 (coverage above is over the top three). */
  coverageTop1: number;
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

/**
 * Named features a calibration model can use. The model stores the names it was fitted with, so a model can never be
 * applied with different features than it was trained on.
 */
const FEATURE_FUNCTIONS: Record<string, (signals: Signals) => number | undefined> = {
  coverage: (s) => s.coverage,
  coverageTop1: (s) => s.coverageTop1,
  unknownShare: (s) => s.unknownShare,
  topCosine: (s) => s.topCosine,
  cosineProminence: (s) => s.cosineProminence,
  agreement: (s) => (s.agreement ? 1 : 0),
  margin: (s) => s.margin,
  exactCode: (s) => (s.codeRequested && s.codeMatched ? 1 : 0),
  // Only present when a reranker ran. They describe the cross-encoder, never the candidate generators.
  rerankTopMatchesRrfTop: (s) => (s.rerankTopMatchesRrfTop === undefined ? undefined : s.rerankTopMatchesRrfTop ? 1 : 0),
  rerankMargin: (s) => s.rerankMargin,
  rerankTopScore: (s) => s.rerankTopScore,
};

export function featureVector(signals: Signals, names: readonly string[] = FEATURES): number[] {
  return names.map((name) => {
    const compute = FEATURE_FUNCTIONS[name];
    if (!compute) throw new Error(`Unknown calibration feature "${name}"`);
    const value = compute(signals);
    if (value === undefined) throw new Error(`Feature "${name}" needs a reranker, but this search did not use one`);
    return value;
  });
}

/**
 * A logistic model fitted offline (eval/calibrate.ts) on the labelled eval set. `weights` apply to features
 * standardised with `mean` and `sd`. The score estimates the chance that the returned results contain the section
 * that answers the query; `cutoffs` turn it into medium and high.
 */
export interface CalibrationModel {
  features: string[];
  mean: number[];
  sd: number[];
  weights: number[];
  bias: number;
  cutoffs: { high: number; medium: number };
  /** How and on what it was fitted, for the record. Not used when scoring. */
  fit?: Record<string, unknown>;
}

export interface CalibrationFile {
  /** For retrieval without a reranker. */
  rrf: CalibrationModel | null;
  /** For retrieval with a reranker: a different feature set, so a different model. */
  rerank: CalibrationModel | null;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

export function calibratedScore(signals: Signals, model: CalibrationModel): number {
  const features = featureVector(signals, model.features);
  const z = features.reduce((sum, value, index) => sum + (model.weights[index]! * (value - model.mean[index]!)) / (model.sd[index]! || 1), model.bias);
  return sigmoid(z);
}

/**
 * Sufficiency from a calibrated score instead of hand-set cosine floors. The rules that must never be probabilistic
 * stay explicit: no results is low, a requested code that appears nowhere in the results is low, and several
 * equally good products can never be high.
 */
export function assessSufficiencyV2(signals: Signals, model: CalibrationModel, options: { unknownGuard?: boolean } = {}): Confidence {
  const { unknownGuard = true } = options;
  if (signals.hitCount === 0) return 'low';
  if (signals.codeRequested && !signals.codeMatched) return 'low';

  const score = calibratedScore(signals, model);
  let confidence: Confidence = score >= model.cutoffs.high ? 'high' : score >= model.cutoffs.medium ? 'medium' : 'low';

  if (unknownGuard) {
    // The conservative rule v1 always had, carried over because a fitted model only learns caution from the negative
    // examples it was given (the labelled set has few). A word the documentation never uses is never fully confident,
    // and a query that is mostly such words drops a level, unless an exact code was found.
    const exact = signals.codeRequested && signals.codeMatched;
    if (signals.unknownShare > 0 && confidence === 'high') confidence = 'medium';
    if (signals.unknownShare >= UNKNOWN_DEMOTES_AT && !exact && confidence === 'medium') confidence = 'low';
  }
  if (signals.ambiguousProduct && confidence === 'high') confidence = 'medium';
  return confidence;
}
