import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TOKENS, type TestApp } from './testApp.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(() => app.close());

interface Found {
  symptom_terms: string[];
  checked: number;
  matches: { product_id: string; category: string; section: string }[];
  not_matching: { product_id: string; category: string }[];
  needs: string[];
}

const find = async (token: string, symptom: string) => app.call('legacy', token, 'find_products_by_symptom', { symptom });

describe('find_products_by_symptom', () => {
  it('finds the products whose guides mention "slow", and none of the products that can never be slow', async () => {
    const out = (await find(TOKENS.alex, 'it is slow')).structuredContent as Found;
    expect(out.checked).toBe(11);
    expect(out.matches.map((match) => match.category)).toEqual(['smartphone', 'coffee machine', 'laptop']);
    expect(out.not_matching.map((product) => product.category)).toEqual(expect.arrayContaining(['storage box', 'bath towel', 'desk lamp', 'umbrella']));
    expect(out.needs).toEqual(['which_product']);
  });

  it('ignores intensifiers, so "too slow" finds the same products as "it is slow"', async () => {
    const out = (await find(TOKENS.alex, 'too slow')).structuredContent as Found;
    expect(out.symptom_terms).toEqual(['slow']);
    expect(out.matches.map((match) => match.category)).toEqual(['smartphone', 'coffee machine', 'laptop']);
  });

  it('names the guide section that mentions the symptom', async () => {
    const out = (await find(TOKENS.alex, 'it is slow')).structuredContent as Found;
    expect(out.matches.find((match) => match.category === 'laptop')?.section).toBe('Laptop is slow');
  });

  it('uses the product without asking when only one guide matches', async () => {
    const out = (await find(TOKENS.alex, 'the zip is stuck')).structuredContent as Found;
    expect(out.matches.map((match) => match.product_id)).toEqual(['trailpack-daypack']);
    expect(out.needs).toEqual([]);
  });

  it('matches nothing when no guide mentions the symptom', async () => {
    const result = await find(TOKENS.alex, 'it is haunted');
    expect((result.structuredContent as Found).matches).toEqual([]);
    expect(JSON.stringify(result.content)).toMatch(/None of the 11 registered products/);
  });

  it('is an error for a token with no user behind it', async () => {
    const result = await find(TOKENS.service, 'it is slow');
    expect(result.isError).toBe(true);
  });
});
