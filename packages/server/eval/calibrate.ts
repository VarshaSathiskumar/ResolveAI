import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/schema.js';
import { createTransformersEmbedder } from '../src/ingest/embed.js';
import { ingestCorpus } from '../src/ingest/ingest.js';
import { createRetriever } from '../src/retrieval/retriever.js';
import { createCrossEncoderReranker } from '../src/retrieval/rerank.js';
import { FEATURES, RERANK_FEATURES, featureVector, type CalibrationFile, type CalibrationModel } from '../src/retrieval/sufficiency.js';
import { chooseCutoffs, fitLogistic, leaveOneOut, logLoss, standardize, type Sample } from './calibration.js';
import { FRESH_PATH, LOCK_PATH, verifyLock } from './lock.js';
import { goldRank, PRODUCT_ALIASES, type EvalQuery } from './metrics.js';
import { assertTrainingSet, splitMain } from './splits.js';
import { variantOptions } from './variants.js';

/**
 * Fits the confidence model on the DEV split only, with leave-one-out validation, and writes
 * src/retrieval/calibration.json. Held-out and the frozen fresh set are never read for fitting.
 *   npm run eval:calibrate -w @resolveai/server [-- --dry]
 */
const here = dirname(fileURLToPath(import.meta.url));
const modelPath = resolve(here, '../src/retrieval/calibration.json');

const { values } = parseArgs({
  options: {
    dry: { type: 'boolean', default: false },
    config: { type: 'string', default: 'rrf' },
    filler: { type: 'string', default: 'off' },
    // The retrieval settings the model will run with, as an eval variant string, for example "ambiguity+rerank:keep=2,ctx=1".
    variant: { type: 'string', default: '' },
  },
});
if (values.filler !== 'on' && values.filler !== 'off') throw new Error('--filler must be on or off');
const filler = values.filler === 'on';
if (values.config !== 'rrf' && values.config !== 'rerank') throw new Error(`--config must be rrf or rerank, not "${values.config}"`);
const config = values.config;
const featureNames = config === 'rerank' ? RERANK_FEATURES : FEATURES;

const lock = verifyLock(FRESH_PATH, LOCK_PATH);
if (!lock.ok) throw new Error(`Refusing to calibrate: ${lock.reason}`);

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as EvalQuery[];
const main = read(resolve(here, 'queries.json'));
const { dev, heldout } = splitMain(main);
const splitIds = { dev: dev.map((q) => q.id), heldout: heldout.map((q) => q.id), fresh: lock.lock.ids };

const embedder = createTransformersEmbedder();
const db = openDb(':memory:');
await ingestCorpus({ corpusDir: resolve(here, '../../../corpus'), db, embedder });
// Signals do not depend on the sufficiency version. The term rules (filler words on or off) must match at runtime.
// Fitted under the same retrieval settings it will run with: the signals only mean the same thing under the same settings.
const retrievalSettings = variantOptions(values.variant || (config === 'rerank' ? 'rerank' : 'baseline'), createCrossEncoderReranker());
if (config === 'rerank' && !retrievalSettings.reranker) throw new Error('--config rerank needs a variant that includes rerank');
if (config === 'rrf' && retrievalSettings.reranker) throw new Error('--config rrf cannot be fitted with a reranker');
const retriever = createRetriever({ db, embedder, ...retrievalSettings, sufficiency: 'v1', fillerStopwords: filler });

interface Row {
  id: string;
  query: string;
  features: number[];
  y: number;
  unanswerable: boolean;
}
const rows: Row[] = [];
let ruledOut = 0;
for (const query of dev) {
  if (query.expect === 'ambiguous') continue; // ambiguity is decided by its own rule, not by this model
  const result = await retriever.search({
    query: query.query,
    productId: query.product ? PRODUCT_ALIASES[query.product] : undefined,
    limit: 4,
  });
  const s = result.signals;
  // Hard rules decide these before any score is used, so they carry no information for the fit.
  if (s.hitCount === 0 || (s.codeRequested && !s.codeMatched)) {
    ruledOut += 1;
    continue;
  }
  const found = query.expect === 'answer' && goldRank(result.hits.map((h) => ({ productId: h.productId, docType: h.docType, section: h.section })), query.gold ?? []) !== undefined;
  rows.push({ id: query.id, query: query.query, features: featureVector(s, featureNames), y: found ? 1 : 0, unanswerable: query.expect === 'abstain' });
}
assertTrainingSet(rows.map((row) => row.id), splitIds);

const X = rows.map((row) => row.features);
const y = rows.map((row) => row.y);
console.log(`Fitting on ${rows.length} dev queries (${y.filter((v) => v === 1).length} positive, ${rows.filter((r) => r.unanswerable).length} unanswerable, ${ruledOut} left to hard rules)`);

const grid = [0.03, 0.1, 0.3, 1, 3, 10];
const scored = grid.map((lambda) => ({ lambda, loss: logLoss(leaveOneOut(X, y, lambda), y) }));
const best = scored.reduce((a, b) => (b.loss < a.loss ? b : a));
console.log('Leave-one-out log-loss by regularisation:', scored.map((s) => `${s.lambda}: ${s.loss.toFixed(3)}`).join(' | '), `-> lambda ${best.lambda}`);

const looP = leaveOneOut(X, y, best.lambda);
// Never let abstaining get worse than the baseline allowed on dev.
const baselinePath = resolve(here, 'baseline.json');
const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { splits?: { dev?: { abstain: { n: number; recall: number } } } }) : undefined;
const baselineMisses = baseline?.splits?.dev ? Math.round((1 - baseline.splits.dev.abstain.recall) * baseline.splits.dev.abstain.n) : 0;
const samples: Sample[] = rows.map((row, i) => ({ p: looP[i]!, positive: row.y === 1, unanswerable: row.unanswerable }));
const cutoffs = chooseCutoffs(samples, baselineMisses);

const { mean, sd } = standardize(X);
const fit = fitLogistic(X.map((row) => row.map((v, j) => (v - mean[j]!) / sd[j]!)), y, best.lambda);
const model: CalibrationModel = {
  features: [...featureNames],
  mean,
  sd,
  weights: fit.weights,
  bias: fit.bias,
  cutoffs,
  fit: { config, split: 'dev', samples: rows.length, lambda: best.lambda, looLogLoss: Number(best.loss.toFixed(4)), baselineAbstainMissesAllowed: baselineMisses, fillerStopwords: filler, variant: values.variant || null },
};

console.log('\nWeights on standardised features (positive raises confidence):');
featureNames.forEach((name, j) => console.log(`  ${name.padEnd(13)} ${fit.weights[j]!.toFixed(3).padStart(7)}`));
console.log(`  bias          ${fit.bias.toFixed(3).padStart(7)}`);
console.log(`\nCutoffs: high >= ${cutoffs.high.toFixed(3)}, medium >= ${cutoffs.medium.toFixed(3)}`);

const level = (p: number) => (p >= cutoffs.high ? 'high' : p >= cutoffs.medium ? 'medium' : 'low');
const tally = (filter: (r: Row) => boolean) => {
  const counts = { high: 0, medium: 0, low: 0 };
  rows.forEach((row, i) => filter(row) && (counts[level(looP[i]!)] += 1));
  return `high ${counts.high}, medium ${counts.medium}, low ${counts.low}`;
};
console.log('Out-of-sample (leave-one-out) ratings on dev:');
console.log(`  answerable, gold returned : ${tally((r) => r.y === 1 && !r.unanswerable)}`);
console.log(`  answerable, gold missing  : ${tally((r) => r.y === 0 && !r.unanswerable)}`);
console.log(`  unanswerable              : ${tally((r) => r.unanswerable)}`);

if (values.dry) {
  console.log('\n--dry: nothing written.');
} else {
  const file = JSON.parse(readFileSync(modelPath, 'utf8')) as CalibrationFile;
  file[config] = { ...model, fit: { ...model.fit, fittedAt: new Date().toISOString() } };
  writeFileSync(modelPath, JSON.stringify(file, null, 2) + '\n');
  console.log(`\nWrote ${modelPath}`);
}
db.close();
