import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { documentTitle } from './chunk.js';

export const DOC_TYPES = ['manual', 'troubleshooting', 'warranty'] as const;
export type DocType = (typeof DOC_TYPES)[number];

const productFile = z.object({
  id: z.string().min(1),
  brand: z.string().min(1),
  model: z.string().min(1),
  aliases: z.array(z.string()),
  category: z.string().min(1),
  specs: z.record(z.string(), z.unknown()),
  known_issues: z.array(z.string()),
  warranty: z.object({
    term_months: z.number().int().positive(),
    coverage: z.array(z.string()),
    exclusions: z.array(z.string()),
  }),
});

const demoFile = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string(), note: z.string().optional() })),
  owned_products: z.array(
    z.object({
      user_id: z.string(),
      product_id: z.string(),
      serial: z.string().optional(),
      purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      retailer: z.string().optional(),
    }),
  ),
});

export type ProductFile = z.infer<typeof productFile>;
export type DemoFile = z.infer<typeof demoFile>;

export interface CorpusDocument {
  type: DocType;
  title: string;
  sourcePath: string;
  markdown: string;
}

export interface Corpus {
  products: { product: ProductFile; documents: CorpusDocument[] }[];
  demo: DemoFile;
}

/** Reads and validates a corpus directory: one folder per product plus demo.json. */
export function loadCorpus(dir: string): Corpus {
  if (!existsSync(dir)) throw new Error(`Corpus directory not found: ${dir}`);

  const products = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((folder) => {
      const product = productFile.parse(JSON.parse(readFileSync(join(dir, folder, 'product.json'), 'utf8')));
      if (product.id !== folder) {
        throw new Error(`Product id "${product.id}" does not match its folder "${folder}"`);
      }
      const documents = DOC_TYPES.flatMap((type): CorpusDocument[] => {
        const file = join(dir, folder, `${type}.md`);
        if (!existsSync(file)) return [];
        const markdown = readFileSync(file, 'utf8');
        return [{ type, title: documentTitle(markdown) ?? `${product.model} ${type}`, sourcePath: `${folder}/${type}.md`, markdown }];
      });
      return { product, documents };
    });

  const demo = demoFile.parse(JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8')));
  const ids = new Set(products.map(({ product }) => product.id));
  for (const owned of demo.owned_products) {
    if (!ids.has(owned.product_id)) throw new Error(`demo.json references unknown product "${owned.product_id}"`);
  }
  return { products, demo };
}
