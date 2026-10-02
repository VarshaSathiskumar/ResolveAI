import { describe, expect, it } from 'vitest';
import { chooseCutoffs, fitLogistic, leaveOneOut, logLoss, predict, standardize } from '../eval/calibration.js';
import { assertTrainingSet } from '../eval/splits.js';

// One informative feature (x0) and one pure noise feature (x1).
const rows = [
  [0.0, 0.5], [0.1, 0.2], [0.2, 0.9], [0.3, 0.1], [0.4, 0.7], [0.5, 0.3],
  [0.6, 0.8], [0.7, 0.2], [0.8, 0.6], [0.9, 0.4], [1.0, 0.5], [0.15, 0.4], [0.85, 0.6],
];
const labels = rows.map(([x]) => (x! >= 0.5 ? 1 : 0));

describe('logistic fit', () => {
  const { mean, sd } = standardize(rows);
  const z = rows.map((row) => row.map((v, j) => (v - mean[j]!) / sd[j]!));

  it('standardises to zero mean and unit spread, and leaves a constant column alone', () => {
    const s = standardize([[1, 5], [3, 5]]);
    expect(s.mean).toEqual([2, 5]);
    expect(s.sd[0]).toBeCloseTo(1);
    expect(s.sd[1]).toBe(1);
  });

  it('learns that the informative feature matters and the noise feature barely does', () => {
    const fit = fitLogistic(z, labels, 0.3);
    expect(fit.weights[0]).toBeGreaterThan(1);
    expect(Math.abs(fit.weights[1]!)).toBeLessThan(Math.abs(fit.weights[0]!) / 3);
  });

  it('gives higher probability to rows that look positive', () => {
    const fit = fitLogistic(z, labels, 0.3);
    expect(predict([0.9, 0.5], fit, mean, sd)).toBeGreaterThan(0.8);
    expect(predict([0.1, 0.5], fit, mean, sd)).toBeLessThan(0.2);
  });

  it('shrinks the weights as the penalty grows', () => {
    const weak = fitLogistic(z, labels, 0.03).weights[0]!;
    const strong = fitLogistic(z, labels, 10).weights[0]!;
    expect(Math.abs(strong)).toBeLessThan(Math.abs(weak));
  });

  it('stays finite on perfectly separable data thanks to the penalty', () => {
    const fit = fitLogistic(z, labels, 0.1);
    expect(fit.weights.every(Number.isFinite) && Number.isFinite(fit.bias)).toBe(true);
  });

  it('is deterministic', () => {
    expect(fitLogistic(z, labels, 0.3)).toEqual(fitLogistic(z, labels, 0.3));
  });
});

describe('leave-one-out', () => {
  it('predicts each row from a model that never saw it', () => {
    const p = leaveOneOut(rows, labels, 0.3);
    expect(p).toHaveLength(rows.length);
    expect(p.every((value) => value > 0 && value < 1)).toBe(true);
    // Held-out predictions are less sure than a fit evaluated on its own training data.
    const { mean, sd } = standardize(rows);
    const z = rows.map((row) => row.map((v, j) => (v - mean[j]!) / sd[j]!));
    const fit = fitLogistic(z, labels, 0.3);
    const inSample = rows.map((row) => predict(row, fit, mean, sd));
    expect(logLoss(p, labels)).toBeGreaterThan(logLoss(inSample, labels));
  });

  it('still separates the classes out of sample', () => {
    const p = leaveOneOut(rows, labels, 0.3);
    const meanOf = (wanted: number) => {
      const group = p.filter((_, i) => labels[i] === wanted);
      return group.reduce((a, b) => a + b, 0) / group.length;
    };
    expect(meanOf(1)).toBeGreaterThan(meanOf(0) + 0.3);
  });
});

describe('chooseCutoffs', () => {
  const sample = (p: number, positive: boolean, unanswerable = false) => ({ p, positive, unanswerable });

  it('puts high just above the most confident wrong sample', () => {
    const cutoffs = chooseCutoffs([sample(0.9, true), sample(0.8, false), sample(0.6, true), sample(0.3, false, true)], 0);
    expect(cutoffs.high).toBeCloseTo(0.8, 4);
    expect(cutoffs.high).toBeGreaterThan(0.8);
  });

  it('never puts high below 0.5', () => {
    expect(chooseCutoffs([sample(0.9, true), sample(0.1, false, true)], 0).high).toBe(0.5);
  });

  it('puts medium above every unanswerable sample when no misses are allowed', () => {
    const cutoffs = chooseCutoffs([sample(0.95, true), sample(0.4, false, true), sample(0.2, false, true), sample(0.7, true)], 0);
    expect(cutoffs.medium).toBeGreaterThan(0.4);
    expect(cutoffs.medium).toBeLessThanOrEqual(cutoffs.high);
  });

  it('lets exactly the allowed number of unanswerable samples reach medium', () => {
    const unanswerable = [0.7, 0.5, 0.3].map((p) => sample(p, false, true));
    const cutoffs = chooseCutoffs([sample(0.99, true), ...unanswerable], 1);
    const reachMedium = unanswerable.filter((s) => s.p >= cutoffs.medium).length;
    expect(reachMedium).toBe(1);
  });

  it('keeps medium at or below high', () => {
    const cutoffs = chooseCutoffs([sample(0.95, true), sample(0.99, false, true)], 0);
    expect(cutoffs.medium).toBeLessThanOrEqual(cutoffs.high);
  });
});

describe('assertTrainingSet', () => {
  const splits = { dev: ['q001', 'q002'], heldout: ['q003'], fresh: ['f001'] };

  it('accepts dev ids', () => {
    expect(() => assertTrainingSet(['q001', 'q002'], splits)).not.toThrow();
  });

  it('refuses a held-out id and a frozen fresh id, naming them', () => {
    expect(() => assertTrainingSet(['q001', 'q003'], splits)).toThrow(/q003 \(held-out\)/);
    expect(() => assertTrainingSet(['q001', 'f001'], splits)).toThrow(/f001 \(fresh \(frozen\)\)/);
  });

  it('refuses an id it has never heard of and a duplicate', () => {
    expect(() => assertTrainingSet(['zzz'], splits)).toThrow(/unknown/);
    expect(() => assertTrainingSet(['q001', 'q001'], splits)).toThrow(/duplicate/);
  });
});
