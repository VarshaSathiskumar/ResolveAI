import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/schema.js';
import { validateSynonyms } from '../src/ingest/corpus.js';
import { createSynonymLookup } from '../src/retrieval/synonyms.js';
import { stem } from '../src/retrieval/text.js';
import { makeDeps, type TestDeps } from './helpers.js';

describe('stem', () => {
  it('puts inflections of one word on the same stem', () => {
    expect(stem('jammed')).toBe(stem('jamming'));
    expect(stem('jammed')).toBe(stem('jam'));
  });
});

describe('createSynonymLookup', () => {
  let deps: TestDeps;

  beforeAll(async () => {
    deps = await makeDeps();
  });

  afterAll(() => deps.db.close());

  it('expands a word to its group, keeping the word first', () => {
    const lookup = createSynonymLookup(deps.db);
    const expanded = lookup.expand('jammed');
    expect(expanded[0]).toBe('jammed');
    expect(expanded).toEqual(expect.arrayContaining(['clogged', 'blocked']));
  });

  it('finds the group from any inflection', () => {
    const lookup = createSynonymLookup(deps.db);
    expect(lookup.expand('jamming')).toContain('clogged');
    expect(lookup.expand('leaks')).toContain('dripping');
  });

  it('leaves a word with no group alone', () => {
    expect(createSynonymLookup(deps.db).expand('wifi')).toEqual(['wifi']);
  });

  it('works on an index that has no synonyms table', () => {
    expect(createSynonymLookup(openDb(':memory:')).expand('jammed')).toEqual(['jammed']);
  });
});

describe('validateSynonyms', () => {
  const corpus = new Set(['clog', 'block', 'weak', 'leak'].map(stem));

  it('accepts a group and lower-cases it', () => {
    expect(validateSynonyms([['Clogged', 'JAMMED']], corpus)).toEqual([['clogged', 'jammed']]);
  });

  it('keeps one form per stem within a group', () => {
    expect(validateSynonyms([['leak', 'leaking', 'dripping']], corpus)).toEqual([['leak', 'dripping']]);
  });

  it('rejects a group with fewer than two words', () => {
    expect(() => validateSynonyms([['clogged']], corpus)).toThrow(/at least two words/);
    expect(() => validateSynonyms([['leak', 'leaking']], corpus)).toThrow(/at least two words/);
  });

  it('rejects a word that is in two groups', () => {
    expect(() => validateSynonyms([['clogged', 'jammed'], ['jamming', 'weak']], corpus)).toThrow(/jamming.*both/);
  });

  it('rejects a group none of whose words appear in the corpus', () => {
    expect(() => validateSynonyms([['wifi', 'wireless']], corpus)).toThrow(/never match|can never/);
  });
});
