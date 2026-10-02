import { describe, expect, it } from 'vitest';
import { applyRerank, createOverlapReranker } from '../src/retrieval/rerank.js';

describe('applyRerank', () => {
  it('orders the re-scored candidates by score, best first', () => {
    expect(applyRerank([1, 5, 3], 3, { top: 3, weight: 1 }).order).toEqual([1, 2, 0]);
  });

  it('keeps the fused order among equal scores', () => {
    expect(applyRerank([2, 2, 2], 3, { top: 3, weight: 1 }).order).toEqual([0, 1, 2]);
  });

  it('leaves candidates beyond the re-scored top in their original order after it', () => {
    const { order } = applyRerank([0, 9, 4], 6, { top: 3, weight: 1 });
    expect(order).toEqual([1, 2, 0, 3, 4, 5]);
  });

  it('returns the raw score of each re-scored candidate by its input index, and none for the tail', () => {
    const { scores } = applyRerank([0.5, 9, 4], 5, { top: 3, weight: 1 });
    expect([...scores.entries()]).toEqual([[0, 0.5], [1, 9], [2, 4]]);
  });

  it('weight 0 keeps the fused order and weight 1 follows the reranker; in between it blends the two ranks', () => {
    const scores = [1, 2, 3, 4]; // the reranker wants the exact reverse of the fused order
    expect(applyRerank(scores, 4, { top: 4, weight: 0 }).order).toEqual([0, 1, 2, 3]);
    expect(applyRerank(scores, 4, { top: 4, weight: 1 }).order).toEqual([3, 2, 1, 0]);
    const mixed = applyRerank(scores, 4, { top: 4, weight: 0.5 }).order;
    expect(mixed).not.toEqual([0, 1, 2, 3]);
    expect(mixed).not.toEqual([3, 2, 1, 0]);
    expect([...mixed].sort()).toEqual([0, 1, 2, 3]);
  });

  it('never loses or repeats a candidate', () => {
    const { order } = applyRerank([3, 1, 2, 9, 0], 8, { top: 5, weight: 0.7 });
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles fewer candidates than the top size and no candidates', () => {
    expect(applyRerank([1, 2], 2, { top: 10, weight: 1 }).order).toEqual([1, 0]);
    expect(applyRerank([], 0, { top: 10, weight: 1 }).order).toEqual([]);
  });
});

describe('the overlap test reranker', () => {
  it('scores passages by distinct query words they contain', async () => {
    const reranker = createOverlapReranker();
    expect(await reranker.score('red light blinking', ['a red light', 'blinking red light here', 'nothing'])).toEqual([2, 3, 0]);
    expect(await reranker.score('x', [])).toEqual([]);
    expect(reranker.model).toBe('overlap-test');
  });
});
