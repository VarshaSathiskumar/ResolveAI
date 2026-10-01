import type { Db } from '../db/schema.js';
import type { DocType } from '../ingest/corpus.js';

export interface Product {
  id: string;
  brand: string;
  model: string;
  aliases: string[];
  category: string;
  specs: Record<string, unknown>;
  knownIssues: string[];
  warrantyTermMonths: number;
  warrantyCoverage: string[];
  warrantyExclusions: string[];
}

export interface OwnedProduct {
  ownedId: number;
  productId: string;
  brand: string;
  model: string;
  category: string;
  serial: string | null;
  purchaseDate: string;
  retailer: string | null;
}

export interface ProductDocument {
  documentId: number;
  type: DocType;
  title: string;
  /** Highest page number in the document. */
  pages: number;
}

export interface DocumentInfo {
  documentId: number;
  productId: string;
  productModel: string;
  type: DocType;
  title: string;
  pages: number;
}

export interface PageChunk {
  page: number;
  section: string;
  text: string;
}

export interface Catalog {
  allProducts(): Product[];
  getProduct(id: string): Product | undefined;
  documentsFor(productId: string): ProductDocument[];
  ownedBy(userId: string): OwnedProduct[];
  getDocument(documentId: number): DocumentInfo | undefined;
  /** The chunks on the given pages of a document, in reading order. */
  chunksOnPages(documentId: number, pages: number[]): PageChunk[];
}

interface ProductRow {
  id: string;
  brand: string;
  model: string;
  aliases: string;
  category: string;
  specs_json: string;
  known_issues: string;
  term_months: number;
  coverage_json: string;
  exclusions: string;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    aliases: JSON.parse(row.aliases) as string[],
    category: row.category,
    specs: JSON.parse(row.specs_json) as Record<string, unknown>,
    knownIssues: JSON.parse(row.known_issues) as string[],
    warrantyTermMonths: row.term_months,
    warrantyCoverage: JSON.parse(row.coverage_json) as string[],
    warrantyExclusions: JSON.parse(row.exclusions) as string[],
  };
}

const PRODUCT_SELECT = `SELECT p.id, p.brand, p.model, p.aliases, p.category, p.specs_json, p.known_issues,
                               w.term_months, w.coverage_json, w.exclusions
                        FROM products p JOIN warranties w ON w.product_id = p.id`;

/** Read-only queries over the products, documents and owned_products tables. */
export function createCatalog(db: Db): Catalog {
  return {
    allProducts: () => (db.prepare(`${PRODUCT_SELECT} ORDER BY p.id`).all() as ProductRow[]).map(toProduct),

    getProduct(id) {
      const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as ProductRow | undefined;
      return row ? toProduct(row) : undefined;
    },

    documentsFor: (productId) =>
      (
        db
          .prepare(
            `SELECT d.id AS document_id, d.type, d.title, COALESCE(MAX(c.page), 0) AS pages
             FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
             WHERE d.product_id = ?
             GROUP BY d.id ORDER BY d.id`,
          )
          .all(productId) as { document_id: number; type: DocType; title: string; pages: number }[]
      ).map((row) => ({ documentId: row.document_id, type: row.type, title: row.title, pages: row.pages })),

    getDocument(documentId) {
      const row = db
        .prepare(
          `SELECT d.id AS document_id, d.product_id, p.model AS product_model, d.type, d.title,
                  COALESCE((SELECT MAX(page) FROM chunks WHERE document_id = d.id), 0) AS pages
           FROM documents d JOIN products p ON p.id = d.product_id WHERE d.id = ?`,
        )
        .get(documentId) as
        | { document_id: number; product_id: string; product_model: string; type: DocType; title: string; pages: number }
        | undefined;
      return row
        ? { documentId: row.document_id, productId: row.product_id, productModel: row.product_model, type: row.type, title: row.title, pages: row.pages }
        : undefined;
    },

    chunksOnPages: (documentId, pages) =>
      pages.length === 0
        ? []
        : (db
            .prepare(
              `SELECT page, section, text FROM chunks
               WHERE document_id = ? AND page IN (${pages.map(() => '?').join(',')})
               ORDER BY page, id`,
            )
            .all(documentId, ...pages) as PageChunk[]),

    ownedBy: (userId) =>
      (
        db
          .prepare(
            `SELECT o.id AS owned_id, o.product_id, p.brand, p.model, p.category, o.serial, o.purchase_date, o.retailer
             FROM owned_products o JOIN products p ON p.id = o.product_id
             WHERE o.user_id = ? ORDER BY o.purchase_date DESC, o.id`,
          )
          .all(userId) as {
          owned_id: number;
          product_id: string;
          brand: string;
          model: string;
          category: string;
          serial: string | null;
          purchase_date: string;
          retailer: string | null;
        }[]
      ).map((row) => ({
        ownedId: row.owned_id,
        productId: row.product_id,
        brand: row.brand,
        model: row.model,
        category: row.category,
        serial: row.serial,
        purchaseDate: row.purchase_date,
        retailer: row.retailer,
      })),
  };
}
