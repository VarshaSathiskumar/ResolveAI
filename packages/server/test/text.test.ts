import { describe, expect, it } from 'vitest';
import { codeTerms, ftsAnyOf, queryTerms, words } from '../src/retrieval/text.js';

describe('query text helpers', () => {
  it('drops stopwords and generic words but keeps the symptom', () => {
    expect(queryTerms("my coffee machine isn't brewing, only a few drops")).toEqual(['brewing', 'only', 'few', 'drops']);
  });

  it('removes duplicate terms', () => {
    expect(queryTerms('leak leak leak')).toEqual(['leak']);
  });

  it('finds error codes and model numbers, with or without a hyphen', () => {
    expect(codeTerms('it says E04 and E-05 on my BP-200 or ES1')).toEqual(['e04', 'e05', 'bp200', 'es1']);
    expect(codeTerms('the 2 cup setting')).toEqual([]);
  });

  it('keeps codes as terms', () => {
    expect(queryTerms('error E-04')).toEqual(['error', 'e04']);
  });

  it('normalises apostrophes', () => {
    expect(words("won't brew")).toEqual(['wont', 'brew']);
  });

  it('quotes every term so FTS syntax in user text is harmless', () => {
    expect(ftsAnyOf(['brew', 'a"b', 'NOT'])).toBe('"brew" OR "ab" OR "NOT"');
  });
});
