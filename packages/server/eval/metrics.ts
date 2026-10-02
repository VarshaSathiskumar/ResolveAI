export type Expect = 'answer' | 'abstain' | 'ambiguous';
export type Confidence = 'high' | 'medium' | 'low';

export interface EvalQuery {
  id: string;
  query: string;
  /** Product alias (p200, p300, dm12, es1) the search is scoped to. Unscoped when absent. */
  product?: string;
  expect: Expect;
  /** "alias:doc_type:section" labels. A parent heading also matches its sub-sections. */
  gold?: string[];
}

export interface ObservedHit {
  productId: string;
  docType: string;
  section: string;
}

/** The evidence behind a confidence rating, as the retriever exposes it. */
export interface ObservedSignals {
  coverage: number;
  unknownShare: number;
  topCosine: number;
  agreement: boolean;
  margin: number;
  cosineProminence: number;
  coverageTop1: number;
  codeRequested: boolean;
  codeMatched: boolean;
  ambiguousProduct: boolean;
}

export interface Observation {
  signals?: ObservedSignals;
  hits: ObservedHit[];
  confidence: Confidence;
  needs: string[];
  ms: number;
}

export interface Row {
  query: EvalQuery;
  observation: Observation;
}

export const PRODUCT_ALIASES: Record<string, string> = {
  p200: 'brewwell-brew-pro-200',
  p300: 'brewwell-brew-pro-300',
  dm12: 'brewwell-dripmate-12',
  es1: 'brewwell-espresso-studio-es1',
};

interface Gold {
  productId: string;
  docType: string;
  section: string;
}

export function parseGold(label: string): Gold {
  const [alias, docType, ...rest] = label.split(':');
  const productId = PRODUCT_ALIASES[alias ?? ''];
  if (!productId || !docType || rest.length === 0) throw new Error(`Bad gold label: ${label}`);
  return { productId, docType, section: rest.join(':') };
}

export function matchesGold(hit: ObservedHit, gold: Gold): boolean {
  return (
    hit.productId === gold.productId &&
    hit.docType === gold.docType &&
    (hit.section === gold.section || hit.section.startsWith(`${gold.section} > `))
  );
}

/** 1-based rank of the first hit that matches any gold label, or undefined when none does. */
export function goldRank(hits: ObservedHit[], labels: string[]): number | undefined {
  const golds = labels.map(parseGold);
  const index = hits.findIndex((hit) => golds.some((gold) => matchesGold(hit, gold)));
  return index === -1 ? undefined : index + 1;
}

const POINTER = /symptom table/i;

export interface Summary {
  queries: number;
  answerable: {
    n: number;
    recall1: number;
    recall3: number;
    recall4: number;
    mrr: number;
    /** Share whose top result is a symptom-table pointer rather than the answering section. */
    pointerTop1: number;
    /** Answerable queries the retriever rated low. */
    falseAbstain: number;
    /** Unscoped answerable queries that wrongly asked for a product. */
    needlessProductQuestion: number;
    /** How many answerable queries were unscoped, the denominator of the rate above. */
    unscopedAnswerable: number;
    /** Answerable queries rated high or medium whose gold section was not returned: confident and wrong. */
    confidentWrong: number;
  };
  /** For answerable queries, how often the gold section is in the top 4, by the confidence given. */
  calibration: Record<Confidence, { n: number; goldInTop4: number }>;
  abstain: { n: number; recall: number };
  ambiguous: { n: number; recall: number };
  latency: { p50: number; p95: number };
}

const share = (count: number, total: number) => (total === 0 ? 0 : count / total);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function summarize(rows: Row[]): Summary {
  const answerable = rows.filter((row) => row.query.expect === 'answer');
  const ranks = answerable.map((row) => goldRank(row.observation.hits, row.query.gold ?? []));
  const atMost = (k: number) => ranks.filter((rank) => rank !== undefined && rank <= k).length;

  const calibration: Summary['calibration'] = {
    high: { n: 0, goldInTop4: 0 },
    medium: { n: 0, goldInTop4: 0 },
    low: { n: 0, goldInTop4: 0 },
  };
  answerable.forEach((row, index) => {
    const bucket = calibration[row.observation.confidence];
    bucket.n += 1;
    if (ranks[index] !== undefined) bucket.goldInTop4 += 1;
  });
  for (const bucket of Object.values(calibration)) bucket.goldInTop4 = share(bucket.goldInTop4, bucket.n);

  const abstain = rows.filter((row) => row.query.expect === 'abstain');
  const ambiguous = rows.filter((row) => row.query.expect === 'ambiguous');
  const unscopedAnswerable = answerable.filter((row) => !row.query.product);
  const times = rows.map((row) => row.observation.ms).sort((a, b) => a - b);

  return {
    queries: rows.length,
    answerable: {
      n: answerable.length,
      recall1: share(atMost(1), answerable.length),
      recall3: share(atMost(3), answerable.length),
      recall4: share(atMost(4), answerable.length),
      mrr: share(
        ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0),
        answerable.length,
      ),
      pointerTop1: share(
        answerable.filter((row) => POINTER.test(row.observation.hits[0]?.section ?? '')).length,
        answerable.length,
      ),
      falseAbstain: share(answerable.filter((row) => row.observation.confidence === 'low').length, answerable.length),
      needlessProductQuestion: share(
        unscopedAnswerable.filter((row) => row.observation.needs.includes('product_id')).length,
        unscopedAnswerable.length,
      ),
      unscopedAnswerable: unscopedAnswerable.length,
      confidentWrong: share(
        answerable.filter(
          (row, index) => row.observation.confidence !== 'low' && ranks[index] === undefined,
        ).length,
        answerable.length,
      ),
    },
    calibration,
    abstain: { n: abstain.length, recall: share(abstain.filter((row) => row.observation.confidence === 'low').length, abstain.length) },
    ambiguous: {
      n: ambiguous.length,
      recall: share(ambiguous.filter((row) => row.observation.needs.includes('product_id')).length, ambiguous.length),
    },
    latency: { p50: quantile(times, 0.5), p95: quantile(times, 0.95) },
  };
}

/** Which queries went wrong, for the report. */
export function failures(rows: Row[]): { id: string; query: string; problem: string }[] {
  const out: { id: string; query: string; problem: string }[] = [];
  for (const row of rows) {
    const { query, observation } = row;
    const base = { id: query.id, query: query.query };
    if (query.expect === 'answer') {
      const rank = goldRank(observation.hits, query.gold ?? []);
      if (rank === undefined) out.push({ ...base, problem: `gold not in top ${observation.hits.length} (rated ${observation.confidence})` });
      else if (observation.confidence === 'low') out.push({ ...base, problem: `answered at rank ${rank} but rated low` });
      else if (rank > 3) out.push({ ...base, problem: `gold only at rank ${rank}` });
    } else if (query.expect === 'abstain' && observation.confidence !== 'low') {
      out.push({ ...base, problem: `should abstain but rated ${observation.confidence}` });
    } else if (query.expect === 'ambiguous' && !observation.needs.includes('product_id')) {
      out.push({ ...base, problem: 'should ask which product but did not' });
    }
  }
  return out;
}

/** 95% Wilson score interval for a proportion, as [low, high] in 0..1. Wide when n is small, which is the point. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
