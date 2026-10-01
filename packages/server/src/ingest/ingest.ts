import { applySchema, resetCatalog, type Db } from '../db/schema.js';
import { chunkMarkdown } from './chunk.js';
import { loadCorpus } from './corpus.js';
import type { Embedder } from './embed.js';

export interface IngestStats {
  products: number;
  documents: number;
  chunks: number;
  embeddingModel: string;
}

interface PendingChunk {
  productIndex: number;
  documentIndex: number;
  page: number;
  section: string;
  text: string;
  embeddingText: string;
}

/** Rebuilds the product catalog and document index from a corpus directory. */
export async function ingestCorpus(options: {
  corpusDir: string;
  db: Db;
  embedder: Embedder;
}): Promise<IngestStats> {
  const { corpusDir, db, embedder } = options;
  const corpus = loadCorpus(corpusDir);

  const pending: PendingChunk[] = [];
  corpus.products.forEach(({ product, documents }, productIndex) => {
    documents.forEach((document, documentIndex) => {
      for (const chunk of chunkMarkdown(document.markdown)) {
        pending.push({
          productIndex,
          documentIndex,
          ...chunk,
          embeddingText: `${product.brand} ${product.model} ${document.title}\n${chunk.section}\n${chunk.text}`,
        });
      }
    });
  });

  // Embed before touching the database so a failed model download leaves the old index intact.
  const vectors = await embedder.embed(pending.map((chunk) => chunk.embeddingText));

  const write = db.transaction(() => {
    resetCatalog(db);
    applySchema(db, embedder.dims);

    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    setMeta.run('embedding_model', embedder.model);
    setMeta.run('embedding_dims', String(embedder.dims));
    setMeta.run('ingested_at', new Date().toISOString());

    const insertProduct = db.prepare(
      'INSERT INTO products (id, brand, model, aliases, category, specs_json, known_issues) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertWarranty = db.prepare(
      'INSERT INTO warranties (product_id, term_months, coverage_json, exclusions) VALUES (?, ?, ?, ?)',
    );
    const insertDocument = db.prepare(
      'INSERT INTO documents (product_id, type, title, source_path) VALUES (?, ?, ?, ?)',
    );

    const documentIds = new Map<string, number>();
    corpus.products.forEach(({ product, documents }, productIndex) => {
      insertProduct.run(
        product.id,
        product.brand,
        product.model,
        JSON.stringify(product.aliases),
        product.category,
        JSON.stringify(product.specs),
        JSON.stringify(product.known_issues),
      );
      insertWarranty.run(
        product.id,
        product.warranty.term_months,
        JSON.stringify(product.warranty.coverage),
        JSON.stringify(product.warranty.exclusions),
      );
      documents.forEach((document, documentIndex) => {
        const { lastInsertRowid } = insertDocument.run(product.id, document.type, document.title, document.sourcePath);
        documentIds.set(`${productIndex}:${documentIndex}`, Number(lastInsertRowid));
      });
    });

    const insertChunk = db.prepare('INSERT INTO chunks (document_id, page, section, text) VALUES (?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, section, text) VALUES (?, ?, ?)');
    const insertVec = db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)');
    pending.forEach((chunk, index) => {
      const documentId = documentIds.get(`${chunk.productIndex}:${chunk.documentIndex}`)!;
      const { lastInsertRowid } = insertChunk.run(documentId, chunk.page, chunk.section, chunk.text);
      insertFts.run(lastInsertRowid, chunk.section, chunk.text);
      const vector = vectors[index]!;
      insertVec.run(BigInt(lastInsertRowid), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
    });

    const insertOwned = db.prepare(
      'INSERT INTO owned_products (user_id, product_id, serial, purchase_date, retailer) VALUES (?, ?, ?, ?, ?)',
    );
    for (const owned of corpus.demo.owned_products) {
      insertOwned.run(owned.user_id, owned.product_id, owned.serial ?? null, owned.purchase_date, owned.retailer ?? null);
    }
  });
  write();

  return {
    products: corpus.products.length,
    documents: corpus.products.reduce((sum, { documents }) => sum + documents.length, 0),
    chunks: pending.length,
    embeddingModel: embedder.model,
  };
}
