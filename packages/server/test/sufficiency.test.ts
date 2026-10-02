import { describe, expect, it } from 'vitest';
import { assessSufficiency, type Signals } from '../src/retrieval/sufficiency.js';

const strong: Signals = {
  hitCount: 4,
  coverage: 1,
  codeRequested: false,
  codeMatched: false,
  topCosine: 0.5,
  ambiguousProduct: false,
  unknownShare: 0,
  agreement: true,
  margin: 0.2,
  cosineProminence: 3,
  coverageTop1: 1,
};

const assess = (overrides: Partial<Signals>) => assessSufficiency({ ...strong, ...overrides });

describe('assessSufficiency', () => {
  it('is high when terms are covered and the top result is close', () => {
    expect(assess({})).toBe('high');
  });

  it('is low with no results', () => {
    expect(assess({ hitCount: 0 })).toBe('low');
  });

  it('is low when most of the query is unmatched', () => {
    expect(assess({ coverage: 0.25 })).toBe('low');
  });

  it('is medium on partial coverage', () => {
    expect(assess({ coverage: 0.6 })).toBe('medium');
  });

  it('is medium when coverage is full but the semantic match is weak', () => {
    expect(assess({ topCosine: 0.25 })).toBe('medium');
  });

  it('is low when both signals are weak', () => {
    expect(assess({ coverage: 1, topCosine: 0.1 })).toBe('low');
  });

  it('is low when an error code the user gave appears nowhere in the results', () => {
    expect(assess({ codeRequested: true, codeMatched: false })).toBe('low');
  });

  it('trusts an exact code match even when the semantic match is weak', () => {
    expect(assess({ codeRequested: true, codeMatched: true, topCosine: 0.2, coverage: 1 })).toBe('high');
    expect(assess({ codeRequested: true, codeMatched: true, topCosine: 0.05, coverage: 0.2 })).toBe('medium');
  });

  it('is never high when a query word is unknown to the documentation', () => {
    expect(assess({ unknownShare: 0.2 })).toBe('medium');
  });

  it('drops a level when a third or more of the query is unknown', () => {
    expect(assess({ unknownShare: 0.5, coverage: 0.6 })).toBe('low');
  });

  it('is never high when several products match equally well', () => {
    expect(assess({ ambiguousProduct: true })).toBe('medium');
  });
});
