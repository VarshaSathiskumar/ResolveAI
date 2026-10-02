import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/schema.js';
import { createHashEmbedder } from '../src/ingest/embed.js';
import { ingestCorpus, type IngestStats } from '../src/ingest/ingest.js';

const corpusDir = resolve(import.meta.dirname, '../../../corpus');
const embedder = createHashEmbedder(128);

let db: Db;
let stats: IngestStats;

beforeAll(async () => {
  db = openDb(':memory:');
  stats = await ingestCorpus({ corpusDir, db, embedder });
});

afterAll(() => db.close());

function ftsProducts(query: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.product_id AS product_id, d.type AS type
       FROM chunks_fts f
       JOIN chunks c ON c.id = f.rowid
       JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts)`,
    )
    .all(query) as { product_id: string; type: string }[];
  return rows.map((row) => `${row.product_id}:${row.type}`);
}

describe('ingestCorpus', () => {
  it('loads every product with manual, troubleshooting and warranty documents', () => {
    expect(stats.products).toBe(5);
    expect(stats.documents).toBe(15);
    expect(stats.chunks).toBeGreaterThan(40);
    const docs = db.prepare('SELECT product_id, COUNT(*) AS n FROM documents GROUP BY product_id').all() as { n: number }[];
    expect(docs.every((row) => row.n === 3)).toBe(true);
  });

  it('gives every chunk a page and a section, and one row in each index', () => {
    const bad = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE page < 1 OR section = '' OR text = ''").get() as { n: number };
    expect(bad.n).toBe(0);
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM chunks) AS chunks,
                (SELECT COUNT(*) FROM chunks_fts) AS fts,
                (SELECT COUNT(*) FROM chunks_vec) AS vec`,
      )
      .get() as { chunks: number; fts: number; vec: number };
    expect(counts.fts).toBe(counts.chunks);
    expect(counts.vec).toBe(counts.chunks);
  });

  it('seeds the demo owned products and warranty terms', () => {
    const owned = db.prepare('SELECT user_id, COUNT(*) AS n FROM owned_products GROUP BY user_id ORDER BY user_id').all();
    expect(owned).toEqual([
      { user_id: 'demo-alex', n: 1 },
      { user_id: 'demo-nate', n: 1 },
      { user_id: 'demo-raj', n: 2 },
    ]);
    const terms = db.prepare('SELECT product_id, term_months FROM warranties ORDER BY product_id').all();
    expect(terms).toContainEqual({ product_id: 'brewwell-dripmate-12', term_months: 12 });
    expect(terms).toContainEqual({ product_id: 'brewwell-brew-pro-200', term_months: 24 });
  });

  it('records the embedding model used', () => {
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as { value: string };
    expect(meta.value).toBe('hash-128');
  });

  it('is repeatable: ingesting again does not duplicate rows', async () => {
    const again = await ingestCorpus({ corpusDir, db, embedder });
    expect(again.chunks).toBe(stats.chunks);
    const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    expect(row.n).toBe(stats.chunks);
  });
});

describe('planted failure paths are findable by keyword', () => {
  it('clogged piercing needle leads to the Brew Pro 200 troubleshooting guide', () => {
    expect(ftsProducts('needle AND clogged')[0]).toBe('brewwell-brew-pro-200:troubleshooting');
  });

  it('error E04 leads to the Brew Pro 300 seal section', () => {
    expect(ftsProducts('e04')[0]?.startsWith('brewwell-brew-pro-300')).toBe(true);
  });

  it('pump airlock leads to the Espresso Studio ES-1', () => {
    expect(ftsProducts('airlock')[0]?.startsWith('brewwell-espresso-studio-es1')).toBe(true);
  });

  it('stemming matches brewing and brew', () => {
    expect(ftsProducts('brewing').length).toBeGreaterThan(0);
  });
});

describe('vector index', () => {
  it('returns the nearest chunk for a query embedded with the same model', async () => {
    const [vector] = await embedder.embed(['piercing needle blocked by coffee grounds clean with needle tool']);
    const rows = db
      .prepare(
        `SELECT c.section AS section, d.product_id AS product_id
         FROM chunks_vec v
         JOIN chunks c ON c.id = v.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE v.embedding MATCH ? AND k = 3
         ORDER BY v.distance`,
      )
      .all(Buffer.from(vector!.buffer)) as { section: string; product_id: string }[];
    expect(rows[0]?.product_id).toBe('brewwell-brew-pro-200');
    expect(rows[0]?.section).toMatch(/needle/i);
  });
});
