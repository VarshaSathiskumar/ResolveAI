import { resolve } from 'node:path';
import { openDb, type Db } from '../src/db/schema.js';
import type { Embedder } from '../src/ingest/embed.js';
import { createHashEmbedder } from '../src/ingest/embed.js';
import { ingestCorpus } from '../src/ingest/ingest.js';
import { createRetriever, type Retriever } from '../src/retrieval/retriever.js';
import type { Thresholds } from '../src/retrieval/sufficiency.js';

export const corpusDir = resolve(import.meta.dirname, '../../../corpus');

export interface TestDeps {
  db: Db;
  embedder: Embedder;
  retriever: Retriever;
}

/** An in-memory index of the real corpus. Uses the hash embedder unless one is given. */
export async function makeDeps(embedder: Embedder = createHashEmbedder(128), thresholds?: Thresholds): Promise<TestDeps> {
  const db = openDb(':memory:');
  await ingestCorpus({ corpusDir, db, embedder });
  return { db, embedder, retriever: createRetriever({ db, embedder, thresholds }) };
}
