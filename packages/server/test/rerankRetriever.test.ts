import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRetriever, type Retriever, type SearchResult } from '../src/retrieval/retriever.js';
import { createOverlapReranker, type Reranker } from '../src/retrieval/rerank.js';
import { makeDeps, type TestDeps } from './helpers.js';

const PRO200 = 'brewwell-brew-pro-200';
const QUERY = 'the light is flashing red and nothing comes out';

let deps: TestDeps;
const build = (extra: Partial<Parameters<typeof createRetriever>[0]> = {}): Retriever =>
  createRetriever({ db: deps.db, embedder: deps.embedder, ...extra });

/** Gives the best score to the fused first candidate, the next best to the second, and so on (changes nothing). */
const identity: Reranker = { model: 'identity', score: async (_q, passages) => passages.map((_, i) => passages.length - i) };
/** Gives the best score to the fused last candidate: the exact reverse. */
const reversing: Reranker = { model: 'reversing', score: async (_q, passages) => passages.map((_, i) => i) };

const ids = (result: SearchResult) => result.hits.map((hit) => hit.chunkId);

beforeAll(async () => {
  deps = await makeDeps();
});

afterAll(() => deps.db.close());

describe('reranking', () => {
  it('leaves results exactly as before when no reranker is configured, whatever the other rerank settings say', async () => {
    const plain = await build().search({ query: QUERY, productId: PRO200, limit: 6 });
    const settings = await build({ rerankTop: 3, rerankKeep: 2, rerankWeight: 0.2, rerankContext: true }).search({ query: QUERY, productId: PRO200, limit: 6 });
    expect(ids(settings)).toEqual(ids(plain));
    expect(settings.confidence).toBe(plain.confidence);
    expect(settings.rerank).toBeUndefined();
    expect(settings.signals.rerankTopScore).toBeUndefined();
  });

  it('keeps the order with an identity reranker and reverses the top N with a reversing one', async () => {
    const fused = await build().search({ query: QUERY, productId: PRO200, limit: 8 });
    const same = await build({ reranker: identity }).search({ query: QUERY, productId: PRO200, limit: 8 });
    expect(ids(same)).toEqual(ids(fused));

    const reversed = await build({ reranker: reversing, rerankTop: 4 }).search({ query: QUERY, productId: PRO200, limit: 8 });
    expect(ids(reversed).slice(0, 4)).toEqual(ids(fused).slice(0, 4).reverse());
    // Beyond the re-scored block the fused order carries on untouched.
    expect(ids(reversed).slice(4)).toEqual(ids(fused).slice(4));
  });

  it('only sends the top N candidates to the reranker', async () => {
    const seen: string[][] = [];
    const spy: Reranker = { model: 'spy', score: async (_q, passages) => (seen.push(passages), passages.map(() => 0)) };
    await build({ reranker: spy, rerankTop: 3 }).search({ query: QUERY, productId: PRO200, limit: 4 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);
  });

  it('sends the document title with each passage only when asked to', async () => {
    const seen: string[][] = [];
    const spy: Reranker = { model: 'spy', score: async (_q, passages) => (seen.push(passages), passages.map(() => 0)) };
    await build({ reranker: spy }).search({ query: QUERY, productId: PRO200 });
    await build({ reranker: spy, rerankContext: true }).search({ query: QUERY, productId: PRO200 });
    expect(seen[0]!.every((passage) => !passage.includes('User Manual') && !passage.includes('Troubleshooting Guide.'))).toBe(true);
    expect(seen[1]!.every((passage) => /^Brewwell Brew Pro 200 [A-Za-z ]+\. /.test(passage))).toBe(true);
  });

  it('blend weight 0 reproduces the fused order even for a reranker that reverses it', async () => {
    const fused = await build().search({ query: QUERY, productId: PRO200, limit: 6 });
    const blended = await build({ reranker: reversing, rerankWeight: 0 }).search({ query: QUERY, productId: PRO200, limit: 6 });
    expect(ids(blended)).toEqual(ids(fused));
  });

  it('the recall floor keeps the fused top candidates in the returned hits when a reranker would push them out', async () => {
    const fused = await build().search({ query: QUERY, productId: PRO200, limit: 4 });
    const evicting = await build({ reranker: reversing, rerankTop: 10 }).search({ query: QUERY, productId: PRO200, limit: 4 });
    const protectedIds = ids(fused).slice(0, 2);
    expect(protectedIds.some((id) => !ids(evicting).includes(id))).toBe(true); // without a floor, one is evicted
    const floored = await build({ reranker: reversing, rerankTop: 10, rerankKeep: 2 }).search({ query: QUERY, productId: PRO200, limit: 4 });
    expect(protectedIds.every((id) => ids(floored).includes(id))).toBe(true);
    expect(floored.hits).toHaveLength(4);
    expect(new Set(ids(floored)).size).toBe(4);
  });

  it('reports the model, how many candidates were re-scored and the time taken', async () => {
    const result = await build({ reranker: createOverlapReranker(), rerankTop: 5 }).search({ query: QUERY, productId: PRO200 });
    expect(result.rerank).toMatchObject({ model: 'overlap-test', candidates: 5 });
    expect(result.rerank!.ms).toBeGreaterThanOrEqual(0);
    expect(result.hits[0]?.rerankScore).toBeTypeOf('number');
  });

  it('falls back to the fused order, without failing the search, when the reranker throws or answers wrongly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fused = await build().search({ query: QUERY, productId: PRO200 });
    const broken: Reranker = { model: 'broken', score: async () => { throw new Error('model unavailable'); } };
    const wrongLength: Reranker = { model: 'short', score: async () => [1] };
    for (const reranker of [broken, wrongLength]) {
      const result = await build({ reranker }).search({ query: QUERY, productId: PRO200 });
      expect(ids(result)).toEqual(ids(fused));
      expect(result.rerank).toBeUndefined();
      expect(result.signals.rerankTopScore).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('signal provenance', () => {
  const search = (reranker?: Reranker) => build({ reranker }).search({ query: QUERY, productId: PRO200, limit: 4 });

  it('keeps agreement and margin identical with the reranker off, with an identity reranker and with a reversing one', async () => {
    const off = await search();
    const same = await search(identity);
    const reversed = await search(reversing);
    for (const result of [same, reversed]) {
      expect(result.signals.agreement).toBe(off.signals.agreement);
      expect(result.signals.margin).toBe(off.signals.margin);
    }
    // The returned order did change for the reversing reranker, so these really are independent of it.
    expect(ids(reversed)).not.toEqual(ids(off));
  });

  it('keeps every hit\'s keyword, vector, exact and fused ranks as recorded before reranking', async () => {
    const off = await search();
    const reversed = await build({ reranker: reversing, rerankTop: 4 }).search({ query: QUERY, productId: PRO200, limit: 4 });
    const recorded = new Map(off.hits.map((hit) => [hit.chunkId, hit.provenance]));
    for (const hit of reversed.hits) expect(hit.provenance).toEqual(recorded.get(hit.chunkId));
  });

  it('adds the reranker signals only when a reranker ran, as extras that never replace the generator signals', async () => {
    const off = await search();
    expect(off.signals.rerankTopMatchesRrfTop).toBeUndefined();
    expect(off.signals.rerankMargin).toBeUndefined();

    const same = await search(identity);
    expect(same.signals.rerankTopMatchesRrfTop).toBe(true);
    expect(same.signals.rerankMargin).toBe(1);
    expect(same.signals.agreement).toBeTypeOf('boolean');

    const reversed = await search(reversing);
    expect(reversed.signals.rerankTopMatchesRrfTop).toBe(false);
  });

  it('reports the cross-encoder score of the returned top hit', async () => {
    const result = await search(createOverlapReranker());
    expect(result.signals.rerankTopScore).toBe(result.hits[0]!.rerankScore);
  });
});
