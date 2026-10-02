import { describe, expect, it } from 'vitest';
import calibrationFile from '../src/retrieval/calibration.json' with { type: 'json' };
import { productionRetrieval } from '../src/retrieval/presets.js';
import {
  assessSufficiencyV2,
  calibratedScore,
  featureVector,
  type CalibrationFile,
  type CalibrationModel,
  type Signals,
} from '../src/retrieval/sufficiency.js';
import { variantOptions } from '../eval/variants.js';
import { createOverlapReranker } from '../src/retrieval/rerank.js';
import { FEATURES, RERANK_FEATURES, RERANK_SETTINGS, RERANK_VARIANT } from '../../../config.js';

/** A hand-made model: confidence rises with coverage and the cross-encoder score, falls with unknown words. */
const model: CalibrationModel = {
  features: [...RERANK_FEATURES],
  mean: RERANK_FEATURES.map(() => 0),
  sd: RERANK_FEATURES.map(() => 1),
  //          cov  cov1 unk  cos  prom agr  mar  code rrfTop rMar rTop
  weights: [2.0, 0.5, -1.0, 0.5, 0.2, 0.1, 0.0, 0.5, 0.0, 0.0, 0.6],
  bias: -3,
  cutoffs: { high: 0.8, medium: 0.5 },
};

const strong: Signals = {
  hitCount: 4,
  coverage: 1,
  coverageTop1: 1,
  unknownShare: 0,
  topCosine: 0.3,
  cosineProminence: 2,
  agreement: true,
  margin: 0.1,
  codeRequested: false,
  codeMatched: false,
  ambiguousProduct: false,
  rerankTopMatchesRrfTop: true,
  rerankMargin: 5,
  rerankTopScore: 6,
};
const assess = (overrides: Partial<Signals>, options?: { unknownGuard?: boolean }) =>
  assessSufficiencyV2({ ...strong, ...overrides }, model, options);

describe('calibrated confidence (v2)', () => {
  it('is high when everything agrees', () => {
    expect(assess({})).toBe('high');
  });

  it('is low with no results and when a requested code is nowhere in the results, whatever the score', () => {
    expect(assess({ hitCount: 0 })).toBe('low');
    expect(assess({ codeRequested: true, codeMatched: false })).toBe('low');
  });

  it('turns a short query with full word coverage but a weak raw cosine into an answer, not an abstention', () => {
    // The false abstain the hand-set cosine floor produced: perfect coverage, cosine 0.2.
    expect(assess({ topCosine: 0.2, cosineProminence: 2.1, margin: 0.21 })).not.toBe('low');
  });

  it('is lower when the cross-encoder is unsure, and monotonic in its score', () => {
    const scores = [-10, -5, 0, 3, 6, 9].map((rerankTopScore) => calibratedScore({ ...strong, rerankTopScore }, model));
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(assess({ rerankTopScore: -10, rerankMargin: 0 })).toBe('low');
  });

  it('is monotonic in coverage and falls as unknown words rise', () => {
    const byCoverage = [0, 0.25, 0.5, 0.75, 1].map((coverage) => calibratedScore({ ...strong, coverage }, model));
    expect(byCoverage).toEqual([...byCoverage].sort((a, b) => a - b));
    const byUnknown = [0, 0.25, 0.5, 1].map((unknownShare) => calibratedScore({ ...strong, unknownShare }, model));
    expect(byUnknown).toEqual([...byUnknown].sort((a, b) => b - a));
  });

  it('is never high when several products match equally', () => {
    expect(assess({ ambiguousProduct: true })).toBe('medium');
  });

  it('never trusts a query that mentions a word the documentation does not use as high', () => {
    expect(assess({ unknownShare: 0.2 })).toBe('medium');
  });

  it('rates a mostly-unknown query low unless an exact code was found, even when the cross-encoder likes a result', () => {
    // "the grinder is jamming" on a machine with no grinder: a relevant-looking passage, but half the query is unknown.
    expect(assess({ unknownShare: 0.5, coverage: 0.5 })).toBe('low');
    expect(assess({ unknownShare: 0.5, codeRequested: true, codeMatched: true })).not.toBe('low');
  });

  it('can switch the unknown-word guard off, which is what was measured to cost abstain recall', () => {
    expect(assess({ unknownShare: 0.5 }, { unknownGuard: false })).not.toBe('low');
  });
});

describe('features', () => {
  it('computes the base features in the stored order', () => {
    expect(featureVector(strong, FEATURES)).toEqual([1, 1, 0, 0.3, 2, 1, 0.1, 0]);
  });

  it('adds the three reranker features only for the rerank feature set', () => {
    expect(featureVector(strong, RERANK_FEATURES)).toHaveLength(RERANK_FEATURES.length);
    expect(featureVector(strong, RERANK_FEATURES).slice(-3)).toEqual([1, 5, 6]);
  });

  it('refuses to score with reranker features when no reranker ran', () => {
    const { rerankTopMatchesRrfTop, rerankMargin, rerankTopScore, ...noReranker } = strong;
    void rerankTopMatchesRrfTop; void rerankMargin; void rerankTopScore;
    expect(() => assessSufficiencyV2(noReranker as Signals, model)).toThrow(/needs a reranker/);
  });

  it('refuses a feature name it does not know', () => {
    expect(() => featureVector(strong, ['nonsense'])).toThrow(/Unknown calibration feature/);
  });
});

describe('the shipped calibration', () => {
  const shipped = calibrationFile as CalibrationFile;

  it('ships only the reranker model: the one fitted without a reranker failed its keep rule', () => {
    expect(shipped.rrf).toBeNull();
    expect(shipped.rerank).not.toBeNull();
  });

  it('is well formed: known features, matching widths, ordered cutoffs', () => {
    const fitted = shipped.rerank!;
    expect(fitted.features).toEqual([...RERANK_FEATURES]);
    for (const list of [fitted.mean, fitted.sd, fitted.weights]) expect(list).toHaveLength(RERANK_FEATURES.length);
    expect(fitted.sd.every((value) => value > 0)).toBe(true);
    expect(fitted.cutoffs.medium).toBeGreaterThan(0);
    expect(fitted.cutoffs.medium).toBeLessThanOrEqual(fitted.cutoffs.high);
    expect(fitted.cutoffs.high).toBeLessThan(1);
  });

  it('was fitted on dev under the same reranker settings the server uses', () => {
    const fit = shipped.rerank!.fit as { split: string; variant: string };
    expect(fit.split).toBe('dev');
    expect(fit.variant).toBe(RERANK_VARIANT);
    const parsed = variantOptions(RERANK_VARIANT, createOverlapReranker());
    expect({ rerankTop: 10, ...parsed, reranker: undefined }).toMatchObject({
      rerankTop: RERANK_SETTINGS.rerankTop,
      rerankKeep: RERANK_SETTINGS.rerankKeep,
      rerankContext: RERANK_SETTINGS.rerankContext,
    });
    expect(parsed.rerankWeight ?? RERANK_SETTINGS.rerankWeight).toBe(RERANK_SETTINGS.rerankWeight);
  });

  it('scores a clearly good result higher than a clearly poor one, and a short full-coverage query as an answer', () => {
    const fitted = shipped.rerank!;
    const good = calibratedScore({ ...strong, rerankTopScore: 7, rerankMargin: 8 }, fitted);
    const poor = calibratedScore({ ...strong, coverage: 0.2, coverageTop1: 0, rerankTopScore: -9, rerankMargin: 0.5, rerankTopMatchesRrfTop: false }, fitted);
    expect(good).toBeGreaterThan(0.8);
    expect(poor).toBeLessThan(good);
    expect(assessSufficiencyV2({ ...strong, coverage: 0.2, coverageTop1: 0, rerankTopScore: -9, rerankMargin: 0.5 }, fitted)).toBe('low');
    expect(assessSufficiencyV2({ ...strong, topCosine: 0.2, margin: 0.21 }, fitted)).not.toBe('low');
  });

  it('documents a known limit instead of hiding it: a vocabulary mismatch ("warranty length") is still rated low by the guard', () => {
    const lengthQuery: Signals = { ...strong, coverage: 0.5, coverageTop1: 0.5, unknownShare: 0.5 };
    expect(assessSufficiencyV2(lengthQuery, shipped.rerank!)).toBe('low');
  });
});

describe('production retrieval preset', () => {
  it('uses the calibrated confidence only together with the reranker it was fitted for', () => {
    expect(productionRetrieval(true)).toMatchObject({ sufficiency: 'v2', productAmbiguity: 'v2', ...RERANK_SETTINGS });
    expect(productionRetrieval(false)).toMatchObject({ sufficiency: 'v1', productAmbiguity: 'v2' });
    expect(productionRetrieval(false)).not.toHaveProperty('rerankKeep');
  });
});
