import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identifyProduct } from '../src/products/identify.js';
import type { Product } from '../src/products/catalog.js';
import { makeDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;
let products: Product[];

beforeAll(async () => {
  deps = await makeDeps();
  products = deps.catalog.allProducts();
});

afterAll(() => deps.db.close());

const top = (description: string, owned: string[] = []) => identifyProduct(description, products, new Set(owned));

describe('identifyProduct', () => {
  it.each(['BP-200', 'bp200', 'BP 200', 'my BP-200', 'Brew Pro 200', 'the Brewwell Brew Pro 200'])(
    'recognises "%s" as the Brew Pro 200',
    (description) => {
      const result = top(description);
      expect(result.candidates[0]?.productId).toBe('brewwell-brew-pro-200');
      expect(result.candidates[0]?.confidence).toBe('high');
      expect(result.ambiguous).toBe(false);
      expect(result.needs).toEqual([]);
    },
  );

  it.each([
    ['ES-1', 'brewwell-espresso-studio-es1'],
    ['Espresso Studio', 'brewwell-espresso-studio-es1'],
    ['DM12', 'brewwell-dripmate-12'],
    ['DripMate', 'brewwell-dripmate-12'],
  ])('recognises "%s"', (description, productId) => {
    const result = top(description);
    expect(result.candidates[0]?.productId).toBe(productId);
    expect(result.ambiguous).toBe(false);
  });

  it('treats "Brew Pro" as ambiguous between the 200 and the 300', () => {
    const result = top('Brew Pro');
    expect(result.ambiguous).toBe(true);
    expect(result.needs).toEqual(['model']);
    expect(result.candidates.map((candidate) => candidate.productId).sort()).toEqual([
      'brewwell-brew-pro-200',
      'brewwell-brew-pro-300',
    ]);
    expect(result.candidates.every((candidate) => candidate.confidence !== 'high')).toBe(true);
  });

  it('builds a question from the specs that differ between the ambiguous models', () => {
    const result = top('Brew Pro');
    expect(result.suggestedQuestion).toMatch(/Brew Pro 200/);
    expect(result.suggestedQuestion).toMatch(/Brew Pro 300/);
    expect(result.suggestedQuestion).toMatch(/milk frother/);
    expect(result.suggestedQuestion).toMatch(/colour LCD/);
    const pro300 = result.candidates.find((candidate) => candidate.productId === 'brewwell-brew-pro-300');
    expect(pro300?.distinguishing.some((entry) => entry.startsWith('display'))).toBe(true);
  });

  it('is no longer ambiguous once the number is given', () => {
    const result = top('Brew Pro 300');
    expect(result.candidates[0]?.productId).toBe('brewwell-brew-pro-300');
    expect(result.ambiguous).toBe(false);
  });

  it('finds a model from a description of its features', () => {
    expect(top('the pod one with the milk frother').candidates[0]?.productId).toBe('brewwell-brew-pro-300');
    expect(top('a drip coffee maker').candidates[0]?.productId).toBe('brewwell-dripmate-12');
    expect(top('my espresso machine').candidates[0]?.productId).toBe('brewwell-espresso-studio-es1');
  });

  it('is ambiguous for a description that fits both pod machines', () => {
    expect(top('pod coffee machine').ambiguous).toBe(true);
  });

  it('returns nothing, and asks for the model, when nothing matches', () => {
    const result = top('washing machine');
    expect(result.candidates).toEqual([]);
    expect(result.needs).toEqual(['model']);
    expect(result.ambiguous).toBe(false);
  });

  it('ranks an owned product first and flags it, without hiding the ambiguity', () => {
    const result = top('Brew Pro', ['brewwell-brew-pro-300']);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates[0]).toMatchObject({ productId: 'brewwell-brew-pro-300', owned: true });
    expect(result.candidates[1]?.owned).toBe(false);
    expect(result.suggestedQuestion).toMatch(/registered Brew Pro 300/);
  });

  it('respects the limit', () => {
    expect(identifyProduct('Brew Pro', products, new Set(), 1).candidates).toHaveLength(1);
  });
});
