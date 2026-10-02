import { resolve } from 'node:path';
import { openDb, type Db } from '../src/db/schema.js';
import type { Embedder } from '../src/ingest/embed.js';
import { createHashEmbedder } from '../src/ingest/embed.js';
import { ingestCorpus } from '../src/ingest/ingest.js';
import { createCaseStore, type CaseStore } from '../src/cases/store.js';
import { createCatalog, type Catalog } from '../src/products/catalog.js';
import { createRetriever, type Retriever } from '../src/retrieval/retriever.js';
import type { Thresholds } from '../src/retrieval/sufficiency.js';

export const corpusDir = resolve(import.meta.dirname, '../../../corpus');

export interface TestDeps {
  db: Db;
  embedder: Embedder;
  retriever: Retriever;
  catalog: Catalog;
  cases: CaseStore;
  now: () => Date;
}

/** An in-memory index of the real corpus. Uses the hash embedder unless one is given. */
/** Fixed so warranty results do not drift: Alex's Brew Pro 200 is in warranty. */
export const TEST_NOW = new Date('2026-10-01T12:00:00Z');

export async function makeDeps(
  embedder: Embedder = createHashEmbedder(128),
  thresholds?: Thresholds,
  now: () => Date = () => TEST_NOW,
): Promise<TestDeps> {
  const db = openDb(':memory:');
  await ingestCorpus({ corpusDir, db, embedder });
  return {
    db,
    embedder,
    retriever: createRetriever({ db, embedder, thresholds }),
    catalog: createCatalog(db),
    cases: createCaseStore(db, now),
    now,
  };
}
