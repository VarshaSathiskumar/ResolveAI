export interface Embedder {
  /** Identifier stored with the index so a model change is detected. */
  model: string;
  dims: number;
  /** Returns one L2-normalised vector per input text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

const MINILM = 'Xenova/all-MiniLM-L6-v2';

/** Local sentence embeddings via transformers.js. The model downloads on first use and is cached. */
export function createTransformersEmbedder(model = MINILM): Embedder {
  let extractor: Promise<(texts: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>> | undefined;

  const load = () => {
    extractor ??= import('@huggingface/transformers').then(
      async ({ pipeline }) =>
        (await pipeline('feature-extraction', model, { dtype: 'fp32' })) as unknown as NonNullable<
          Awaited<typeof extractor>
        >,
    );
    return extractor;
  };

  return {
    model,
    dims: 384,
    async embed(texts) {
      const run = await load();
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16);
        const out = await run(batch, { pooling: 'mean', normalize: true });
        const dims = out.dims[1]!;
        for (let row = 0; row < batch.length; row++) {
          vectors.push(out.data.slice(row * dims, (row + 1) * dims));
        }
      }
      return vectors;
    },
  };
}

/**
 * Deterministic bag-of-words hashing embedder. No download and no model, so it is fast and
 * reproducible for tests and offline development. Not semantic: similar words only match when equal.
 */
export function createHashEmbedder(dims = 128): Embedder {
  return {
    model: `hash-${dims}`,
    dims,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(dims);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let hash = 2166136261;
          for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
          vector[(hash >>> 0) % dims]! += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
      });
    },
  };
}
