import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { stem, words } from '../retrieval/text.js';

const DESCRIPTION = [
  "List the products registered to the user's account.",
  'Use it first when the user refers to their own product ("my coffee machine") without naming a model.',
  '`resolution` tells you what to do next:',
  '- one: this is the product, use its product_id without asking.',
  '- several: ask the user which one (`needs` is ["which_product"]), naming the models.',
  '- none: ask the user for the model, or call identify_product with what they say (`needs` is ["model"]).',
  'Pass `category` (for example "coffee machine") to ignore other kinds of products.',
].join('\n');

const outputSchema = z.object({
  resolution: z.enum(['one', 'several', 'none']),
  needs: z.array(z.string()),
  note: z.string().optional(),
  owned: z.array(
    z.object({
      owned_id: z.number(),
      product_id: z.string(),
      brand: z.string(),
      model: z.string(),
      category: z.string(),
      serial: z.string().nullable(),
      purchase_date: z.string(),
      retailer: z.string().nullable(),
    }),
  ),
});

export function registerListOwnedProductsTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'list_owned_products',
    {
      title: 'List the products the user owns',
      description: DESCRIPTION,
      inputSchema: z.object({
        category: z.string().optional().describe('Only products of this kind, for example "coffee machine".'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ category }) => {
      const wanted = category ? words(category).map(stem) : [];
      const owned = principal.userId
        ? deps.catalog.ownedBy(principal.userId).filter((product) => {
            const kind = new Set(words(product.category).map(stem));
            return wanted.every((term) => kind.has(term));
          })
        : [];

      const resolution = owned.length === 1 ? 'one' : owned.length > 1 ? 'several' : 'none';
      const needs = resolution === 'several' ? ['which_product'] : resolution === 'none' ? ['model'] : [];
      const note = principal.userId ? undefined : 'No account is linked to this connection, so no products are registered.';

      const output: z.infer<typeof outputSchema> = {
        resolution,
        needs,
        ...(note ? { note } : {}),
        owned: owned.map((product) => ({
          owned_id: product.ownedId,
          product_id: product.productId,
          brand: product.brand,
          model: product.model,
          category: product.category,
          serial: product.serial,
          purchase_date: product.purchaseDate,
          retailer: product.retailer,
        })),
      };

      const lines =
        resolution === 'none'
          ? ['No registered products. Ask the user which model they have.']
          : owned.map((product) => `- ${product.brand} ${product.model} (${product.productId}), bought ${product.purchaseDate}`);
      const lead =
        resolution === 'one'
          ? 'One registered product, use it without asking:'
          : resolution === 'several'
            ? 'Several registered products, ask which one:'
            : '';
      return { content: [{ type: 'text', text: [lead, ...lines].filter(Boolean).join('\n') }], structuredContent: output };
    },
  );
}
