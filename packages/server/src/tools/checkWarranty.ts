import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { lookupWarranty } from '../support/lookup.js';

const DESCRIPTION = [
  'Check whether the user\'s product is still under warranty, and what the warranty covers.',
  'Use it when troubleshooting has not fixed the problem, before offering a support case, or when the user asks about coverage.',
  'It uses the purchase date registered to the user\'s account. If the product is not registered, `needs` is ["purchase_date"]:',
  'ask the user when they bought it and call again with `purchase_date` (YYYY-MM-DD).',
  '`status` is in_warranty, expired or unknown. `covered` and `not_covered` are the warranty terms, so check a likely fault against them',
  'rather than promising a repair. Say plainly when the warranty has expired.',
].join('\n');

const outputSchema = z.object({
  product_id: z.string(),
  model: z.string(),
  status: z.enum(['in_warranty', 'expired', 'unknown']),
  purchase_date_source: z.enum(['registered', 'user_provided', 'unknown']),
  purchase_date: z.string().optional(),
  term_months: z.number(),
  end_date: z.string().optional(),
  days_remaining: z.number().optional(),
  days_since_expiry: z.number().optional(),
  covered: z.array(z.string()),
  not_covered: z.array(z.string()),
  needs: z.array(z.string()),
  guidance: z.string(),
});

export function registerCheckWarrantyTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'check_warranty',
    {
      title: 'Check warranty coverage',
      description: DESCRIPTION,
      inputSchema: z.object({
        product_id: z.string().describe('A product_id from list_owned_products or identify_product.'),
        purchase_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('Only when the product is not registered to the user: the date they say they bought it.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ product_id, purchase_date }) => {
      const lookup = lookupWarranty(deps, principal.userId, product_id, purchase_date);
      if (!lookup) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `Unknown product_id "${product_id}". Use list_owned_products or identify_product to find the right id.` },
          ],
        };
      }
      const { product, assessment } = lookup;
      const unknown = assessment.status === 'unknown';
      const needs = unknown ? ['purchase_date'] : [];

      const guidance = {
        in_warranty: `Covered until ${assessment.endDate} (${assessment.daysRemaining} days left). A fault in the covered parts is eligible for repair or replacement: create a support case if troubleshooting has failed.`,
        expired: `The warranty ended on ${assessment.endDate} (${assessment.daysSinceExpiry} days ago), so a repair would not be covered. A support case can still be created.`,
        unknown: `${assessment.reason} Ask the user when they bought it and call again with purchase_date.`,
      }[assessment.status];

      const output: z.infer<typeof outputSchema> = {
        product_id: product.id,
        model: product.model,
        status: assessment.status,
        purchase_date_source: lookup.source,
        ...(lookup.purchaseDate ? { purchase_date: lookup.purchaseDate } : {}),
        term_months: product.warrantyTermMonths,
        ...(assessment.endDate ? { end_date: assessment.endDate } : {}),
        ...(assessment.daysRemaining !== undefined ? { days_remaining: assessment.daysRemaining } : {}),
        ...(assessment.daysSinceExpiry !== undefined ? { days_since_expiry: assessment.daysSinceExpiry } : {}),
        covered: product.warrantyCoverage,
        not_covered: product.warrantyExclusions,
        needs,
        guidance,
      };
      const text = [
        `${product.model}: ${assessment.status.replace('_', ' ')}. ${guidance}`,
        `Covered: ${product.warrantyCoverage.join(', ')}.`,
        `Not covered: ${product.warrantyExclusions.join(', ')}.`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
