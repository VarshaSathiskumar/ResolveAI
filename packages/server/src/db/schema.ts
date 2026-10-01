import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type Db = Database.Database;

/** Opens the SQLite file (or ':memory:') with sqlite-vec loaded. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  return db;
}

/** Tables rebuilt on every ingestion run. Case tables are left alone so history survives re-ingest. */
const CATALOG_TABLES = [
  'chunks_vec',
  'chunks_fts',
  'chunks',
  'documents',
  'synonyms',
  'warranties',
  'owned_products',
  'products',
  'meta',
];

export function resetCatalog(db: Db): void {
  for (const table of CATALOG_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

export function applySchema(db: Db, embeddingDims: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      aliases TEXT NOT NULL,
      category TEXT NOT NULL,
      specs_json TEXT NOT NULL,
      known_issues TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owned_products (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      serial TEXT,
      purchase_date TEXT NOT NULL,
      retailer TEXT
    );

    CREATE TABLE IF NOT EXISTS warranties (
      id INTEGER PRIMARY KEY,
      product_id TEXT NOT NULL,
      term_months INTEGER NOT NULL,
      coverage_json TEXT NOT NULL,
      exclusions TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS synonyms (
      stem TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL,
      word TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      product_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('manual', 'troubleshooting', 'warranty')),
      title TEXT NOT NULL,
      source_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      page INTEGER NOT NULL,
      section TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      section, text, tokenize = 'porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${embeddingDims}]);

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      user_id TEXT,
      product_id TEXT,
      symptom TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS diagnostic_steps (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'step', 'outcome')),
      content TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS support_cases (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      steps_tried TEXT NOT NULL,
      warranty_status TEXT NOT NULL,
      ticket_ref TEXT NOT NULL
    );
  `);
}
