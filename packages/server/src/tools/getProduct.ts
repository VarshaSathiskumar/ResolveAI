import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../deps.js';

const DESCRIPTION = [
  'Get the catalog record for one product: specs, known issues, warranty term and its documents.',
  'Use it to check what a model has (for example whether it has a milk frother) before telling the user something about it.',
  'The documents are the ones search_troubleshooting searches; `pages` is the page count, for citations.',
  'Takes a product_id from list_owned_products or identify_product.',
].join('\n');

const outputSchema = z.object({
  product_id: z.string(),
  brand: z.string(),
  model: z.string(),
  aliases: z.array(z.string()),
  category: z.string(),
  specs: z.record(z.string(), z.unknown()),
  known_issues: z.array(z.string()),
  warranty_term_months: z.number(),
  documents: z.array(
    z.object({ document_id: z.number(), type: z.enum(['manual', 'troubleshooting', 'warranty']), title: z.string(), pages: z.number() }),
  ),
});

export function registerGetProductTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_product',
    {
      title: 'Get a product record',
      description: DESCRIPTION,
      inputSchema: z.object({ product_id: z.string().describe('A product_id such as brewwell-brew-pro-200.') }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ product_id }) => {
      const product = deps.catalog.getProduct(product_id);
      if (!product) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown product_id "${product_id}". Use list_owned_products or identify_product to find the right id.`,
            },
          ],
        };
      }
      const documents = deps.catalog.documentsFor(product.id);
      const output: z.infer<typeof outputSchema> = {
        product_id: product.id,
        brand: product.brand,
        model: product.model,
        aliases: product.aliases,
        category: product.category,
        specs: product.specs,
        known_issues: product.knownIssues,
        warranty_term_months: product.warrantyTermMonths,
        documents: documents.map((doc) => ({ document_id: doc.documentId, type: doc.type, title: doc.title, pages: doc.pages })),
      };
      const text = [
        `${product.brand} ${product.model} (${product.id}), ${product.category}`,
        `Specs: ${Object.entries(product.specs).map(([key, value]) => `${key.replace(/_/g, ' ')} ${String(value)}`).join(', ')}`,
        `Known issues: ${product.knownIssues.join(', ') || 'none recorded'}`,
        `Warranty: ${product.warrantyTermMonths} months`,
        `Documents: ${documents.map((doc) => `${doc.title} (${doc.pages} pages)`).join('; ')}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
