import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/schema.js';
import { createHashEmbedder } from '../src/ingest/embed.js';
import { createRetriever } from '../src/retrieval/retriever.js';
import { makeDeps, type TestDeps } from './helpers.js';

const PRO200 = 'brewwell-brew-pro-200';
const PRO300 = 'brewwell-brew-pro-300';
const ES1 = 'brewwell-espresso-studio-es1';

let deps: TestDeps;

beforeAll(async () => {
  deps = await makeDeps();
});

afterAll(() => deps.db.close());

describe('scoping', () => {
  it('only returns chunks from the requested product', async () => {
    const result = await deps.retriever.search({ query: 'no water comes out', productId: PRO300, limit: 8 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.productId === PRO300)).toBe(true);
  });

  it('only returns the requested document types', async () => {
    const result = await deps.retriever.search({ query: 'how long is the warranty', docTypes: ['warranty'], limit: 8 });
    expect(result.hits.every((hit) => hit.docType === 'warranty')).toBe(true);
  });

  it('knows which products exist', () => {
    expect(deps.retriever.productExists(PRO200)).toBe(true);
    expect(deps.retriever.productExists('nope')).toBe(false);
  });
});

describe('ranking', () => {
  it('puts the chunk containing an exact error code first', async () => {
    const result = await deps.retriever.search({ query: 'it says E04', productId: PRO300 });
    expect(result.hits[0]?.text).toMatch(/E04/);
    expect(result.confidence).not.toBe('low');
  });

  it('finds the planted failure path for a symptom in the guide', async () => {
    const result = await deps.retriever.search({ query: 'pump buzzes airlock no water', productId: ES1 });
    expect(result.hits.slice(0, 3).some((hit) => /airlock/i.test(hit.section))).toBe(true);
  });

  it('returns a ready-to-say citation with document and page', async () => {
    const result = await deps.retriever.search({ query: 'needle clogged', productId: PRO200 });
    const hit = result.hits.find((candidate) => /needle/i.test(candidate.section))!;
    expect(hit.citation).toBe('Brewwell Brew Pro 200 Troubleshooting Guide, page 2');
    expect(hit.docType).toBe('troubleshooting');
  });

  it('prefers the warranty document when the question is about the warranty', async () => {
    const result = await deps.retriever.search({ query: 'is a repair covered by the warranty', productId: PRO200 });
    expect(result.hits[0]?.docType).toBe('warranty');
  });

  it('respects the limit', async () => {
    const result = await deps.retriever.search({ query: 'water', limit: 2 });
    expect(result.hits).toHaveLength(2);
  });
});

describe('sufficiency signals', () => {
  it('is low and names the code when the error code is not in the documentation', async () => {
    const result = await deps.retriever.search({ query: 'error E99 on the display', productId: PRO200 });
    expect(result.confidence).toBe('low');
    expect(result.gaps).toContain('e99');
    expect(result.suggestedRefinement).toMatch(/E99/);
  });

  it('is low and lists unknown terms for something the product does not have', async () => {
    const result = await deps.retriever.search({ query: 'wifi will not connect to the phone app', productId: PRO200 });
    expect(result.confidence).toBe('low');
    expect(result.unknownTerms).toEqual(expect.arrayContaining(['wifi']));
    expect(result.suggestedRefinement).toMatch(/never mentions/);
  });

  it('is low when the query has no content words', async () => {
    const result = await deps.retriever.search({ query: 'please help me', productId: PRO200 });
    expect(result.confidence).toBe('low');
  });

  it('asks for the product when the search is unscoped and products match about equally', async () => {
    const result = await deps.retriever.search({ query: 'Brew Pro is not brewing' });
    expect(result.needs).toContain('product_id');
    expect(result.suggestedRefinement).toMatch(/product_id/);
    expect(result.confidence).not.toBe('high');
  });

  it('does not ask for the product once the search is scoped', async () => {
    const result = await deps.retriever.search({ query: 'Brew Pro is not brewing', productId: PRO200 });
    expect(result.needs).toEqual([]);
  });

  it('gives no refinement when confidence is high', async () => {
    const result = await deps.retriever.search({ query: 'it says E04', productId: PRO300 });
    if (result.confidence === 'high') expect(result.suggestedRefinement).toBeUndefined();
  });
});

describe('synonyms', () => {
  it('does not treat a synonym of a documented word as unknown', async () => {
    const result = await deps.retriever.search({ query: 'I think the needle is jammed', productId: PRO200 });
    expect(result.unknownTerms).not.toContain('jammed');
    expect(result.gaps).not.toContain('jammed');
    expect(result.hits.slice(0, 3).some((hit) => /needle/i.test(hit.section))).toBe(true);
  });

  it('reports which synonym matched', async () => {
    const result = await deps.retriever.search({ query: 'I think the needle is jammed', productId: PRO200 });
    const match = result.synonymMatches.find((entry) => entry.term === 'jammed');
    expect(['clogged', 'blocked']).toContain(match?.matched);
  });

  it('finds the clogged needle section from the synonym alone', async () => {
    const result = await deps.retriever.search({ query: 'jammed', productId: PRO200 });
    expect(result.hits.slice(0, 3).some((hit) => /clogged needle/i.test(hit.section))).toBe(true);
  });

  it('does not report a synonym match when the user word itself is in the results', async () => {
    const result = await deps.retriever.search({ query: 'needle clogged', productId: PRO200 });
    expect(result.synonymMatches).toEqual([]);
  });

  it('does not rescue a query about something the product does not have', async () => {
    const result = await deps.retriever.search({ query: 'the grinder is jamming', productId: ES1 });
    expect(result.unknownTerms).toContain('grinder');
    expect(result.confidence).toBe('low');
  });
});

describe('startup checks', () => {
  it('refuses an index built with a different embedding model', () => {
    expect(() => createRetriever({ db: deps.db, embedder: createHashEmbedder(64) })).toThrow(/Re-run ingestion/);
  });

  it('refuses an empty database', () => {
    expect(() => createRetriever({ db: openDb(':memory:'), embedder: createHashEmbedder(128) })).toThrow(/npm run ingest/);
  });
});
