import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { findCase } from './caseAccess.js';

const DESCRIPTION = [
  'Read the current troubleshooting case: what the user reported and everything asked, answered and tried so far.',
  'Use it before giving a fix, so you do not repeat a step the user already tried, and before creating a support case.',
  'Leave out `case_id` to get the user\'s most recent open case.',
  'When there is no case yet, `case` is null and `needs` is ["case"]: start one with record_diagnostic_step.',
  '`needs` also lists product_id or symptom when the case is missing them.',
].join('\n');

const stepSchema = z.object({
  step_id: z.number(),
  kind: z.enum(['question', 'answer', 'step', 'outcome']),
  content: z.string(),
  ts: z.string(),
});

const outputSchema = z.object({
  case: z
    .object({
      case_id: z.number(),
      status: z.enum(['open', 'resolved', 'escalated']),
      product_id: z.string().nullable(),
      product_model: z.string().nullable(),
      symptom: z.string().nullable(),
      created_at: z.string(),
    })
    .nullable(),
  steps: z.array(stepSchema),
  steps_tried: z.array(z.string()),
  support_case: z.object({ ticket_ref: z.string(), summary: z.string() }).nullable(),
  needs: z.array(z.string()),
});

export function registerGetCaseStateTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'get_case_state',
    {
      title: 'Get the troubleshooting case',
      description: DESCRIPTION,
      inputSchema: z.object({
        case_id: z.number().int().positive().optional().describe("A case_id from record_diagnostic_step. Leave out for the user's latest open case."),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ case_id }) => {
      const found = findCase(deps, principal, case_id);
      if (found.error) return found.error;

      const current = found.case;
      if (!current) {
        const output: z.infer<typeof outputSchema> = { case: null, steps: [], steps_tried: [], support_case: null, needs: ['case'] };
        return {
          content: [{ type: 'text', text: 'No open case. Start one with record_diagnostic_step once you know the symptom.' }],
          structuredContent: output,
        };
      }

      const steps = deps.cases.steps(current.id);
      const support = deps.cases.supportCaseFor(current.id);
      const product = current.productId ? deps.catalog.getProduct(current.productId) : undefined;
      const needs = [...(current.productId ? [] : ['product_id']), ...(current.symptom ? [] : ['symptom'])];

      const output: z.infer<typeof outputSchema> = {
        case: {
          case_id: current.id,
          status: current.status,
          product_id: current.productId,
          product_model: product?.model ?? null,
          symptom: current.symptom,
          created_at: current.createdAt,
        },
        steps: steps.map((step) => ({ step_id: step.id, kind: step.kind, content: step.content, ts: step.ts })),
        steps_tried: steps.filter((step) => step.kind === 'step').map((step) => step.content),
        support_case: support ? { ticket_ref: support.ticketRef, summary: support.summary } : null,
        needs,
      };
      const text = [
        `Case ${current.id} (${current.status}): ${product?.model ?? 'product not set'}, symptom: ${current.symptom ?? 'not set'}`,
        ...steps.map((step) => `- ${step.kind}: ${step.content}`),
        ...(support ? [`Support ticket ${support.ticketRef} already filed.`] : []),
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
