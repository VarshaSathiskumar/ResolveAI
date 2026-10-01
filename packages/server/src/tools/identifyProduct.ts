import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { identifyProduct } from '../products/identify.js';

const DESCRIPTION = [
  'Match what the user says about their product ("Brew Pro", "BP-200", "the pod one with the milk frother") to catalog products.',
  'Use it when the user names or describes a model, or when list_owned_products found nothing.',
  'Read `ambiguous` before choosing: when it is true several products fit about equally, so ask the user,',
  'using `suggested_question`, instead of picking one. When `candidates` is empty nothing matched: ask for the model.',
  'Products the user owns are flagged `owned` and listed first, but an ambiguous match stays ambiguous.',
  'The product_id of the chosen candidate is what search_troubleshooting and get_product take.',
].join('\n');

const outputSchema = z.object({
  ambiguous: z.boolean(),
  needs: z.array(z.string()),
  suggested_question: z.string().optional(),
  candidates: z.array(
    z.object({
      product_id: z.string(),
      brand: z.string(),
      model: z.string(),
      category: z.string(),
      score: z.number(),
      confidence: z.enum(['high', 'medium', 'low']),
      owned: z.boolean(),
      distinguishing: z.array(z.string()),
    }),
  ),
});

export function registerIdentifyProductTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'identify_product',
    {
      title: 'Identify a product from a description',
      description: DESCRIPTION,
      inputSchema: z.object({
        description: z.string().min(2).describe("The user's words for the product, exactly as they said it."),
        limit: z.number().int().min(1).max(5).optional().describe('Number of candidates, default 3.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ description, limit }) => {
      const owned = new Set(principal.userId ? deps.catalog.ownedBy(principal.userId).map((p) => p.productId) : []);
      const result = identifyProduct(description, deps.catalog.allProducts(), owned, limit);

      const output: z.infer<typeof outputSchema> = {
        ambiguous: result.ambiguous,
        needs: result.needs,
        ...(result.suggestedQuestion ? { suggested_question: result.suggestedQuestion } : {}),
        candidates: result.candidates.map((candidate) => ({
          product_id: candidate.productId,
          brand: candidate.brand,
          model: candidate.model,
          category: candidate.category,
          score: candidate.score,
          confidence: candidate.confidence,
          owned: candidate.owned,
          distinguishing: candidate.distinguishing,
        })),
      };

      const lines =
        result.candidates.length === 0
          ? ['No product matches that description. Ask the user for the model.']
          : [
              result.ambiguous ? 'Several products fit. Ask the user which one.' : 'Best match:',
              ...result.candidates.map(
                (c) => `- ${c.brand} ${c.model} (${c.productId}), ${c.confidence}${c.owned ? ', registered to the user' : ''}`,
              ),
              ...(result.suggestedQuestion ? ['', result.suggestedQuestion] : []),
            ];
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: output };
    },
  );
}
