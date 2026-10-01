import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { lookupWarranty } from '../support/lookup.js';
import { errorResult, findCase } from './caseAccess.js';

const DESCRIPTION = [
  'File a support case for the troubleshooting case, after the fixes you gave did not work or the fault needs a repair.',
  'Check the warranty first (check_warranty) so you can tell the user where they stand, and do not file one while a step is still untried.',
  'The ticket is built from the recorded case: its symptom, the steps tried (kind step) and the warranty status.',
  'Your `summary` should say, in a sentence or two, what is wrong and what did not help.',
  'The ticket is simulated: no real support case is opened. Filing twice returns the same ticket.',
  '`warnings` lists anything support will care about, such as no steps recorded. The result includes a card payload for display.',
].join('\n');

const warrantySchema = z.object({
  status: z.enum(['in_warranty', 'expired', 'unknown']),
  term_months: z.number(),
  end_date: z.string().optional(),
  purchase_date: z.string().optional(),
});

const outputSchema = z.object({
  ticket_ref: z.string(),
  already_existed: z.boolean(),
  simulated: z.literal(true),
  case_id: z.number(),
  summary: z.string(),
  symptom: z.string().nullable(),
  product: z.object({ product_id: z.string(), model: z.string() }),
  steps_tried: z.array(z.string()),
  warranty: warrantySchema,
  warnings: z.array(z.string()),
  next_steps: z.string(),
});

export function registerCreateSupportCaseTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'create_support_case',
    {
      title: 'Create a support case',
      description: DESCRIPTION,
      inputSchema: z.object({
        case_id: z.number().int().positive().optional().describe("The troubleshooting case. Leave out for the user's latest open case."),
        summary: z.string().min(10).max(600).describe('What is wrong and what did not help, in a sentence or two.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ case_id, summary }) => {
      const found = findCase(deps, principal, case_id);
      if (found.error) return found.error;
      const current = found.case;
      if (!current) return errorResult('No open case to escalate. Record the problem and steps with record_diagnostic_step first.');
      if (!current.productId) {
        return errorResult('This case has no product. Set it with record_diagnostic_step (product_id), then try again.');
      }

      const lookup = lookupWarranty(deps, principal.userId, current.productId)!;
      const steps = deps.cases.steps(current.id);
      const stepsTried = steps.filter((step) => step.kind === 'step').map((step) => step.content);

      const existing = deps.cases.supportCaseFor(current.id);
      const warrantyStatus = lookup.assessment.status;
      const record =
        existing ??
        deps.cases.createSupportCase({ caseId: current.id, summary, stepsTried, warrantyStatus });
      if (!existing) {
        deps.cases.addStep(current.id, 'outcome', `Escalated to support, ticket ${record.ticketRef}`);
      }

      const warnings = [
        ...(stepsTried.length === 0 ? ['No troubleshooting steps are recorded on this case, support may ask the user to try the basics first.'] : []),
        ...(warrantyStatus === 'unknown' ? ['The warranty status could not be determined: no purchase date is registered.'] : []),
        ...(warrantyStatus === 'expired' ? ['The warranty has expired, so a repair would not be covered.'] : []),
      ];
      const output: z.infer<typeof outputSchema> = {
        ticket_ref: record.ticketRef,
        already_existed: existing !== undefined,
        simulated: true,
        case_id: current.id,
        summary: record.summary,
        symptom: current.symptom,
        product: { product_id: lookup.product.id, model: lookup.product.model },
        steps_tried: record.stepsTried,
        warranty: {
          status: warrantyStatus,
          term_months: lookup.product.warrantyTermMonths,
          ...(lookup.assessment.endDate ? { end_date: lookup.assessment.endDate } : {}),
          ...(lookup.purchaseDate ? { purchase_date: lookup.purchaseDate } : {}),
        },
        warnings,
        next_steps: 'A Brewwell support agent will follow up about this case. This is a simulated ticket for the demo.',
      };
      const text = [
        `${existing ? 'Support ticket already filed' : 'Support ticket created'}: ${record.ticketRef} (simulated).`,
        `Product: ${lookup.product.model}. Warranty: ${warrantyStatus.replace('_', ' ')}${lookup.assessment.endDate ? `, until ${lookup.assessment.endDate}` : ''}.`,
        `Steps tried: ${record.stepsTried.length > 0 ? record.stepsTried.join('; ') : 'none recorded'}.`,
        ...warnings.map((warning) => `Note: ${warning}`),
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
