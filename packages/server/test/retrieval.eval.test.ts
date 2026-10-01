import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTransformersEmbedder } from '../src/ingest/embed.js';
import { makeDeps, type TestDeps } from './helpers.js';

/**
 * Calibration eval for the sufficiency thresholds, run against the real embedding model.
 * Slow and needs the model (downloaded on first use), so it is opt-in:
 *   npm run test:model -w @resolveai/server
 * Re-run it after changing the model, the corpus or the thresholds.
 */
const enabled = process.env.RESOLVEAI_MODEL_TESTS === '1';

const P = (id: string) => `brewwell-${id}`;
const PRO200 = P('brew-pro-200');
const PRO300 = P('brew-pro-300');
const ES1 = P('espresso-studio-es1');
const DRIP = P('dripmate-12');

const answerable: { query: string; product: string; section: RegExp | undefined; minimum: 'medium' | 'high' }[] = [
  { query: 'my machine isnt brewing only a few drops come out', product: PRO200, section: /needle/i, minimum: 'high' },
  { query: 'amber light is blinking', product: PRO200, section: /E03|descal/i, minimum: 'high' },
  { query: 'pump is noisy and no water comes out', product: PRO300, section: /E04|seal/i, minimum: 'high' },
  { query: 'it shows E04', product: PRO300, section: /seal/i, minimum: 'high' },
  { query: 'pump buzzes but no water', product: ES1, section: /airlock/i, minimum: 'high' },
  { query: 'it only makes half a pot', product: DRIP, section: /slow|partial/i, minimum: 'high' },
  { query: 'nothing lights up no power', product: DRIP, section: /no power/i, minimum: 'high' },
  { query: 'how long is the warranty', product: PRO200, section: /warranty term/i, minimum: 'high' },
  { query: 'the shot is watery', product: ES1, section: undefined, minimum: 'medium' },
];

const unanswerable: { query: string; product: string }[] = [
  { query: 'wifi will not connect to the phone app', product: PRO200 },
  { query: 'milk frother is not frothing', product: PRO200 },
  { query: 'how do I update the firmware', product: DRIP },
  { query: 'error E99 on the display', product: PRO200 },
  { query: 'the grinder is jamming', product: ES1 },
  { query: 'how do I clean the washing machine drum', product: PRO300 },
];

const rank = { low: 0, medium: 1, high: 2 } as const;

describe.skipIf(!enabled)('retrieval calibration with the real embedding model', () => {
  let deps: TestDeps;

  beforeAll(async () => {
    deps = await makeDeps(createTransformersEmbedder());
  }, 300_000);

  afterAll(() => deps?.db.close());

  it.each(answerable)('answers "$query"', async ({ query, product, section, minimum }) => {
    const result = await deps.retriever.search({ query, productId: product });
    expect(rank[result.confidence]).toBeGreaterThanOrEqual(rank[minimum]);
    if (section) expect(result.hits.slice(0, 3).some((hit) => section.test(hit.section))).toBe(true);
  });

  it.each(unanswerable)('abstains on "$query"', async ({ query, product }) => {
    const result = await deps.retriever.search({ query, productId: product });
    expect(result.confidence).toBe('low');
  });

  it('asks for the product when an unscoped symptom fits several machines', async () => {
    const result = await deps.retriever.search({ query: 'my coffee machine isnt brewing' });
    expect(result.needs).toContain('product_id');
    expect(result.confidence).not.toBe('high');
  });

  it('resolves a bare error code to the one product that has it', async () => {
    const result = await deps.retriever.search({ query: 'E04' });
    expect(result.hits[0]?.productId).toBe(PRO300);
    expect(result.confidence).toBe('high');
  });
});
