import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { stem, words } from '../retrieval/text.js';
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

const synonymsFile = z.object({ groups: z.array(z.array(z.string())) });

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
  /** Groups of equivalent words, lower-case. Empty when the corpus has no synonyms.json. */
  synonyms: string[][];
}

/**
 * Checks synonym groups before they are stored. A bad entry fails the ingest rather than
 * quietly weakening retrieval:
 * - a group needs at least two words,
 * - a word may belong to only one group (otherwise its meaning is ambiguous),
 * - at least one word of each group must occur in the corpus, or the group can never help.
 */
export function validateSynonyms(groups: string[][], corpusStems: Set<string>): string[][] {
  const seen = new Map<string, { index: number; label: string }>();
  return groups.map((group, index) => {
    // One form per stem: FTS5 stems on its own, so "leak" and "leaking" would only repeat each other.
    const byStem = new Map<string, string>();
    for (const word of group.map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
      if (!byStem.has(stem(word))) byStem.set(stem(word), word);
    }
    const normalised = [...byStem.values()];
    const label = `[${normalised.join(', ')}]`;
    if (normalised.length < 2) throw new Error(`synonyms.json: group ${label} needs at least two words`);
    for (const word of normalised) {
      const key = stem(word);
      const other = seen.get(key);
      if (other && other.index !== index) {
        throw new Error(`synonyms.json: "${word}" is in both ${other.label} and ${label}`);
      }
      seen.set(key, { index, label });
    }
    if (!normalised.some((word) => corpusStems.has(stem(word)))) {
      throw new Error(`synonyms.json: no word in ${label} appears in the corpus, so it can never match`);
    }
    return normalised;
  });
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

  const synonymsPath = join(dir, 'synonyms.json');
  const corpusStems = new Set(
    products.flatMap(({ documents }) => documents.flatMap((document) => words(document.markdown).map(stem))),
  );
  const synonyms = existsSync(synonymsPath)
    ? validateSynonyms(synonymsFile.parse(JSON.parse(readFileSync(synonymsPath, 'utf8'))).groups, corpusStems)
    : [];
  return { products, demo, synonyms };
}
