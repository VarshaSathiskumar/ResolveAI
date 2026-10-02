import { LOOKUP_TOOLS, READ_ONLY_TOOLS, SKIPPED_PREFIX, signature, type ConversationState, type Intent } from './context.js';
import type { ModelTool } from '../mcp/tools.js';

/** Lines that carry nothing to look up: a search or a product lookup for one is wasted, and misleading. */
const NO_LOOKUP: Intent[] = ['acknowledge', 'off_topic', 'safety', 'affirm'];

export type Decision =
  /** Run the call, with these arguments (a missing product_id may have been filled in). */
  | { action: 'run'; input: Record<string, unknown>; note?: string }
  /** Answer the call here, so it never reaches the server. */
  | { action: 'skip'; reason: 'not_needed' | 'repeat'; text: string };

const acceptsProduct = (tools: ModelTool[], name: string): boolean => {
  const properties = tools.find((tool) => tool.name === name)?.input_schema.properties;
  return typeof properties === 'object' && properties !== null && 'product_id' in properties;
};

/**
 * Checks one tool call against the conversation before it runs, in three general ways:
 * 1. a call a message cannot need (a search for "thanks") is not run;
 * 2. a read-only call identical to one already answered is not run again, since it returns the same thing;
 * 3. a missing product_id is filled in from the machine the conversation already settled on, rather than failing and
 *    sending the model back to ask the customer.
 * `state` is read from the history as it stands, so it includes the tool results of earlier rounds of this turn.
 */
export function guardCall(state: ConversationState, tools: ModelTool[], name: string, input: Record<string, unknown>): Decision {
  const intent = state.lastIntent;
  const declinedOffer = intent === 'deny' && state.answering?.kind === 'escalate';
  if (LOOKUP_TOOLS.has(name) && intent && (NO_LOOKUP.includes(intent) || declinedOffer)) {
    return {
      action: 'skip',
      reason: 'not_needed',
      text: `${SKIPPED_PREFIX}Not run: the customer's message needs no ${name === 'search_troubleshooting' ? 'search' : 'lookup'}. Answer from the conversation, or ask what else you can help with.`,
    };
  }
  // Fill in the machine first, so a call is judged as what it would actually ask.
  const fill = input.product_id === undefined && state.product !== undefined && acceptsProduct(tools, name);
  const effective = fill ? { ...input, product_id: state.product!.id } : input;
  if (READ_ONLY_TOOLS.has(name) && state.seen.has(signature(name, effective))) {
    return {
      action: 'skip',
      reason: 'repeat',
      text: `${SKIPPED_PREFIX}Not run: you already made this exact ${name} call in this conversation, so the result is unchanged and is above. Use it, search with different words, or ask the customer something new.`,
    };
  }
  if (fill) {
    const model = state.models[state.product!.id];
    return { action: 'run', input: effective, note: `product_id was left out, so the machine from this conversation was used${model ? ` (${model})` : ''}.` };
  }
  return { action: 'run', input };
}
