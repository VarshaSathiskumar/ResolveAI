import { RERANKER_MODEL, RERANK_BLEND_K } from '../../../../config.js';
/**
 * A reranker re-scores a few candidate passages against the query, jointly, which is more accurate than comparing
 * independently computed embeddings but too slow to run over the whole corpus. It only reorders candidates the
 * generators already found, so it can lift the right passage to the top but cannot find a new one.
 */
export interface Reranker {
  /** Identifier, reported with results and used to pick the matching calibration. */
  model: string;
  /** One relevance score per passage, in the same order. Higher is more relevant; only the order is meaningful across calls. */
  score(query: string, passages: string[]): Promise<number[]>;
}

/** A small cross-encoder (MS MARCO MiniLM) run locally with transformers.js. Downloads once, then cached. */
export function createCrossEncoderReranker(model = RERANKER_MODEL): Reranker {
  type Loaded = {
    tokenizer: (queries: string[], options: object) => unknown;
    model: (inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>;
  };
  let loaded: Promise<Loaded> | undefined;

  const load = () => {
    loaded ??= import('@huggingface/transformers').then(async ({ AutoTokenizer, AutoModelForSequenceClassification }) => ({
      tokenizer: (await AutoTokenizer.from_pretrained(model)) as unknown as Loaded['tokenizer'],
      model: (await AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'fp32' })) as unknown as Loaded['model'],
    }));
    return loaded;
  };

  return {
    model,
    async score(query, passages) {
      if (passages.length === 0) return [];
      const { tokenizer, model: network } = await load();
      const inputs = tokenizer(new Array<string>(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const { logits } = await network(inputs);
      return Array.from(logits.data as ArrayLike<number>).slice(0, passages.length);
    },
  };
}

/**
 * Deterministic stand-in for tests and offline runs: scores a passage by how many distinct query words it contains.
 * It is not a relevance model, just something that reorders predictably.
 */
export function createOverlapReranker(): Reranker {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return {
    model: 'overlap-test',
    async score(query, passages) {
      const wanted = words(query);
      return passages.map((passage) => {
        const have = words(passage);
        return [...wanted].filter((word) => have.has(word)).length;
      });
    },
  };
}

export interface RerankOptions {
  /** How many of the best fused candidates to re-score. */
  top: number;
  /**
   * 1 orders the re-scored candidates purely by the reranker. Lower values blend its rank with the fused rank,
   * (weight on reranker rank, rest on fused rank), to keep the generators' opinion when the reranker is unsure.
   */
  weight: number;
}

export interface Reranked {
  /** Indices into the input candidates, best first. The same length as the input. */
  order: number[];
  /** Raw reranker score per input candidate that was re-scored, by input index; absent for the untouched tail. */
  scores: Map<number, number>;
}

/**
 * Reorders the first `top` candidates by reranker score (optionally blended with their fused rank) and leaves the
 * rest in their original order after them. `candidates` must already be in fused order. Pure given the scores.
 */
export function applyRerank(scoresInOrder: number[], total: number, options: RerankOptions): Reranked {
  const count = Math.min(scoresInOrder.length, total);
  const scores = new Map<number, number>(scoresInOrder.slice(0, count).map((score, index) => [index, score]));
  // Rank by reranker score; ties keep the fused order (stable sort).
  const byRerank = [...Array(count).keys()].sort((a, b) => scoresInOrder[b]! - scoresInOrder[a]! || a - b);
  const rerankRank = new Map(byRerank.map((index, rank) => [index, rank + 1]));

  const blended = [...Array(count).keys()]
    .map((index) => ({
      index,
      value: options.weight / (RERANK_BLEND_K + rerankRank.get(index)!) + (1 - options.weight) / (RERANK_BLEND_K + index + 1),
    }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.index);

  const tail = Array.from({ length: Math.max(0, total - count) }, (_, offset) => count + offset);
  return { order: [...blended, ...tail], scores };
}
