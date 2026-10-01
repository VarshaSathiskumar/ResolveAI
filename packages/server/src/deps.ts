import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import { openDb } from './db/schema.js';
import { createHashEmbedder, createTransformersEmbedder } from './ingest/embed.js';
import { createRetriever, type Retriever } from './retrieval/retriever.js';

/** Everything the MCP tools need. Built once and shared by every session. */
export interface ServerDeps {
  retriever: Retriever;
}

/** Opens the index and loads the embedding model, so the first search is not slow. */
export async function createDeps(config: Config): Promise<ServerDeps & { close(): void }> {
  if (!existsSync(config.dbPath)) {
    throw new Error(`No database at ${config.dbPath}. Run "npm run ingest" first.`);
  }
  const db = openDb(config.dbPath);
  const embedder = config.embedder === 'hash' ? createHashEmbedder() : createTransformersEmbedder();
  const retriever = createRetriever({ db, embedder });
  await embedder.embed(['warm up']);
  return { retriever, close: () => db.close() };
}
