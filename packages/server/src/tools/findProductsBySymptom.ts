import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { queryTerms, stem, words } from '../retrieval/text.js';
import { errorResult } from './caseAccess.js';
import { MATCH_SHARE, NO_ACCOUNT } from '../../../../config.js';

const DESCRIPTION = [
  "Find which of the user's own products can have a symptom, by reading each product's troubleshooting guide.",
  'Use it when the user describes a problem without saying which product ("it is slow", "it keeps getting hot") and owns several kinds of product.',
  'A product matches only when its guide mentions the symptom, so a storage box is never slow and a towel never gets hot.',
  '`needs` is ["which_product"] when more than one product matches: ask which one, naming the products by kind, for example "your phone, your coffee machine or your laptop".',
  'The matches come in the order to work through them. If the user says all of them, take them one at a time in that order, and move to the next only when they ask.',
  'With exactly one match, use it without asking. With none, say plainly that none of their guides covers it.',
].join('\n');

const matchSchema = z.object({
  product_id: z.string(),
  brand: z.string(),
  model: z.string(),
  category: z.string(),
  section: z.string(),
  citation: z.string(),
  matched_terms: z.array(z.string()),
});

const outputSchema = z.object({
  symptom_terms: z.array(z.string()),
  checked: z.number(),
  matches: z.array(matchSchema),
  not_matching: z.array(z.object({ product_id: z.string(), model: z.string(), category: z.string() })),
  needs: z.array(z.string()),
});

/** The words in a guide page that say what goes wrong: its title, its opening paragraph and the symptom column of a table (causes and fixes are left out). */
function symptomWords(hit: { section: string; text: string }): Set<string> {
  const rows = hit.text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line));
  const intro = hit.text.split(/\n\s*\n/).find((block) => block.trim() !== '' && !/^[|#]/.test(block.trim())) ?? '';
  return new Set(words(`${hit.section} ${intro} ${rows.map((row) => row.split('|')[1] ?? '').join(' ')}`).map(stem));
}

export function registerFindProductsBySymptomTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'find_products_by_symptom',
    {
      title: 'Find which products can have a symptom',
      description: DESCRIPTION,
      inputSchema: z.object({ symptom: z.string().min(2).max(300).describe("The problem in the user's words, for example \"it is slow\".") }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ symptom }) => {
      if (!principal.userId) return errorResult(NO_ACCOUNT);
      const terms = queryTerms(symptom);
      // Most of the words must be on one page, so "the zip is stuck" is not matched by every guide that says "stuck".
      const needed = Math.max(1, Math.ceil(terms.length * MATCH_SHARE));
      // One entry per kind of product the user owns, in the order they were bought (newest first).
      const owned = deps.catalog.ownedBy(principal.userId).filter((product, index, all) => all.findIndex((other) => other.productId === product.productId) === index);

      const matches: z.infer<typeof matchSchema>[] = [];
      const notMatching: z.infer<typeof outputSchema>['not_matching'] = [];
      for (const product of owned) {
        const result = terms.length === 0 ? undefined : await deps.retriever.search({ query: symptom, productId: product.productId, docTypes: ['troubleshooting'], limit: 4 });
        const found = (result?.hits ?? [])
          .flatMap((hit) => {
            const present = symptomWords(hit);
            const matched = terms.filter((term) => present.has(stem(term)));
            return matched.length >= needed ? [{ hit, matched, titled: matched.some((term) => words(hit.section).map(stem).includes(stem(term))) }] : [];
          })
          // A page about the symptom beats a table that only lists it.
          .sort((a, b) => Number(b.titled) - Number(a.titled))[0];
        if (found) {
          matches.push({
            product_id: product.productId,
            brand: product.brand,
            model: product.model,
            category: product.category,
            section: found.hit.section,
            citation: found.hit.citation,
            matched_terms: found.matched,
          });
        } else {
          notMatching.push({ product_id: product.productId, model: product.model, category: product.category });
        }
      }

      const output: z.infer<typeof outputSchema> = {
        symptom_terms: terms,
        checked: owned.length,
        matches,
        not_matching: notMatching,
        needs: matches.length > 1 ? ['which_product'] : [],
      };
      const text =
        matches.length === 0
          ? `None of the ${owned.length} registered products has "${symptom}" in its troubleshooting guide.`
          : [
              `${matches.length} of ${owned.length} registered products can have this problem${matches.length > 1 ? ', ask which one' : ', use it without asking'}:`,
              ...matches.map((match) => `- ${match.category}: ${match.brand} ${match.model} (${match.product_id}), guide section "${match.section}"`),
            ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
