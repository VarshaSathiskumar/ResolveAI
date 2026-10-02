import type { Db } from '../db/schema.js';
import type { DocType } from '../ingest/corpus.js';
import type { Embedder } from '../ingest/embed.js';
import calibrationFile from './calibration.json' with { type: 'json' };
import { competingProducts, productEvidence } from './productEvidence.js';
import { applyRerank, type Reranker } from './rerank.js';
import {
  assessSufficiency,
  assessSufficiencyV2,
  DEFAULT_THRESHOLDS,
  type CalibrationFile,
  type CalibrationModel,
  type Confidence,
  type Signals,
  type Thresholds,
} from './sufficiency.js';
import { createSynonymLookup } from './synonyms.js';
import { codeTerms, ftsAnyOf, queryTerms } from './text.js';

export interface SearchOptions {
  query: string;
  /** Restrict the search to one product's documents. */
  productId?: string;
  docTypes?: DocType[];
  /** Number of chunks to return. Defaults to 4. */
  limit?: number;
}

/**
 * Where a candidate came from, recorded when the candidate lists are fused. Ranks are 1-based within the scoped
 * lists and absent when the list did not contain the chunk. This is never recomputed after a later stage
 * (such as reranking) reorders the results, so signals built from it keep meaning "do the generators agree".
 */
export interface Provenance {
  keywordRank?: number;
  vectorRank?: number;
  exactRank?: number;
  /** Position by fused score, before any reranking. */
  rrfRank: number;
}

export interface SearchHit {
  chunkId: number;
  documentId: number;
  productId: string;
  productModel: string;
  docType: DocType;
  docTitle: string;
  page: number;
  section: string;
  text: string;
  /** Fused rank score after reranking. Only comparable within one search. */
  score: number;
  /** Cosine similarity between the query and this chunk. */
  cosine: number;
  /** Raw cross-encoder score, when a reranker scored this chunk. */
  rerankScore?: number;
  /** Ready to say aloud, for example "Brewwell Brew Pro 200 Troubleshooting Guide, page 2". */
  citation: string;
  provenance: Provenance;
}

export interface SearchResult {
  hits: SearchHit[];
  confidence: Confidence;
  /** Query terms that none of the top results mention. */
  gaps: string[];
  /** Gaps that appear nowhere in the whole corpus: the documentation never uses these words. */
  unknownTerms: string[];
  /** Terms the user used that the top results only cover through a synonym, for example jammed matched as clogged. */
  synonymMatches: { term: string; matched: string }[];
  suggestedRefinement?: string;
  /** Facts the caller must establish before searching again, for example "product_id". */
  needs: string[];
  /** Products with about equal evidence when the search could not tell which one the user means (empty otherwise). */
  competingProducts: { productId: string; model: string }[];
  /** Present when a reranker re-scored candidates for this search: which model, how many, and how long it took. */
  rerank?: { model: string; candidates: number; ms: number };
  /** The evidence the confidence was derived from, for evaluation and tracing. */
  signals: Signals;
}

interface Candidate {
  row: ChunkRow;
  /** Fused score after the document-type prior. */
  score: number;
  provenance: Provenance;
}

export interface Retriever {
  search(options: SearchOptions): Promise<SearchResult>;
  productExists(productId: string): boolean;
}

interface ChunkRow {
  chunk_id: number;
  document_id: number;
  product_id: string;
  product_model: string;
  doc_type: DocType;
  doc_title: string;
  page: number;
  section: string;
  text: string;
}

/** bm25 weights for the section, text and context columns of chunks_fts. */
const CONTENT_WEIGHTS = '1.0, 1.0, 0.5';
/** Restricts an FTS query to the chunk's own section and text, leaving out the title context column. */
const inContent = (query: string) => `{section text} : (${query})`;
const RRF_K = 60;
const FETCH = 200;
const TOP_FOR_SIGNALS = 3;
const WARRANTY_INTENT = /\b(warranty|guarantee|guaranteed|covered|coverage|claim|replacement|repair)\b/i;
const DOC_TYPE_PRIOR: Record<DocType, number> = { troubleshooting: 1.1, manual: 1, warranty: 0.9 };

/** Reciprocal rank fusion: each list contributes 1 / (k + rank) to every chunk it contains. */
function fuse(lists: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
  }
  return scores;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Hybrid retrieval over the ingested corpus: keyword (FTS5) and vector (sqlite-vec) candidates are
 * fused by reciprocal rank, an extra list rewards exact error codes, and a deterministic sufficiency
 * check turns the result into a confidence level with gaps and a suggested next step.
 *
 * Candidate lists are fetched wide and then scoped in memory, which is fine for a corpus of
 * thousands of chunks. Push the scope into SQL if the corpus grows far beyond that.
 */
export interface RetrieverOptions {
  db: Db;
  embedder: Embedder;
  thresholds?: Thresholds;
  /**
   * `v1` rates confidence with hand-set cosine and coverage thresholds. `v2` uses the model fitted on the labelled
   * eval set (calibration.json), with the query terms treated exactly as they were when it was fitted.
   */
  sufficiency?: 'v1' | 'v2';
  /**
   * Drop generic filler words ("getting", "barely") from query terms. Off for `v1`; for `v2` it follows how the fitted
   * model was trained, because the signals only mean the same thing under the same term rules. Settable to measure it alone.
   */
  fillerStopwords?: boolean;
  /** Overrides the fitted model, for tests and for the calibration script. */
  calibration?: CalibrationModel;
  /** With `sufficiency: 'v2'`, keep v1's rule that query words the documentation never uses cap or lower confidence (default true). */
  unknownGuard?: boolean;
  /**
   * `v1` asks which product only when a second product is within 90% of the top hit's score among the returned
   * hits. `v2` sums evidence per product over the top candidates and asks when the runner-up has at least
   * `ambiguityFraction` of the leader's evidence.
   */
  productAmbiguity?: 'v1' | 'v2';
  ambiguityFraction?: number;
  /** Re-scores the best fused candidates with a cross-encoder before results are returned. Off when absent. */
  reranker?: Reranker;
  /** How many fused candidates to re-score (default 10). */
  rerankTop?: number;
  /** 1 (default) orders them purely by the reranker; lower blends in the fused rank. */
  rerankWeight?: number;
  /**
   * Recall floor: the reranker may reorder and promote, but the fused top N always stay in the returned hits
   * (default 0, no floor). A reranker trained on web text can prefer long passages and push out a short correct one.
   */
  rerankKeep?: number;
  /** Give the reranker the document title as well as the section and text, the context the embedder also sees. */
  rerankContext?: boolean;
}

export function createRetriever(options: RetrieverOptions): Retriever {
  const { db, embedder, thresholds = DEFAULT_THRESHOLDS, sufficiency = 'v1', productAmbiguity = 'v1', ambiguityFraction = 0.75 } = options;
  const { reranker, rerankTop = 10, rerankWeight = 1, rerankKeep = 0, rerankContext = false } = options;
  // A calibration is only valid for the feature set it was fitted with, so the configuration picks the model.
  const fitted = calibrationFile as CalibrationFile;
  const calibration = options.calibration ?? (reranker ? fitted.rerank : fitted.rrf);
  const filler = options.fillerStopwords ?? (sufficiency === 'v2' && calibration?.fit?.fillerStopwords === true);
  if (sufficiency === 'v2' && !calibration) {
    throw new Error(`No calibration model for the ${reranker ? 'rerank' : 'rrf'} configuration. Run "npm run eval:calibrate" first.`);
  }

  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const indexed = hasMeta
    ? (db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as { value: string } | undefined)
    : undefined;
  if (!indexed) throw new Error('The database has no index. Run "npm run ingest" first.');
  if (indexed.value !== embedder.model) {
    throw new Error(`The index was built with ${indexed.value} but the server uses ${embedder.model}. Re-run ingestion.`);
  }

  const chunkRows = (ids: number[]): ChunkRow[] =>
    db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, d.product_id, p.model AS product_model, d.type AS doc_type,
                d.title AS doc_title, c.page, c.section, c.text
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN products p ON p.id = d.product_id
         WHERE c.id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
      )
      .all(...ids) as ChunkRow[];

  /**
   * Chunks matching any of the terms, best first. By default the product and document title column is
   * searched too, at a lower weight, which helps a query that names the model. Coverage and unknown-word
   * checks pass `contentOnly` so a word that only appears in a title never counts as covered.
   */
  const ftsRanked = (terms: string[], contentOnly = false): number[] =>
    terms.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, ${CONTENT_WEIGHTS}) LIMIT ?`,
            )
            .all(contentOnly ? inContent(ftsAnyOf(terms)) : ftsAnyOf(terms), FETCH) as { rowid: number }[]
        ).map((row) => row.rowid);

  /** Nearest chunks, best first, with the cosine similarity (vectors are unit length, so cosine = 1 - distance^2 / 2). */
  const nearest = (vector: Float32Array): { id: number; cosine: number }[] =>
    (
      db
        .prepare('SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
        .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), FETCH) as { rowid: number | bigint; distance: number }[]
    ).map((row) => ({ id: Number(row.rowid), cosine: 1 - (row.distance * row.distance) / 2 }));

  const storedVector = db.prepare('SELECT embedding FROM chunks_vec WHERE rowid = ?');
  const cosineTo = (query: Float32Array, chunkId: number): number => {
    const row = storedVector.get(BigInt(chunkId)) as { embedding: Buffer } | undefined;
    if (!row) return 0;
    const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    return dot(query, vector);
  };

  /** Whether any of the words occurs in one of the chunks. */
  const matchedWithin = (variants: string[], ids: number[]): boolean =>
    db
      .prepare(`SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
      .get(inContent(ftsAnyOf(variants)), ...ids) !== undefined;

  const synonyms = createSynonymLookup(db);

  const productRow = db.prepare('SELECT 1 FROM products WHERE id = ?');

  return {
    productExists: (productId) => productRow.get(productId) !== undefined,
    async search({ query, productId, docTypes, limit = 4 }) {
      const terms = queryTerms(query, { filler });
      const codes = codeTerms(query);
      // A term stands for itself plus its synonyms. Codes and model numbers are exact and never expanded.
      const variantsOf = (term: string): string[] => (codes.includes(term) ? [term] : synonyms.expand(term));

      const [queryVector] = await embedder.embed([query]);

      // Scope: the set of chunk ids the caller is allowed to see.
      const conditions: string[] = [];
      const params: string[] = [];
      if (productId) {
        conditions.push('d.product_id = ?');
        params.push(productId);
      }
      if (docTypes?.length) {
        conditions.push(`d.type IN (${docTypes.map(() => '?').join(',')})`);
        params.push(...docTypes);
      }
      const allowed = new Set(
        (
          db
            .prepare(
              `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id${
                conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
              }`,
            )
            .all(...params) as { id: number }[]
        ).map((row) => row.id),
      );
      const scoped = (ids: number[]) => ids.filter((id) => allowed.has(id));

      const keyword = scoped(ftsRanked([...new Set(terms.flatMap(variantsOf))]));
      const nearestAll = nearest(queryVector!).filter((entry) => allowed.has(entry.id));
      const semantic = nearestAll.map((entry) => entry.id);
      const exact = scoped(ftsRanked(codes, true));
      const fused = fuse([keyword, semantic, exact]);

      const warrantyIntent = WARRANTY_INTENT.test(query);
      const rows = new Map(chunkRows([...fused.keys()]).map((row) => [row.chunk_id, row]));
      const rankIn = (list: number[]) => new Map(list.map((id, index) => [id, index + 1]));
      const keywordRank = rankIn(keyword);
      const vectorRank = rankIn(semantic);
      const exactRank = rankIn(exact);

      // Stage 1: candidates, ranked by fused score, each carrying where it came from.
      const candidates: Candidate[] = [...fused.entries()]
        .map(([id, score]): Candidate => {
          const row = rows.get(id)!;
          const prior = row.doc_type === 'warranty' && warrantyIntent ? 1.3 : DOC_TYPE_PRIOR[row.doc_type];
          return {
            row,
            score: score * prior,
            provenance: { keywordRank: keywordRank.get(id), vectorRank: vectorRank.get(id), exactRank: exactRank.get(id), rrfRank: 0 },
          };
        })
        .sort((a, b) => b.score - a.score);
      candidates.forEach((candidate, index) => (candidate.provenance.rrfRank = index + 1));

      // Candidate-generation signals come from the fused order above and are final here.
      const first = candidates[0];
      const agreement = !!first && (first.provenance.keywordRank ?? Infinity) <= 2 && (first.provenance.vectorRank ?? Infinity) <= 2;
      const margin = first && candidates[1] ? (first.score - candidates[1].score) / first.score : 1;

      // Stage 2: the order that is returned. The fused order, unless a reranker re-scores the best candidates.
      // Provenance above stays as recorded: reranking changes the order, not where a candidate came from.
      let finalOrder = candidates;
      let rerankScores = new Map<number, number>();
      let rerankSignals: Pick<Signals, 'rerankTopMatchesRrfTop' | 'rerankMargin' | 'rerankTopScore'> = {};
      let rerankInfo: SearchResult['rerank'];
      if (reranker && candidates.length > 0) {
        try {
          const rescored = candidates.slice(0, rerankTop);
          const startedAt = performance.now();
          const raw = await reranker.score(
            query,
            rescored.map((candidate) => (rerankContext ? `${candidate.row.doc_title}. ` : '') + `${candidate.row.section}\n${candidate.row.text}`),
          );
          if (raw.length !== rescored.length) throw new Error('reranker returned the wrong number of scores');
          rerankInfo = { model: reranker.model, candidates: rescored.length, ms: performance.now() - startedAt };
          const reordered = applyRerank(raw, candidates.length, { top: rerankTop, weight: rerankWeight });
          finalOrder = reordered.order.map((index) => candidates[index]!);
          rerankScores = new Map(finalOrder.map((candidate, position) => [position, reordered.scores.get(reordered.order[position]!)] as const).filter((entry): entry is [number, number] => entry[1] !== undefined));
          const sorted = [...raw].sort((a, b) => b - a);
          rerankSignals = {
            rerankTopMatchesRrfTop: finalOrder[0]!.provenance.rrfRank <= 2,
            rerankMargin: sorted.length > 1 ? sorted[0]! - sorted[1]! : 0,
            rerankTopScore: rerankScores.get(0) ?? sorted[0]!,
          };
        } catch (error) {
          // A reranker failure must never fail a search: fall back to the fused order.
          console.warn(`reranker failed, using fused order: ${(error as Error).message}`);
        }
      }
      let ranked = finalOrder.slice(0, limit);
      if (rerankKeep > 0 && finalOrder !== candidates) {
        // Recall floor: bring back any of the fused top N that reranking pushed out, in place of the weakest others.
        const keep = candidates.slice(0, Math.min(rerankKeep, limit));
        const missing = keep.filter((candidate) => !ranked.includes(candidate));
        if (missing.length > 0) {
          const removable = ranked.filter((candidate) => !keep.includes(candidate)).slice(-missing.length);
          ranked = [...ranked.filter((candidate) => !removable.includes(candidate)), ...missing];
          // Their reranker scores no longer line up with positions, so drop them for this search.
          rerankScores = new Map();
        }
      }

      const hits: SearchHit[] = ranked.map(({ row, score, provenance }, position) => ({
        provenance,
        ...(rerankScores.has(position) ? { rerankScore: rerankScores.get(position) } : {}),
        chunkId: row.chunk_id,
        documentId: row.document_id,
        productId: row.product_id,
        productModel: row.product_model,
        docType: row.doc_type,
        docTitle: row.doc_title,
        page: row.page,
        section: row.section,
        text: row.text,
        score,
        cosine: cosineTo(queryVector!, row.chunk_id),
        citation: `${row.doc_title}, page ${row.page}`,
      }));

      const top = hits.slice(0, TOP_FOR_SIGNALS);
      const topIds = top.map((hit) => hit.chunkId);
      const matched = (term: string) => topIds.length > 0 && matchedWithin(variantsOf(term), topIds);
      const gaps = terms.filter((term) => !matched(term));
      // Unknown means no variant of the term appears anywhere in the corpus.
      const unknown = gaps.filter((term) => ftsRanked(variantsOf(term), true).length === 0);
      const codeMatched = codes.every(matched);
      const synonymMatches = terms.flatMap((term) => {
        if (gaps.includes(term) || topIds.length === 0 || matchedWithin([term], topIds)) return [];
        const via = variantsOf(term).find((variant) => matchedWithin([variant], topIds));
        return via ? [{ term, matched: via }] : [];
      });

      let competing: { productId: string; model: string }[] = [];
      let ambiguousProduct: boolean;
      if (productAmbiguity === 'v2') {
        // Product-level evidence over the pre-rerank candidates, not the handful of returned hits.
        const models = new Map(candidates.map((candidate) => [candidate.row.product_id, candidate.row.product_model]));
        competing = productId
          ? []
          : competingProducts(
              productEvidence(candidates.map((candidate) => ({ productId: candidate.row.product_id, score: candidate.score }))),
              ambiguityFraction,
            )
              .map((entry) => ({ productId: entry.productId, model: models.get(entry.productId)! }))
              // Alphabetical, so the wording of the question does not depend on tiny score differences.
              .sort((a, b) => a.model.localeCompare(b.model));
        ambiguousProduct = competing.length >= 2;
      } else {
        // The returned hits before any reranking, so a reordering cannot change whether the generators were torn.
        const fused = candidates.slice(0, limit);
        const otherProduct = fused.find((candidate) => candidate.row.product_id !== fused[0]?.row.product_id);
        ambiguousProduct = !productId && !!otherProduct && otherProduct.score >= 0.9 * fused[0]!.score;
      }

      // How much the best hit stands out from the whole vector ranking. Needs a few chunks to mean anything.
      const spread = nearestAll.map((entry) => entry.cosine);
      const spreadMean = spread.reduce((sum, value) => sum + value, 0) / (spread.length || 1);
      const spreadSd = Math.sqrt(spread.reduce((sum, value) => sum + (value - spreadMean) ** 2, 0) / (spread.length || 1));
      const topCosine = Math.max(0, ...top.map((hit) => hit.cosine));
      const cosineProminence = spread.length >= 3 && spreadSd > 1e-9 ? (topCosine - spreadMean) / spreadSd : 0;
      const topOneTerms = hits[0] ? terms.filter((term) => matchedWithin(variantsOf(term), [hits[0]!.chunkId])) : [];

      const signals: Signals = {
        hitCount: hits.length,
        coverage: terms.length === 0 ? 0 : (terms.length - gaps.length) / terms.length,
        codeRequested: codes.length > 0,
        codeMatched,
        topCosine,
        cosineProminence,
        coverageTop1: terms.length === 0 ? 0 : topOneTerms.length / terms.length,
        ambiguousProduct,
        unknownShare: terms.length === 0 ? 0 : unknown.length / terms.length,
        agreement,
        margin,
        ...rerankSignals,
      };
      // If a reranker was configured but failed on this search, its features are missing: use the plain model, else v1.
      const model = signals.rerankTopScore === undefined && reranker ? fitted.rrf : calibration;
      const confidence = sufficiency === 'v2' && model ? assessSufficiencyV2(signals, model, { unknownGuard: options.unknownGuard }) : assessSufficiency(signals, thresholds);
      const needs = ambiguousProduct ? ['product_id'] : [];

      return {
        hits,
        confidence,
        gaps,
        unknownTerms: unknown,
        synonymMatches,
        suggestedRefinement: refinement(confidence, gaps, unknown, codes, !!productId, needs, competing.map((entry) => entry.model)),
        competingProducts: competing,
        ...(rerankInfo ? { rerank: rerankInfo } : {}),
        needs,
        signals,
      };
    },
  };
}

function refinement(
  confidence: Confidence,
  gaps: string[],
  unknown: string[],
  codes: string[],
  scoped: boolean,
  needs: string[],
  competingModels: string[] = [],
): string | undefined {
  if (needs.includes('product_id') && competingModels.length >= 2) {
    const names = competingModels.length === 2 ? competingModels.join(' and ') : `${competingModels.slice(0, -1).join(', ')} and ${competingModels.at(-1)}`;
    return `The ${names} match about equally. Ask the user which one they have (list_owned_products, or ask for the model), then search again with product_id.`;
  }
  if (needs.includes('product_id')) {
    return 'Several products match about equally. Establish which product this is (list_owned_products or ask the user for the model), then search again with product_id.';
  }
  if (confidence === 'high') return undefined;
  const missingCodes = gaps.filter((gap) => codes.includes(gap));
  if (missingCodes.length > 0) {
    return `No documentation mentions ${missingCodes.map((code) => code.toUpperCase()).join(', ')}. Ask the user to read the code or light pattern again, or say it is not in their documentation.`;
  }
  const never = unknown.length > 0 ? ` The documentation never mentions: ${unknown.join(', ')}.` : '';
  if (confidence === 'medium') {
    const unmatched = unknown.length > 0 ? never : gaps.length > 0 ? ` Nothing mentions: ${gaps.join(', ')}.` : '';
    return `Partial match.${unmatched} Reword the query with the error code, light pattern or what the machine does, or ask the user one clarifying question.`;
  }
  return scoped
    ? `Nothing in this product's documentation matches.${never} Ask one diagnostic question (error code, lights, sounds) or tell the user it is not covered. Do not guess.`
    : `Nothing in the documentation matches.${never} Establish the product, ask one diagnostic question, or tell the user it is not covered. Do not guess.`;
}
