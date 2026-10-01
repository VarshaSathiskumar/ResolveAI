import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../db/schema.js';
import { createHashEmbedder, createTransformersEmbedder } from './embed.js';
import { ingestCorpus } from './ingest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const { values } = parseArgs({
  options: {
    corpus: { type: 'string', default: resolve(repoRoot, 'corpus') },
    db: { type: 'string', default: process.env.RESOLVEAI_DB ?? resolve(repoRoot, 'data/resolveai.db') },
    embedder: { type: 'string', default: 'transformers' },
  },
});

if (values.embedder !== 'transformers' && values.embedder !== 'hash') {
  console.error(`Unknown --embedder "${values.embedder}". Use "transformers" or "hash".`);
  process.exit(1);
}

mkdirSync(dirname(values.db), { recursive: true });
const db = openDb(values.db);
const embedder = values.embedder === 'hash' ? createHashEmbedder() : createTransformersEmbedder();

console.log(`Ingesting ${values.corpus} into ${values.db} with ${embedder.model} ...`);
const stats = await ingestCorpus({ corpusDir: values.corpus, db, embedder });
console.log(
  `Done: ${stats.products} products, ${stats.documents} documents, ${stats.chunks} chunks (${stats.embeddingModel}).`,
);
db.close();
