import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { competingProducts, productEvidence } from '../src/retrieval/productEvidence.js';
import { createRetriever } from '../src/retrieval/retriever.js';
import { makeDeps, type TestDeps } from './helpers.js';

const candidate = (productId: string, score: number) => ({ productId, score });

describe('productEvidence', () => {
  it('sums the two best candidates per product and sorts the strongest first', () => {
    const evidence = productEvidence([candidate('a', 0.03), candidate('b', 0.025), candidate('a', 0.02), candidate('a', 0.01)]);
    expect(evidence.map((entry) => entry.productId)).toEqual(['a', 'b']);
    expect(evidence[0]).toMatchObject({ productId: 'a', best: 0.03, chunks: 3 });
    expect(evidence[0]!.evidence).toBeCloseTo(0.05);
    expect(evidence[1]!.evidence).toBeCloseTo(0.025);
  });

  it('only looks at the top k candidates', () => {
    const evidence = productEvidence([candidate('a', 0.03), candidate('a', 0.02), candidate('b', 0.019)], 2);
    expect(evidence.map((entry) => entry.productId)).toEqual(['a']);
  });

  it('breaks ties by product id so the order is stable', () => {
    expect(productEvidence([candidate('b', 0.02), candidate('a', 0.02)]).map((entry) => entry.productId)).toEqual(['a', 'b']);
  });

  it('copes with no candidates', () => {
    expect(productEvidence([])).toEqual([]);
    expect(competingProducts([], 0.75)).toEqual([]);
  });
});

describe('competingProducts', () => {
  const evidence = productEvidence([candidate('a', 0.03), candidate('a', 0.02), candidate('b', 0.03), candidate('b', 0.015), candidate('c', 0.01)]);

  it('names the products within the fraction of the leader, when there are at least two', () => {
    expect(competingProducts(evidence, 0.75).map((entry) => entry.productId)).toEqual(['a', 'b']);
  });

  it('is empty when one product clearly leads', () => {
    expect(competingProducts(productEvidence([candidate('a', 0.03), candidate('a', 0.025), candidate('b', 0.01)]), 0.75)).toEqual([]);
  });

  it('is empty for a single product, however strong', () => {
    expect(competingProducts(productEvidence([candidate('a', 0.03), candidate('a', 0.02)]), 0.75)).toEqual([]);
  });

  it('widens as the fraction is lowered', () => {
    expect(competingProducts(evidence, 0.15).map((entry) => entry.productId)).toEqual(['a', 'b', 'c']);
  });
});

describe('asking which product (v2)', () => {
  let deps: TestDeps;
  const v2 = () => createRetriever({ db: deps.db, embedder: deps.embedder, productAmbiguity: 'v2' });

  beforeAll(async () => {
    deps = await makeDeps();
  });

  afterAll(() => deps.db.close());

  it('asks which product for an error code that two products document, and names both models', async () => {
    const result = await v2().search({ query: 'E03' });
    expect(result.needs).toEqual(['product_id']);
    expect(result.competingProducts.map((entry) => entry.model).sort()).toEqual(['Brew Pro 200', 'Brew Pro 300']);
    expect(result.suggestedRefinement).toMatch(/Brew Pro 200 and Brew Pro 300 match about equally/);
    expect(result.suggestedRefinement).toMatch(/list_owned_products/);
    expect(result.confidence).not.toBe('high');
  });

  it('does not ask for an error code only one product documents', async () => {
    for (const query of ['E04', 'error E-04', 'E05', 'E01']) {
      const result = await v2().search({ query });
      expect(result.needs, query).toEqual([]);
      expect(result.competingProducts, query).toEqual([]);
    }
  });

  it('never asks once the search is scoped to a product', async () => {
    const result = await v2().search({ query: 'E03', productId: 'brewwell-brew-pro-200' });
    expect(result.needs).toEqual([]);
    expect(result.competingProducts).toEqual([]);
  });

  it('asks for a symptom that several products document and the user did not tie to one', async () => {
    const result = await v2().search({ query: 'descale required blinking' });
    expect(result.needs).toEqual(['product_id']);
    expect(result.competingProducts.length).toBeGreaterThanOrEqual(2);
  });

  it('the original rule is untouched by default', async () => {
    const original = await createRetriever({ db: deps.db, embedder: deps.embedder }).search({ query: 'E04' });
    expect(original.competingProducts).toEqual([]);
  });

  it('is not sensitive to the number of results asked for, unlike the original rule', async () => {
    const few = await v2().search({ query: 'E03', limit: 1 });
    const many = await v2().search({ query: 'E03', limit: 8 });
    expect(few.needs).toEqual(many.needs);
    expect(few.competingProducts.map((entry) => entry.productId)).toEqual(many.competingProducts.map((entry) => entry.productId));
  });
});
