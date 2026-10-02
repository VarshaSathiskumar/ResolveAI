import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/schema.js';
import { createTransformersEmbedder } from '../src/ingest/embed.js';
import { createCrossEncoderReranker } from '../src/retrieval/rerank.js';
import { ingestCorpus } from '../src/ingest/ingest.js';
import { createRetriever, type Retriever } from '../src/retrieval/retriever.js';
import { FRESH_PATH, LOCK_PATH, verifyLock, writeLock } from './lock.js';
import { splitMain } from './splits.js';
import { variantOptions } from './variants.js';
import { failures, goldRank, PRODUCT_ALIASES, summarize, wilson, type EvalQuery, type Row, type Summary } from './metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = resolve(here, '../../../corpus');
const LOCAL_PATH = resolve(here, 'queries.local.json');
const baselinePath = resolve(here, 'baseline.json');

const { values } = parseArgs({
  options: {
    'write-baseline': { type: 'boolean', default: false },
    failures: { type: 'boolean', default: false },
    variant: { type: 'string', multiple: true },
    label: { type: 'string', default: '' },
    relock: { type: 'string' },
    // Per-query signals. Dev only: the frozen and held-out sets are for checking, never for designing.
    signals: { type: 'boolean', default: false },
  },
});

// The fresh set was written and locked before any change under test. Refuse to run if it moved.
if (values.relock !== undefined) {
  const lock = writeLock(FRESH_PATH, LOCK_PATH, { relockReason: values.relock });
  console.warn(`WARNING: fresh set RELOCKED (${lock.relocks.length} override(s) on record). Reason: ${values.relock}`);
}
const lockStatus = verifyLock(FRESH_PATH, LOCK_PATH);
if (!lockStatus.ok) {
  console.error(`Refusing to run: ${lockStatus.reason}.\nRestore the file, or override deliberately with --relock "reason".`);
  process.exit(1);
}

const readQueries = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as EvalQuery[];
const main = readQueries(resolve(here, 'queries.json'));
const { dev, heldout } = splitMain(main);
const splitOf: Record<string, EvalQuery[]> = {
  dev,
  heldout,
  fresh: readQueries(FRESH_PATH),
  ...(existsSync(LOCAL_PATH) ? { local: readQueries(LOCAL_PATH) } : {}),
};
const SPLIT_TITLES: Record<string, string> = {
  dev: 'DEV (tuning allowed)',
  heldout: 'HELD OUT (check only)',
  fresh: 'FRESH (frozen before any change; check only)',
  local: 'LOCAL (your own queries; report only)',
};

const embedder = createTransformersEmbedder();
const crossEncoder = createCrossEncoderReranker();
const db = openDb(':memory:');
const stats = await ingestCorpus({ corpusDir, db, embedder });

async function runVariant(variant: string): Promise<Record<string, Row[]>> {
  const retriever: Retriever = createRetriever({ db, embedder, ...variantOptions(variant, crossEncoder) });
  await retriever.search({ query: 'warm up the model', limit: 1 });
  const out: Record<string, Row[]> = {};
  for (const [split, queries] of Object.entries(splitOf)) {
    out[split] = [];
    for (const query of queries) {
      const started = performance.now();
      const result = await retriever.search({
        query: query.query,
        productId: query.product ? PRODUCT_ALIASES[query.product] : undefined,
        limit: 4,
      });
      out[split]!.push({
        query,
        observation: {
          signals: {
            coverage: result.signals.coverage,
            unknownShare: result.signals.unknownShare,
            topCosine: result.signals.topCosine,
            agreement: result.signals.agreement,
            margin: result.signals.margin,
            cosineProminence: result.signals.cosineProminence,
            coverageTop1: result.signals.coverageTop1,
            codeRequested: result.signals.codeRequested,
            codeMatched: result.signals.codeMatched,
            ambiguousProduct: result.signals.ambiguousProduct,
          },
          hits: result.hits.map((hit) => ({ productId: hit.productId, docType: hit.docType, section: hit.section })),
          confidence: result.confidence,
          needs: result.needs,
          ms: performance.now() - started,
        },
      });
    }
  }
  return out;
}

type Baseline = { chunks: number; splits: Record<string, Summary> };
const parsedBaseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Partial<Baseline>) : undefined;
// An older baseline file without per-split summaries is treated as missing.
const baseline = parsedBaseline?.splits ? (parsedBaseline as Baseline) : undefined;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const interval = (k: number, n: number) => {
  const [low, high] = wilson(k, n);
  return `[${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}]`;
};
const delta = (now: number, before: number | undefined, percent: boolean) => {
  if (before === undefined) return '';
  const diff = now - before;
  if (Math.abs(diff) < 0.0005) return '  (same)';
  return `  (${diff > 0 ? '+' : ''}${percent ? `${(diff * 100).toFixed(1)} pts` : diff.toFixed(3)})`;
};

interface Metric {
  label: string;
  read: (s: Summary) => number;
  /** Numerator and denominator for the confidence interval, when the metric is a proportion. */
  counts?: (s: Summary) => [number, number];
  percent: boolean;
}
const metrics: Metric[] = [
  { label: 'recall@1', read: (s) => s.answerable.recall1, counts: (s) => [Math.round(s.answerable.recall1 * s.answerable.n), s.answerable.n], percent: true },
  { label: 'recall@3', read: (s) => s.answerable.recall3, counts: (s) => [Math.round(s.answerable.recall3 * s.answerable.n), s.answerable.n], percent: true },
  { label: 'recall@4', read: (s) => s.answerable.recall4, counts: (s) => [Math.round(s.answerable.recall4 * s.answerable.n), s.answerable.n], percent: true },
  { label: 'MRR', read: (s) => s.answerable.mrr, percent: false },
  { label: 'symptom table at rank 1', read: (s) => s.answerable.pointerTop1, counts: (s) => [Math.round(s.answerable.pointerTop1 * s.answerable.n), s.answerable.n], percent: true },
  { label: 'false abstain (answerable rated low)', read: (s) => s.answerable.falseAbstain, counts: (s) => [Math.round(s.answerable.falseAbstain * s.answerable.n), s.answerable.n], percent: true },
  { label: 'confident and wrong (high/med, no gold)', read: (s) => s.answerable.confidentWrong, counts: (s) => [Math.round(s.answerable.confidentWrong * s.answerable.n), s.answerable.n], percent: true },
  { label: 'needless "which product?" (unscoped)', read: (s) => s.answerable.needlessProductQuestion, counts: (s) => [Math.round(s.answerable.needlessProductQuestion * s.answerable.unscopedAnswerable), s.answerable.unscopedAnswerable], percent: true },
  { label: 'abstain recall (unanswerable rated low)', read: (s) => s.abstain.recall, counts: (s) => [Math.round(s.abstain.recall * s.abstain.n), s.abstain.n], percent: true },
  { label: 'ambiguity recall (asks which product)', read: (s) => s.ambiguous.recall, counts: (s) => [Math.round(s.ambiguous.recall * s.ambiguous.n), s.ambiguous.n], percent: true },
];

function report(title: string, now: Summary, before: Summary | undefined) {
  console.log(`\n${title}  (${now.queries} queries: ${now.answerable.n} answerable, ${now.abstain.n} unanswerable, ${now.ambiguous.n} ambiguous)`);
  for (const metric of metrics) {
    const value = metric.read(now);
    const text = metric.percent ? pct(value) : value.toFixed(3);
    const ci = metric.counts ? ` ${interval(...metric.counts(now))}` : '';
    console.log(`  ${metric.label.padEnd(42)} ${text.padStart(7)}${ci.padEnd(11)}${delta(value, before ? metric.read(before) : undefined, metric.percent)}`);
  }
  const reliability = (['high', 'medium', 'low'] as const)
    .map((level) => `${level} ${now.calibration[level].n === 0 ? 'n/a' : pct(now.calibration[level].goldInTop4)} (n=${now.calibration[level].n})`)
    .join(' | ');
  console.log(`  confidence reliability, gold in top 4:  ${reliability}`);
  console.log(`  latency p50 ${now.latency.p50.toFixed(1)} ms, p95 ${now.latency.p95.toFixed(1)} ms`);
}

const variants = values.variant?.length ? values.variant : ['baseline'];
console.log(`Retrieval eval: ${stats.chunks} chunks, ${stats.embeddingModel}${values.label ? `, ${values.label}` : ''}`);
console.log(`Fresh set: locked, hash ok (${lockStatus.lock.ids.length} queries, locked ${lockStatus.lock.lockedAt}, ${lockStatus.lock.relocks.length} relock(s))`);
console.log(baseline ? 'Deltas are against eval/baseline.json.' : 'No baseline yet (run with --write-baseline).');

const results: Record<string, Record<string, Summary>> = {};
const allRows: Record<string, Record<string, Row[]>> = {};
for (const variant of variants) {
  const rows = await runVariant(variant);
  allRows[variant] = rows;
  results[variant] = Object.fromEntries(Object.entries(rows).map(([split, splitRows]) => [split, summarize(splitRows)]));
  console.log(`\n=== variant: ${variant} ===`);
  for (const split of Object.keys(rows)) report(SPLIT_TITLES[split] ?? split, results[variant]![split]!, baseline?.splits[split]);
  if (values.signals) {
    console.log('\nSignals, dev queries only (rank = position of the gold section, - when absent)');
    console.log('  id    expect    rank conf    cov  cov1   unk   cos  prom   agr  margin  query');
    for (const row of rows.dev!) {
      const s = row.observation.signals!;
      const rank = row.query.expect === 'answer' ? goldRank(row.observation.hits, row.query.gold ?? []) : undefined;
      console.log(
        `  ${row.query.id}  ${row.query.expect.padEnd(9)} ${String(rank ?? '-').padStart(3)} ${row.observation.confidence.padEnd(7)} ${s.coverage.toFixed(2)}  ${s.coverageTop1.toFixed(2)}  ${s.unknownShare.toFixed(2)}  ${s.topCosine.toFixed(2)} ${s.cosineProminence.toFixed(1).padStart(5)}  ${s.agreement ? 'yes' : ' no'}  ${s.margin.toFixed(2)}   ${row.query.query}`,
      );
    }
  }
  if (values.failures) {
    console.log('\nProblems:');
    for (const split of Object.keys(rows)) for (const problem of failures(rows[split]!)) console.log(`  [${split}] ${problem.id}  ${problem.problem}  |  ${problem.query}`);
  }
}

if (variants.length > 1) {
  console.log('\n=== comparison (point estimates; see the per-split intervals above) ===');
  for (const split of Object.keys(splitOf)) {
    console.log(`\n${SPLIT_TITLES[split] ?? split}`);
    console.log(`  ${'variant'.padEnd(34)} r@1     r@3     r@4     MRR    falseAbs confWrong abstain ambig  p50ms`);
    for (const variant of variants) {
      const s = results[variant]![split]!;
      const cell = (value: number) => pct(value).padStart(7);
      console.log(
        `  ${variant.padEnd(34)} ${cell(s.answerable.recall1)} ${cell(s.answerable.recall3)} ${cell(s.answerable.recall4)} ${s.answerable.mrr.toFixed(3).padStart(6)} ${cell(s.answerable.falseAbstain)} ${cell(s.answerable.confidentWrong)} ${cell(s.abstain.recall)} ${cell(s.ambiguous.recall)} ${s.latency.p50.toFixed(1).padStart(6)}`,
      );
    }
  }
}

writeFileSync(
  resolve(here, 'last-run.json'),
  JSON.stringify({ chunks: stats.chunks, variants: results, failures: Object.fromEntries(variants.map((v) => [v, Object.fromEntries(Object.entries(allRows[v]!).map(([split, rows]) => [split, failures(rows)]))])) }, null, 2),
);
if (values['write-baseline']) {
  const first = variants[0]!;
  writeFileSync(baselinePath, JSON.stringify({ chunks: stats.chunks, variant: first, splits: results[first] }, null, 2) + '\n');
  console.log(`\nWrote eval/baseline.json from variant "${first}"`);
}
db.close();
