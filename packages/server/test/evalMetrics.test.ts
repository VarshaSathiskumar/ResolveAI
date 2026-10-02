import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  failures,
  goldRank,
  matchesGold,
  parseGold,
  PRODUCT_ALIASES,
  summarize,
  wilson,
  type EvalQuery,
  type Observation,
  type Row,
} from '../eval/metrics.js';
import { FRESH_PATH, LOCK_PATH, verifyLock } from '../eval/lock.js';
import { makeDeps, type TestDeps } from './helpers.js';

const hit = (section: string, productId = 'brewwell-brew-pro-200', docType = 'troubleshooting') => ({ productId, docType, section });

const obs = (hits: ReturnType<typeof hit>[], confidence: Observation['confidence'] = 'high', needs: string[] = [], ms = 1): Observation => ({
  hits,
  confidence,
  needs,
  ms,
});

const answer = (id: string, gold: string[], product?: string): EvalQuery => ({ id, query: id, expect: 'answer', gold, ...(product ? { product } : {}) });
const NEEDLE = 'p200:troubleshooting:Clogged needle (error E01)';

describe('gold matching', () => {
  it('parses a label into product, document type and section', () => {
    expect(parseGold(NEEDLE)).toEqual({ productId: 'brewwell-brew-pro-200', docType: 'troubleshooting', section: 'Clogged needle (error E01)' });
  });

  it('keeps colons inside the section name', () => {
    expect(parseGold('p200:manual:Setup: part one').section).toBe('Setup: part one');
  });

  it('rejects a label with an unknown product alias', () => {
    expect(() => parseGold('nope:manual:X')).toThrow(/Bad gold label/);
  });

  it('matches a sub-section through its parent heading, but not a sibling that shares a prefix', () => {
    const gold = parseGold('p200:manual:Cleaning and care');
    expect(matchesGold(hit('Cleaning and care > Cleaning the piercing needle', undefined, 'manual'), gold)).toBe(true);
    expect(matchesGold(hit('Cleaning and care', undefined, 'manual'), gold)).toBe(true);
    expect(matchesGold(hit('Cleaning and care extras', undefined, 'manual'), gold)).toBe(false);
  });

  it('requires the same product and document type', () => {
    const gold = parseGold(NEEDLE);
    expect(matchesGold(hit('Clogged needle (error E01)', 'brewwell-brew-pro-300'), gold)).toBe(false);
    expect(matchesGold(hit('Clogged needle (error E01)', undefined, 'manual'), gold)).toBe(false);
  });

  it('ranks the first hit that matches any label, from 1', () => {
    const hits = [hit('Quick symptom table'), hit('Leaks'), hit('Clogged needle (error E01)')];
    expect(goldRank(hits, [NEEDLE])).toBe(3);
    expect(goldRank(hits, [NEEDLE, 'p200:troubleshooting:Leaks'])).toBe(2);
    expect(goldRank(hits.slice(0, 1), [NEEDLE])).toBeUndefined();
  });
});

describe('summarize', () => {
  const rows: Row[] = [
    { query: answer('a', [NEEDLE], 'p200'), observation: obs([hit('Clogged needle (error E01)')], 'high') },
    { query: answer('b', [NEEDLE], 'p200'), observation: obs([hit('Quick symptom table'), hit('Clogged needle (error E01)')], 'high') },
    { query: answer('c', [NEEDLE], 'p200'), observation: obs([hit('Leaks'), hit('Weak or cold coffee'), hit('Tank not detected'), hit('Clogged needle (error E01)')], 'medium') },
    { query: answer('d', [NEEDLE], 'p200'), observation: obs([hit('Leaks')], 'low') },
    { query: answer('e', [NEEDLE]), observation: obs([hit('Clogged needle (error E01)')], 'medium', ['product_id']) },
    { query: { id: 'f', query: 'f', expect: 'abstain', product: 'p200' }, observation: obs([hit('Leaks')], 'low') },
    { query: { id: 'g', query: 'g', expect: 'abstain', product: 'p200' }, observation: obs([hit('Leaks')], 'medium') },
    { query: { id: 'h', query: 'h', expect: 'ambiguous' }, observation: obs([hit('Leaks')], 'medium', ['product_id']) },
    { query: { id: 'i', query: 'i', expect: 'ambiguous' }, observation: obs([hit('Leaks')], 'high') },
  ];
  const summary = summarize(rows);

  it('computes recall at 1, 3 and 4 and the reciprocal rank on answerable queries', () => {
    expect(summary.answerable.n).toBe(5);
    expect(summary.answerable.recall1).toBeCloseTo(2 / 5);
    expect(summary.answerable.recall3).toBeCloseTo(3 / 5);
    expect(summary.answerable.recall4).toBeCloseTo(4 / 5);
    expect(summary.answerable.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 4 + 0 + 1) / 5);
  });

  it('counts symptom-table pointers at rank one and answerable queries rated low', () => {
    expect(summary.answerable.pointerTop1).toBeCloseTo(1 / 5);
    expect(summary.answerable.falseAbstain).toBeCloseTo(1 / 5);
  });

  it('counts unscoped answerable queries that needlessly ask for a product', () => {
    expect(summary.answerable.needlessProductQuestion).toBe(1);
  });

  it('reports how often the gold section is present at each confidence level', () => {
    expect(summary.calibration.high).toEqual({ n: 2, goldInTop4: 1 });
    expect(summary.calibration.medium).toEqual({ n: 2, goldInTop4: 1 });
    expect(summary.calibration.low).toEqual({ n: 1, goldInTop4: 0 });
  });

  it('measures abstaining and ambiguity separately', () => {
    expect(summary.abstain).toEqual({ n: 2, recall: 0.5 });
    expect(summary.ambiguous).toEqual({ n: 2, recall: 0.5 });
  });

  it('reports latency percentiles and copes with no rows', () => {
    expect(summary.latency.p50).toBe(1);
    expect(summarize([]).answerable.recall1).toBe(0);
    expect(summarize([]).latency).toEqual({ p50: 0, p95: 0 });
  });
});

describe('failures', () => {
  it('lists answerable queries that missed, were rated low, or were found late', () => {
    const rows: Row[] = [
      { query: answer('miss', [NEEDLE]), observation: obs([hit('Leaks')]) },
      { query: answer('low', [NEEDLE]), observation: obs([hit('Clogged needle (error E01)')], 'low') },
      { query: answer('late', [NEEDLE]), observation: obs([hit('A'), hit('B'), hit('C'), hit('Clogged needle (error E01)')]) },
      { query: answer('fine', [NEEDLE]), observation: obs([hit('Clogged needle (error E01)')]) },
    ];
    expect(failures(rows).map((entry) => entry.id)).toEqual(['miss', 'low', 'late']);
  });

  it('lists an unanswerable query that was not rated low and an ambiguous one that did not ask', () => {
    const rows: Row[] = [
      { query: { id: 'x', query: 'x', expect: 'abstain' }, observation: obs([hit('Leaks')], 'high') },
      { query: { id: 'y', query: 'y', expect: 'ambiguous' }, observation: obs([hit('Leaks')]) },
    ];
    expect(failures(rows).map((entry) => entry.id)).toEqual(['x', 'y']);
  });
});

describe('the query set', () => {
  const queries = JSON.parse(readFileSync(resolve(import.meta.dirname, '../eval/queries.json'), 'utf8')) as EvalQuery[];

  it('has unique ids and a valid label on every answerable query', () => {
    expect(new Set(queries.map((query) => query.id)).size).toBe(queries.length);
    for (const query of queries.filter((candidate) => candidate.expect === 'answer')) {
      expect(query.gold?.length, query.id).toBeGreaterThan(0);
      for (const label of query.gold!) expect(() => parseGold(label), `${query.id}: ${label}`).not.toThrow();
    }
  });

  it('only scopes to known product aliases', () => {
    for (const query of queries) if (query.product) expect(PRODUCT_ALIASES[query.product], query.id).toBeDefined();
  });

  it('covers all three kinds of expectation', () => {
    for (const kind of ['answer', 'abstain', 'ambiguous'] as const) {
      expect(queries.filter((query) => query.expect === kind).length).toBeGreaterThan(5);
    }
  });
});

describe('gold labels against the ingested corpus', () => {
  let deps: TestDeps;
  // Structural check only: no retrieval is run, so a failure list cannot steer how the fresh queries are worded.
  const queries = [
    ...(JSON.parse(readFileSync(resolve(import.meta.dirname, '../eval/queries.json'), 'utf8')) as EvalQuery[]),
    ...(JSON.parse(readFileSync(resolve(import.meta.dirname, '../eval/queries.fresh.json'), 'utf8')) as EvalQuery[]),
  ];

  beforeAll(async () => {
    deps = await makeDeps();
  });

  afterAll(() => deps.db.close());

  it('points every label at a section that exists', () => {
    const rows = deps.db
      .prepare(
        `SELECT d.product_id AS productId, d.type AS docType, c.section AS section
         FROM chunks c JOIN documents d ON d.id = c.document_id`,
      )
      .all() as { productId: string; docType: string; section: string }[];
    const missing = queries
      .flatMap((query) => (query.gold ?? []).map((label) => ({ id: query.id, label })))
      .filter(({ label }) => {
        const gold = parseGold(label);
        return !rows.some((row) => matchesGold(row, gold));
      });
    expect(missing).toEqual([]);
  });
});

describe('the frozen fresh set', () => {
  const read = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../eval/${name}`), 'utf8')) as EvalQuery[];
  const fresh = read('queries.fresh.json');

  it('has ids and query text that do not collide with the main set', () => {
    const main = read('queries.json');
    expect(fresh.length).toBeGreaterThanOrEqual(40);
    expect(fresh.every((query) => query.id.startsWith('f'))).toBe(true);
    expect(new Set(fresh.map((query) => query.id)).size).toBe(fresh.length);
    const mainText = new Set(main.map((query) => `${query.product ?? ''}|${query.query.toLowerCase()}`));
    expect(fresh.filter((query) => mainText.has(`${query.product ?? ''}|${query.query.toLowerCase()}`))).toEqual([]);
  });

  it('still matches its lock: editing a frozen query fails the build until someone relocks with a reason', () => {
    const status = verifyLock(FRESH_PATH, LOCK_PATH);
    expect(status.ok === true ? 'locked' : status.reason).toBe('locked');
  });

  it('covers answerable, unanswerable and ambiguous queries with valid labels', () => {
    for (const kind of ['answer', 'abstain', 'ambiguous'] as const) {
      expect(fresh.filter((query) => query.expect === kind).length, kind).toBeGreaterThan(3);
    }
    for (const query of fresh.filter((candidate) => candidate.expect === 'answer')) {
      expect(query.gold?.length, query.id).toBeGreaterThan(0);
      for (const label of query.gold!) expect(() => parseGold(label), `${query.id}: ${label}`).not.toThrow();
    }
  });
});

describe('wilson interval', () => {
  it('is wide for small samples and narrows as n grows', () => {
    const [smallLow, smallHigh] = wilson(8, 16);
    const [bigLow, bigHigh] = wilson(80, 160);
    expect(smallHigh - smallLow).toBeGreaterThan(bigHigh - bigLow);
    expect(smallLow).toBeLessThan(0.5);
    expect(smallHigh).toBeGreaterThan(0.5);
  });

  it('stays inside 0..1 at the extremes and handles no data', () => {
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(10, 10)[1]).toBe(1);
    expect(wilson(16, 16)[0]).toBeGreaterThan(0.75);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
