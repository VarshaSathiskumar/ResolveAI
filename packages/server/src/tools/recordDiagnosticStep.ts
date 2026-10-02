import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.js';
import type { ServerDeps } from '../deps.js';
import { errorResult, findCase } from './caseAccess.js';
import { NO_ACCOUNT } from '../../../../config.js';

const DESCRIPTION = [
  'Write one entry to the troubleshooting case: a question you asked, the user\'s answer, a step you gave them, or an outcome.',
  'Call it after you ask a diagnostic question (kind question), after the user answers (answer), after you give a fix (step), and',
  'after they report whether it worked (outcome). This is what lets you avoid repeating steps and what a support case is built from.',
  'Pass the `case_id` it returns on later calls. If you leave it out, the step is added to the user\'s latest open case, so a forgotten id',
  'does not split one problem into two cases. A new case starts only when there is no open case, when `product_id` names a different product,',
  'or when you set `new_case` to true. Pass `product_id` and `symptom` as soon as you know them.',
  'Set `resolved` to true on an outcome when the problem is fixed, which closes the case.',
].join('\n');

const outputSchema = z.object({
  case_id: z.number(),
  step_id: z.number(),
  started_new_case: z.boolean(),
  status: z.enum(['open', 'resolved', 'escalated']),
  product_id: z.string().nullable(),
  symptom: z.string().nullable(),
  steps_recorded: z.number(),
});

export function registerRecordDiagnosticStepTool(server: McpServer, deps: ServerDeps, principal: Principal): void {
  server.registerTool(
    'record_diagnostic_step',
    {
      title: 'Record a troubleshooting step',
      description: DESCRIPTION,
      inputSchema: z.object({
        case_id: z.number().int().positive().optional().describe("The case to add to. Leave out to continue the user's latest open case."),
        new_case: z.boolean().optional().describe('Start a separate case even though one is open, for example for a different problem.'),
        kind: z.enum(['question', 'answer', 'step', 'outcome']),
        content: z.string().min(1).max(500).describe('What was asked, answered, tried or observed, in a short sentence.'),
        product_id: z.string().optional().describe('The product this case is about. Set it when known.'),
        symptom: z.string().min(1).max(300).optional().describe("The problem in the user's words. Set it when you start a case."),
        resolved: z.boolean().optional().describe('With kind outcome: true when the problem is fixed.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ case_id, new_case, kind, content, product_id, symptom, resolved }) => {
      if (!principal.userId) return errorResult(NO_ACCOUNT);
      if (product_id && !deps.catalog.getProduct(product_id)) {
        return errorResult(`Unknown product_id "${product_id}". Use list_owned_products or identify_product to find the right id.`);
      }

      let startedNew = false;
      let current;
      if (case_id !== undefined) {
        const found = findCase(deps, principal, case_id);
        if (found.error) return found.error;
        current = found.case!;
        if (product_id || symptom) deps.cases.update(current.id, { productId: product_id, symptom });
      } else {
        // Continue the open case unless the caller asked for a new one or the product is clearly different.
        const open = new_case ? undefined : deps.cases.latestOpen(principal.userId);
        const sameProduct = !open?.productId || !product_id || open.productId === product_id;
        if (open && sameProduct) {
          current = open;
          // Fill in what the case is missing without overwriting what it already says.
          deps.cases.update(current.id, {
            ...(!open.productId && product_id ? { productId: product_id } : {}),
            ...(!open.symptom && symptom ? { symptom } : {}),
          });
        } else {
          current = deps.cases.open({ userId: principal.userId, productId: product_id, symptom });
          startedNew = true;
        }
      }

      const step = deps.cases.addStep(current.id, kind, content);
      if (kind === 'outcome' && resolved === true) deps.cases.update(current.id, { status: 'resolved' });

      const latest = deps.cases.get(current.id, principal.userId)!;
      const output: z.infer<typeof outputSchema> = {
        case_id: latest.id,
        step_id: step.id,
        started_new_case: startedNew,
        status: latest.status,
        product_id: latest.productId,
        symptom: latest.symptom,
        steps_recorded: deps.cases.steps(latest.id).length,
      };
      const text = `${startedNew ? 'Started case' : 'Updated case'} ${latest.id} (${latest.status}). Recorded ${kind}: ${content}`;
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
