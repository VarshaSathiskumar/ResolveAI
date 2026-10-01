import type { Db } from '../db/schema.js';
import type { DocType } from '../ingest/corpus.js';
import type { Embedder } from '../ingest/embed.js';
import { assessSufficiency, DEFAULT_THRESHOLDS, type Confidence, type Signals, type Thresholds } from './sufficiency.js';
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
  /** Ready to say aloud, for example "Brewwell Brew Pro 200 Troubleshooting Guide, page 2". */
  citation: string;
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
export function createRetriever(options: {
  db: Db;
  embedder: Embedder;
  thresholds?: Thresholds;
}): Retriever {
  const { db, embedder, thresholds = DEFAULT_THRESHOLDS } = options;

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

  const ftsRanked = (terms: string[]): number[] =>
    terms.length === 0
      ? []
      : (
          db
            .prepare('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?')
            .all(ftsAnyOf(terms), FETCH) as { rowid: number }[]
        ).map((row) => row.rowid);

  const nearest = (vector: Float32Array): number[] =>
    (
      db
        .prepare('SELECT rowid FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
        .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), FETCH) as { rowid: number | bigint }[]
    ).map((row) => Number(row.rowid));

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
      .get(ftsAnyOf(variants), ...ids) !== undefined;

  const synonyms = createSynonymLookup(db);

  const productRow = db.prepare('SELECT 1 FROM products WHERE id = ?');

  return {
    productExists: (productId) => productRow.get(productId) !== undefined,
    async search({ query, productId, docTypes, limit = 4 }) {
      const terms = queryTerms(query);
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
      const semantic = scoped(nearest(queryVector!));
      const exact = scoped(ftsRanked(codes));
      const fused = fuse([keyword, semantic, exact]);

      const warrantyIntent = WARRANTY_INTENT.test(query);
      const rows = new Map(chunkRows([...fused.keys()]).map((row) => [row.chunk_id, row]));
      const ranked = [...fused.entries()]
        .map(([id, score]) => {
          const row = rows.get(id)!;
          const prior = row.doc_type === 'warranty' && warrantyIntent ? 1.3 : DOC_TYPE_PRIOR[row.doc_type];
          return { row, score: score * prior };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const hits: SearchHit[] = ranked.map(({ row, score }) => ({
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
      const unknown = gaps.filter((term) => ftsRanked(variantsOf(term)).length === 0);
      const codeMatched = codes.every(matched);
      const synonymMatches = terms.flatMap((term) => {
        if (gaps.includes(term) || topIds.length === 0 || matchedWithin([term], topIds)) return [];
        const via = variantsOf(term).find((variant) => matchedWithin([variant], topIds));
        return via ? [{ term, matched: via }] : [];
      });

      const otherProduct = hits.find((hit) => hit.productId !== hits[0]?.productId);
      const ambiguousProduct = !productId && !!otherProduct && otherProduct.score >= 0.9 * hits[0]!.score;

      const signals: Signals = {
        hitCount: hits.length,
        coverage: terms.length === 0 ? 0 : (terms.length - gaps.length) / terms.length,
        codeRequested: codes.length > 0,
        codeMatched,
        topCosine: Math.max(0, ...top.map((hit) => hit.cosine)),
        ambiguousProduct,
        unknownShare: terms.length === 0 ? 0 : unknown.length / terms.length,
      };
      const confidence = assessSufficiency(signals, thresholds);
      const needs = ambiguousProduct ? ['product_id'] : [];

      return {
        hits,
        confidence,
        gaps,
        unknownTerms: unknown,
        synonymMatches,
        suggestedRefinement: refinement(confidence, gaps, unknown, codes, !!productId, needs),
        needs,
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
): string | undefined {
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
