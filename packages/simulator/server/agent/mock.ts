import { dataOf, deriveState, overlap, progressOf, readableOf, signature, wantsEscalation, type ConversationState } from './context.js';
import type { Block, LlmClient, LlmRequest, LlmResponse, Message } from './llm.js';
import { ESCALATE_AFTER, MOCK_DETAIL_QUESTIONS, MOCK_GENERIC_WORDS, MOCK_INPUT_TOKENS, MOCK_MODEL, MOCK_MODEL_MENTION, MOCK_NOT_FOUND, REPEAT_OVERLAP } from '../../../../config.js';

/**
 * A rule-based stand-in for Claude, for trying the simulator without an API credential (SIM_LLM=mock). It makes real
 * tool calls and follows the playbook's decisions (owned products first, ask when ambiguous, answer only on high
 * confidence, one step at a time, no repeats, offer a support case when steps run out), but it is not a language model:
 * its wording is canned. It reads the same conversation state the real model is given as a note, so what it decides
 * from, and what the offline demo and the multi-turn eval show, is what the loop makes available to the real agent.
 * The model badge says "mock-agent".
 */
const blocks = (message: Message | undefined): Block[] => (Array.isArray(message?.content) ? message.content : []);

const say = (text: string): LlmResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: usage(text), model: MOCK_MODEL });
const call = (id: string, name: string, input: Record<string, unknown>, lead?: string): LlmResponse => ({
  content: [...(lead ? [{ type: 'text', text: lead } as Block] : []), { type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: usage(JSON.stringify(input)),
  model: MOCK_MODEL,
});

function usage(text: string) {
  return { inputTokens: MOCK_INPUT_TOKENS, outputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const tokens = (text: string): string[] => (text.toLowerCase().replace(/-/g, '').match(/[a-z0-9]+/g) ?? []).filter((token) => !MOCK_GENERIC_WORDS.has(token));

/** Which of the machines the customer owns they mean ("the first one", "the espresso one", "DripMate"), if it is clear. */
function pickOwned(state: ConversationState, answer: string): string | undefined {
  const owned = state.owned;
  if (owned.length === 0) return undefined;
  const lower = answer.toLowerCase();
  if (/\b(first|1st)\b/.test(lower)) return owned[0]!.id;
  if (/\b(second|2nd|last|other)\b/.test(lower)) return owned[owned.length - 1]!.id;
  const words = tokens(answer);
  const matches = owned.filter((product) => {
    const own = tokens(`${product.model} ${product.id.replace(/-/g, ' ')}`);
    return words.some((word) => own.some((token) => token === word || (word.length >= 4 && (token.startsWith(word) || word.startsWith(token)) && token.length >= 4)));
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** Whether the line is about the machine the conversation already settled on, so it needs no lookup to know that. */
function namesCurrent(state: ConversationState, text: string): boolean {
  const current = state.product?.id;
  if (!current) return false;
  const lower = text.toLowerCase();
  const spoken = new Set(tokens(text));
  const hits = (id: string) => (state.models[id] ? tokens(state.models[id]).filter((token) => token.length >= 3 && spoken.has(token)).length : 0);
  const best = Math.max(...Object.keys(state.models).map(hits), 0);
  const model = (state.models[current] ?? '').toLowerCase();
  const numbers = lower.match(/\b\d{3}\b/g) ?? [];
  return best > 0 && hits(current) === best && numbers.every((number) => model.includes(number));
}

/** The steps in the top result: its numbered lines, or else its first few sentences of prose. */
function stepsIn(body: string): string[] {
  const numbered = body.split('\n').flatMap((line) => /^\d+\.\s+(.+)$/.exec(line.trim())?.[1] ?? []);
  if (numbered.length > 0) return numbered;
  const prose = body.split('\n').filter((line) => line.trim() && !/^[|#<-]/.test(line.trim())).join(' ');
  return prose.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean).slice(0, 4);
}

/** Everything the assistant has said to the customer so far, as final replies. */
function repliesIn(messages: Message[]): string[] {
  return messages.flatMap((message) => {
    const parts = blocks(message);
    if (message.role !== 'assistant' || parts.some((block) => block.type === 'tool_use')) return [];
    return [parts.map((block) => (block.type === 'text' ? String(block.text) : '')).join(' ')];
  });
}

const warrantyLine = (warranty: NonNullable<ConversationState['warranty']>): string =>
  warranty.status === 'in_warranty'
    ? `Good news, you are covered until ${warranty.endDate}. Would you like me to open a support case?`
    : warranty.status === 'expired'
      ? `I'm sorry, your warranty ended on ${warranty.endDate}. Would you like me to open a support case anyway?`
      : 'I could not confirm your warranty. When did you buy it?';

function decide(messages: Message[]): LlmResponse {
  const state = deriveState(messages);
  const id = `m${messages.length}`;
  const last = messages.at(-1);
  const said = repliesIn(messages);
  const productId = state.product?.id;
  const symptom = (state.problem[0] ?? 'the machine is not working').slice(0, 280);

  /** The first step from the last search that the customer has not been given yet, else a way forward. */
  const advise = (): LlmResponse => {
    const search = state.lastSearch;
    // The first result that has steps (the top one can be a symptom table), and the first of its steps not yet given.
    const source = search?.results.find((result) => stepsIn(result.body).length > 0);
    const next = source ? stepsIn(source.body).find((step) => !said.some((reply) => reply.includes(step))) : undefined;
    if (!source || !next) return offerSupport(search ? 'That is everything the guide suggests.' : MOCK_NOT_FOUND);
    return say(`${next} That is from ${source.citation}. Did that help?`);
  };

  /** Steps have run out: the warranty, then an offer of a support case. */
  const offerSupport = (lead: string): LlmResponse => {
    if (state.warranty && state.warranty.productId === productId) return say(`${lead} ${warrantyLine(state.warranty)}`);
    return productId ? call(id, 'check_warranty', { product_id: productId }, lead) : say(`${lead} Would you like me to open a support case?`);
  };

  /** Nothing usable was found: ask for a detail, a different one each time, and when they run out offer a way forward. */
  const nothingFound = (): LlmResponse => {
    const next = MOCK_DETAIL_QUESTIONS.find((question) => !state.asked.some((asked) => overlap(asked, question) >= REPEAT_OVERLAP));
    return next && state.unknownAnswers === 0 ? say(`${MOCK_NOT_FOUND} ${next}`) : offerSupport(MOCK_NOT_FOUND);
  };

  /** The last step from the guide the customer was given, if it is not on the case yet. */
  const lastAdvisedStep = (): string | undefined => {
    const source = state.lastSearch?.results.find((result) => stepsIn(result.body).length > 0);
    const tried = source ? stepsIn(source.body).filter((step) => said.some((reply) => reply.includes(step))).at(-1)?.slice(0, 500) : undefined;
    return tried && !progressOf(state).steps.includes(tried) ? tried : undefined;
  };

  const failedOutcome = (product: string): LlmResponse =>
    call(id, 'record_diagnostic_step', { kind: 'outcome', content: 'The customer said the last step did not help', product_id: product, symptom });

  const openCase = (product: string): LlmResponse =>
    state.caseId !== undefined
      ? call(id, 'create_support_case', { summary: `${symptom} The steps from the guide did not fix it.`.slice(0, 590) })
      : call(id, 'record_diagnostic_step', { kind: 'step', content: 'Followed the steps from the troubleshooting guide without success', product_id: product, symptom });

  /** Once the machine is known: open a case, check the warranty, or search, depending on what was asked. */
  const nextStep = (product: string): LlmResponse => {
    if (wantsEscalation(state.lastText)) return openCase(product);
    const problem = state.problem.join(' ');
    if (/warranty|covered/i.test(problem)) return state.warranty?.productId === product ? say(warrantyLine(state.warranty)) : call(id, 'check_warranty', { product_id: product });
    const query = { query: problem, product_id: product };
    // The same search would return the same thing: go on with the steps from the one already run.
    if (state.seen.has(signature('search_troubleshooting', query)) && state.lastSearch?.productId === product && state.lastSearch.query === problem) return advise();
    return call(id, 'search_troubleshooting', query);
  };

  // A customer message: decide the first step.
  if (!blocks(last).some((block) => block.type === 'tool_result')) {
    switch (state.lastIntent) {
      case 'safety':
        return say('Please unplug it only if that is safe, stop using it, and contact support. I would not troubleshoot this one.');
      case 'acknowledge':
        if (state.lastReply === '') return say('Hello, how can I help with your Brewwell machine?');
        if (state.answering?.kind === 'closing') return say(/^(yes|yeah|yep|yup|sure|please)\b/i.test(state.lastText.trim()) ? 'Sure, what would you like help with?' : 'Alright. Have a good day.');
        return say(state.answering?.kind === 'outcome' ? 'Sure. Let me know how it goes.' : "You're welcome. Tell me if anything else comes up.");
      case 'off_topic':
        return say('That is outside what I can help with, but I am glad to help with your Brewwell machine.');
      case 'clarify':
        return say(`Sure. ${state.lastReply}`);
      case 'continue':
        return state.lastSearch ? advise() : productId ? nextStep(productId) : call(id, 'list_owned_products', {}, 'Let me check which machine you have.');
      case 'affirm':
        if (state.answering?.kind === 'escalate') return productId ? openCase(productId) : say('Which model do you have?');
        return call(id, 'record_diagnostic_step', { kind: 'outcome', content: 'The customer said the step fixed the problem', resolved: true, ...(productId ? { product_id: productId, symptom } : {}) });
      case 'deny': {
        if (state.answering?.kind === 'escalate') return say('No problem, I will leave it there. Is there anything else I can help with?');
        if (!productId) return call(id, 'list_owned_products', {}, 'Let me check which machine you have.');
        // Record the step that failed, so a support case can list what was tried, then the outcome.
        const tried = lastAdvisedStep();
        return tried ? call(id, 'record_diagnostic_step', { kind: 'step', content: tried, product_id: productId, symptom }) : failedOutcome(productId);
      }
      default:
        break;
    }
    // They could not answer a question: offer a way forward rather than asking it again.
    if (state.lastIntent === 'answer' && state.unknownAnswers > 0 && /don'?t know|do not know|no idea|not sure|can'?t tell|unsure|dunno/i.test(state.lastText)) {
      return state.answering?.kind === 'escalate'
        ? say('No problem. Whenever you are ready, ask me to open a support case, or contact Brewwell support directly.')
        : offerSupport("That's okay.");
    }
    // They are answering "which machine?": use the answer, never ask again.
    if (state.answering?.kind === 'product') {
      const picked = pickOwned(state, state.lastText);
      return picked ? nextStep(picked) : call(id, 'identify_product', { description: state.lastText });
    }
    if (MOCK_MODEL_MENTION.test(state.lastText) && !namesCurrent(state, state.lastText)) return call(id, 'identify_product', { description: state.lastText });
    // The machine was already settled earlier in this conversation.
    if (productId) return nextStep(productId);
    return call(id, 'list_owned_products', {}, 'Let me check which machine you have.');
  }

  // The result of the tools just run.
  const uses = blocks(messages.at(-2)).filter((block) => block.type === 'tool_use');
  const result = blocks(last).find((block) => block.type === 'tool_result');
  const used = uses.find((use) => use.id === result?.tool_use_id);
  const name = String(used?.name ?? '');
  const input = (used?.input ?? {}) as Record<string, unknown>;
  const data = dataOf(result?.content);
  const readable = readableOf(result?.content);

  switch (name) {
    case 'list_owned_products': {
      const owned = (data.owned as { model: string; product_id: string }[] | undefined) ?? [];
      if (data.resolution === 'one') return nextStep(owned[0]!.product_id);
      if (data.resolution === 'several') return say(`Which one is it, the ${owned.map((product) => product.model).join(' or the ')}?`);
      return say('Which model do you have?');
    }
    case 'identify_product': {
      if (data.ambiguous === true) return say(String(data.suggested_question ?? 'Which model do you have?'));
      const candidates = (data.candidates as { product_id: string }[] | undefined) ?? [];
      // Nothing matched: what the customer owns may settle it before they are asked.
      if (!candidates[0]) return state.seen.has(signature('list_owned_products', {})) ? say('I could not tell which machine that is. Which model do you have?') : call(id, 'list_owned_products', {});
      return nextStep(candidates[0].product_id);
    }
    case 'search_troubleshooting': {
      const needs = (data.needs as string[] | undefined) ?? [];
      if (needs.includes('product_id')) return say('I need to know which machine this is first. Which model do you have?');
      return data.confidence === 'high' ? advise() : nothingFound();
    }
    case 'record_diagnostic_step': {
      if (input.kind === 'step' && state.lastIntent === 'deny' && productId) return failedOutcome(productId);
      if (input.kind === 'step') return call(id, 'create_support_case', { summary: `${symptom} The steps from the guide did not fix it.`.slice(0, 590) });
      if (input.resolved === true) return say('Glad that fixed it. Tell me if anything else comes up.');
      // The step did not help: another step if there is one, a support case once enough have failed.
      return progressOf(state).failed >= ESCALATE_AFTER ? offerSupport('I am sorry that did not help.') : advise();
    }
    case 'create_support_case': {
      const warranty = (data.warranty as { status?: string } | undefined)?.status === 'expired' ? ' Your warranty has expired, so a repair would not be covered.' : '';
      return say(`I have opened support case ${String(data.ticket_ref)}.${warranty} Support will follow up.`);
    }
    case 'check_warranty': {
      const until = data.end_date ? String(data.end_date) : undefined;
      if (data.status === 'in_warranty' || data.status === 'expired') return say(warrantyLine({ productId: String(data.product_id), status: String(data.status), endDate: until }));
      return say('I could not confirm your warranty. When did you buy it?');
    }
    default:
      void readable;
      return say(productId ? 'Is there anything else I can help with?' : 'How can I help?');
  }
}

export function createMockLlm(options: { delayMs?: number } = {}): LlmClient {
  const delay = options.delayMs ?? 25;
  return {
    async stream(request: LlmRequest, onText) {
      const response = decide(request.messages);
      await new Promise((resolve) => setTimeout(resolve, delay * 8));
      request.signal?.throwIfAborted();
      for (const block of response.content) {
        if (block.type !== 'text') continue;
        for (const word of String(block.text).split(/(?<= )/)) {
          onText(word);
          await new Promise((resolve) => setTimeout(resolve, delay));
          request.signal?.throwIfAborted();
        }
      }
      return response;
    },
  };
}
