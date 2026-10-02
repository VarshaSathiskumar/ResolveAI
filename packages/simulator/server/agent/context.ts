import type { Block, Message } from './llm.js';
import { ACK_WORDS, ESCALATE_AFTER, LOOKUP_TOOLS, NEUTRAL_PRODUCT_KEY, OVERLAP_STOP_WORDS, PATTERN_ABOUT_THE_HELP, PATTERN_ASKS, PATTERN_CLARIFY, PATTERN_DOMAIN, PATTERN_DONT_KNOW, PATTERN_ERROR_CODE, PATTERN_ESCALATE, PATTERN_FAILED, PATTERN_FIXED, PATTERN_NEXT, PATTERN_NO, PATTERN_OFFER_YES, PATTERN_REFERS_BACK, PATTERN_SAFETY, PATTERN_WHICH_PRODUCT, PATTERN_WILL_ACT, PATTERN_YES, READ_ONLY_TOOLS, REPEAT_OVERLAP, SKIPPED_PREFIX } from '../../../../config.js';

/**
 * What the conversation has established so far, worked out from the message history alone. The history is the single
 * source of truth: nothing is stored beside it, so a turn that is rolled back takes its state with it and the state can
 * never disagree with what the model was shown. The same function feeds the context note the model reads, the guard
 * that checks its tool calls, and the offline mock.
 */

export type Intent =
  /** A problem or a request: the normal case, and the default. */
  | 'request'
  /** A reply to a question the assistant asked. */
  | 'answer'
  | 'affirm'
  | 'deny'
  /** Thanks, "ok", a greeting or a goodbye: nothing new to act on. */
  | 'acknowledge'
  /** A question about what the assistant just said ("say that again", "what do you mean"). */
  | 'clarify'
  /** A question about which machine the conversation is about ("which device is this for?"). */
  | 'which_product'
  /** A request for what comes next ("what is the next step", "anything else I can try"). */
  | 'continue'
  | 'off_topic'
  | 'safety';

/** What an assistant question was asking for, so a short answer can be read in its light. */
export type QuestionKind = 'outcome' | 'escalate' | 'product' | 'detail' | 'closing';

export interface Pending {
  question: string;
  kind: QuestionKind;
}

/** What has been tried for one product. Kept per product so switching machines neither carries steps over nor loses them. */
export interface Progress {
  steps: string[];
  /** Times the customer reported that an attempt did not help. */
  failed: number;
  /** Documentation has been found and given for this product. */
  advised: boolean;
}

export interface SearchRecord {
  query: string;
  productId?: string;
  confidence: string;
  /** The results as the model read them, best first. */
  results: { citation: string; section: string; body: string }[];
}

export interface ConversationState {
  product?: { id: string };
  /** Model names by product id, from every tool result that named one. */
  models: Record<string, string>;
  /** The customer's registered machines, when there are several and none is chosen yet. */
  owned: { id: string; model: string }[];
  caseId?: number;
  ticket?: string;
  warranty?: { productId: string; status: string; endDate?: string };
  resolved: boolean;
  /** The customer's words about the current problem: the request, then what they added when asked. */
  problem: string[];
  progress: Record<string, Progress>;
  /** Every question the assistant has put that asked for something, in order (not the "did that help?" after a step). */
  asked: string[];
  /** The question the assistant ended its last reply with, if the customer has not answered it yet. */
  pending?: Pending;
  /** The question the customer's latest message answered (or tried to). */
  answering?: Pending;
  lastReply: string;
  /** The last reply said (nearly) what an earlier one already said. */
  repeatedReply: boolean;
  /** Times the customer could not answer a question. */
  unknownAnswers: number;
  /** A support case was offered and the customer has not decided. */
  offered: boolean;
  declined: boolean;
  /** Read-only calls already answered, by `signature()`. */
  seen: Set<string>;
  lastSearch?: SearchRecord;
  lastIntent?: Intent;
  /** The customer's latest message. */
  lastText: string;
}

export const progressOf = (state: ConversationState, productId: string | undefined = state.product?.id): Progress => {
  const key = productId ?? NEUTRAL_PRODUCT_KEY;
  return (state.progress[key] ??= { steps: [], failed: 0, advised: false });
};

export function emptyState(): ConversationState {
  return {
    models: {},
    owned: [],
    resolved: false,
    problem: [],
    progress: {},
    asked: [],
    lastReply: '',
    repeatedReply: false,
    unknownAnswers: 0,
    offered: false,
    declined: false,
    seen: new Set(),
    lastText: '',
  };
}

// Reading the customer ------------------------------------------------------------------------------------------

const wordsOf = (text: string): string[] => text.match(/[a-z0-9']+/g) ?? [];

/** Whether the line mentions the machine, by name or by the kind of thing a machine does or suffers. */
function aboutProduct(text: string, state: ConversationState): boolean {
  if (PATTERN_DOMAIN.test(text) || PATTERN_ERROR_CODE.test(text) || wantsEscalation(text)) return true;
  const names = Object.values(state.models).flatMap((model) => wordsOf(model.toLowerCase()).filter((word) => word.length >= 4));
  if (names.some((name) => text.includes(name))) return true;
  const active = state.product && (progressOf(state).advised || progressOf(state).steps.length > 0 || state.pending || state.problem.length > 0);
  return Boolean(active && (PATTERN_REFERS_BACK.test(text) || PATTERN_ABOUT_THE_HELP.test(text)));
}

export const wantsEscalation = (text: string): boolean => PATTERN_ESCALATE.test(text.toLowerCase());

/**
 * What the customer's line is, in the light of the conversation so far. Deliberately blunt: short lines are read in
 * context (a "yes" answers the last question), anything with content is a request, and only lines that clearly carry
 * nothing to look up are held back from the product flow.
 */
export function classifyMessage(raw: string, state: ConversationState): Intent {
  const text = raw.trim().toLowerCase().replace(/[‘’]/g, "'");
  const words = wordsOf(text);
  if (PATTERN_SAFETY.test(text)) return 'safety';
  if (words.length === 0) return 'acknowledge';
  // "No idea" is an answer, not a refusal, so it is read before the yes and no rules.
  if (state.lastReply !== '' && PATTERN_DONT_KNOW.test(text)) return 'answer';

  const pending = state.pending;
  const progress = progressOf(state);
  const talking = state.lastReply !== '';
  const short = words.length <= 8 && !wantsEscalation(text);

  if (short) {
    if (pending?.kind === 'escalate') {
      if (PATTERN_OFFER_YES.test(text) && !PATTERN_FAILED.test(text)) return 'affirm';
      if (PATTERN_NO.test(text)) return 'deny';
    }
    if (pending?.kind === 'closing' && (PATTERN_NO.test(text) || PATTERN_YES.test(text))) return 'acknowledge';
    const reportsOutcome = pending?.kind !== 'escalate' && pending?.kind !== 'closing' && (pending?.kind === 'outcome' || progress.advised || progress.steps.length > 0);
    if (reportsOutcome) {
      if (PATTERN_FAILED.test(text) || (pending?.kind === 'outcome' && PATTERN_NO.test(text))) return 'deny';
      if (PATTERN_FIXED.test(text) || (pending?.kind === 'outcome' && PATTERN_YES.test(text))) return 'affirm';
    }
    if (words.every((word) => ACK_WORDS.has(word)) || PATTERN_WILL_ACT.test(text)) return 'acknowledge';
    // A bare yes or no with nothing asked is no request.
    if ((PATTERN_YES.test(text) || PATTERN_NO.test(text)) && !pending) return 'acknowledge';
  }
  if (talking && state.product && PATTERN_WHICH_PRODUCT.test(text)) return 'which_product';
  if (talking && PATTERN_CLARIFY.test(text)) return 'clarify';
  if (talking && PATTERN_NEXT.test(text)) return 'continue';
  if (!aboutProduct(text, state) && !(pending && words.length <= 3)) return 'off_topic';
  // Only a question that asks for a detail takes an answer; after a yes or no question, anything else is a new request.
  const takesAnswer = pending?.kind === 'product' || (pending?.kind === 'detail' && !PATTERN_ASKS.test(text));
  return takesAnswer && !wantsEscalation(text) ? 'answer' : 'request';
}

// Reading the assistant -----------------------------------------------------------------------------------------

export function questionKind(question: string): QuestionKind {
  // "Is there anything else I can help with?" asks nothing about a step, so a no to it is not a failed attempt.
  if (/\banything else\b/i.test(question)) return 'closing';
  if (/\b(which|is it the)\b/i.test(question) && /\b(one|model|machine|product|or the)\b/i.test(question)) return 'product';
  if (/\b(support|case|ticket)\b/i.test(question) && /\b(open|create|file|raise|want|like)\b/i.test(question)) return 'escalate';
  if (/\b(did|does|is|has|was)\b.*\b(help|work|fix|fixed|working|brewing|better|resolved)\b/i.test(question)) return 'outcome';
  return 'detail';
}

const questionsIn = (text: string): string[] => text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.endsWith('?'));

const contentWords = (text: string): Set<string> => new Set(wordsOf(text.toLowerCase()).filter((word) => !OVERLAP_STOP_WORDS.has(word)));

/** How much of the shorter text the other one repeats, from 0 to 1. */
export function overlap(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

// Folding the history -------------------------------------------------------------------------------------------

type Call = { name: string; input: Record<string, unknown> };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isObject) : []);

export function dataOf(content: unknown): Record<string, unknown> {
  const text = typeof content === 'string' ? content : '';
  const marker = text.indexOf('[data] ');
  if (marker === -1) return {};
  try {
    const parsed: unknown = JSON.parse(text.slice(marker + 7));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const readableOf = (content: unknown): string => (typeof content === 'string' ? content.split('\n\n[data] ')[0]! : '');

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

/** Identifies a call by what it asked, so an identical one can be recognised. */
export const signature = (name: string, input: unknown): string => `${name}:${stable(input ?? {})}`;

function setProduct(state: ConversationState, id: unknown, model?: unknown): void {
  if (typeof id !== 'string' || id === '') return;
  if (typeof model === 'string' && model) state.models[id] = model;
  // A different machine means what the customer just said is the problem now, not what they said about the last one.
  if (state.product && state.product.id !== id && state.lastText) state.problem = [state.lastText];
  state.product = { id };
}

/** The results in a search's readable text: each "N. <citation>, section "<name>"" header and the lines under it. */
function resultsIn(text: string): SearchRecord['results'] {
  const results: { citation: string; section: string; body: string }[] = [];
  for (const line of text.split('\n')) {
    const header = /^\d+\. (.*), section "(.*)"$/.exec(line);
    if (header) results.push({ citation: header[1]!, section: header[2]!, body: '' });
    else if (results.length > 0) results[results.length - 1]!.body += `${line}\n`;
  }
  return results.map((result) => ({ ...result, body: result.body.trim() }));
}

function observeResult(state: ConversationState, block: Block, calls: Map<string, Call>): void {
  const call = calls.get(String(block.tool_use_id));
  const content = block.content;
  if (!call || block.is_error === true || typeof content !== 'string' || content.startsWith(SKIPPED_PREFIX)) return;
  const data = dataOf(content);
  const readable = readableOf(content);
  const { name, input } = call;
  if (READ_ONLY_TOOLS.has(name)) {
    state.seen.add(signature(name, input));
    // A call that left out product_id was filled in with the settled machine, so remember it as that call too.
    if (input.product_id === undefined && state.product) state.seen.add(signature(name, { ...input, product_id: state.product.id }));
  }

  switch (name) {
    case 'list_owned_products': {
      const owned = asList(data.owned).map((entry) => ({ id: String(entry.product_id), model: String(entry.model) }));
      for (const entry of owned) state.models[entry.id] = entry.model;
      if (data.resolution === 'one' && owned[0]) setProduct(state, owned[0].id);
      if (data.resolution === 'several') state.owned = owned;
      break;
    }
    case 'identify_product': {
      const candidate = asList(data.candidates)[0];
      for (const entry of asList(data.candidates)) if (typeof entry.product_id === 'string' && typeof entry.model === 'string') state.models[entry.product_id] = entry.model;
      if (data.ambiguous === false && candidate) setProduct(state, candidate.product_id);
      break;
    }
    case 'search_troubleshooting': {
      setProduct(state, input.product_id);
      state.lastSearch = {
        query: String(input.query ?? ''),
        productId: typeof input.product_id === 'string' ? input.product_id : undefined,
        confidence: String(data.confidence ?? ''),
        results: resultsIn(readable),
      };
      if (data.confidence === 'high') progressOf(state).advised = true;
      break;
    }
    case 'check_warranty':
      setProduct(state, data.product_id ?? input.product_id, data.model);
      state.warranty = { productId: String(data.product_id ?? input.product_id), status: String(data.status ?? 'unknown'), ...(typeof data.end_date === 'string' ? { endDate: data.end_date } : {}) };
      break;
    case 'get_product':
      setProduct(state, input.product_id, data.model);
      break;
    case 'record_diagnostic_step': {
      if (typeof data.case_id === 'number') state.caseId = data.case_id;
      setProduct(state, data.product_id ?? input.product_id);
      const progress = progressOf(state);
      const content = String(input.content ?? '');
      if (input.kind === 'step' && content && !progress.steps.includes(content)) progress.steps.push(content);
      if (input.kind === 'outcome' && input.resolved === true) state.resolved = true;
      break;
    }
    case 'get_case_state': {
      const current = isObject(data.case) ? data.case : undefined;
      if (current) {
        if (typeof current.case_id === 'number') state.caseId = current.case_id;
        setProduct(state, current.product_id, current.product_model);
        const progress = progressOf(state);
        for (const step of Array.isArray(data.steps_tried) ? data.steps_tried : []) if (typeof step === 'string' && !progress.steps.includes(step)) progress.steps.push(step);
      }
      break;
    }
    case 'create_support_case':
      if (typeof data.ticket_ref === 'string') state.ticket = data.ticket_ref;
      break;
  }
}

/** Reads one customer line into the state and returns what it was. Called for each line in order, the newest last. */
export function observeCustomer(state: ConversationState, text: string): Intent {
  const intent = classifyMessage(text, state);
  const pending = state.pending;
  const progress = progressOf(state);
  state.answering = pending;
  state.pending = undefined;
  state.lastIntent = intent;
  state.lastText = text;

  switch (intent) {
    case 'request':
      if (state.resolved) {
        state.resolved = false;
        state.progress[state.product?.id ?? NEUTRAL_PRODUCT_KEY] = { steps: [], failed: 0, advised: false };
        state.unknownAnswers = 0;
        state.declined = false;
      }
      // Asking for a case is not a new problem: the problem stays what it was.
      state.problem = wantsEscalation(text) && state.problem.length > 0 ? state.problem : [text];
      break;
    case 'answer':
      if (PATTERN_DONT_KNOW.test(text.toLowerCase())) state.unknownAnswers += 1;
      else if (pending?.kind !== 'product') state.problem.push(text);
      break;
    case 'deny':
      if (pending?.kind === 'escalate') {
        state.offered = false;
        state.declined = true;
      } else {
        progress.failed += 1;
      }
      break;
    case 'affirm':
      if (pending?.kind === 'escalate') state.offered = false;
      else state.resolved = true;
      break;
    default:
      break;
  }
  return intent;
}

function observeReply(state: ConversationState, raw: string): void {
  // A question can be followed by an aside in brackets (the product tool's suggested question is); the asking is what counts.
  const text = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const all = questionsIn(text);
  // "Did that help?" follows every step by design, so it is neither a repeat nor something not to ask again.
  const questions = all.filter((question) => questionKind(question) !== 'outcome');
  const earlier = state.lastReply !== '' || state.asked.length > 0;
  state.repeatedReply = earlier && contentWords(text).size >= 4 && (overlap(state.lastReply, text) >= REPEAT_OVERLAP || questions.some((q) => state.asked.some((old) => overlap(old, q) >= REPEAT_OVERLAP)));
  state.asked.push(...questions);
  state.lastReply = text;
  const last = text.split(/(?<=[.!?])\s+/).at(-1)?.trim() ?? '';
  state.pending = last.endsWith('?') ? { question: last, kind: questionKind(last) } : undefined;
  if (state.pending?.kind === 'escalate') state.offered = true;
}

const customerText = (message: Message): string | undefined => {
  if (typeof message.content === 'string') return message.content;
  if (message.content.some((block) => block.type === 'tool_result')) return undefined;
  const first = message.content.find((block) => block.type === 'text');
  return first ? String(first.text ?? '') : undefined;
};

export function deriveState(messages: Message[]): ConversationState {
  const state = emptyState();
  const calls = new Map<string, Call>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      const blocks = typeof message.content === 'string' ? [] : message.content;
      const uses = blocks.filter((block) => block.type === 'tool_use');
      for (const use of uses) calls.set(String(use.id), { name: String(use.name), input: isObject(use.input) ? use.input : {} });
      // Text beside a tool call is a lead-in, not a reply: only a message with no calls ends the assistant's turn.
      if (uses.length === 0) observeReply(state, typeof message.content === 'string' ? message.content : blocks.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join(' '));
      continue;
    }
    const text = customerText(message);
    if (text !== undefined) {
      observeCustomer(state, text);
      continue;
    }
    for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool_result') observeResult(state, block, calls);
  }
  return state;
}

// Writing the note for the model --------------------------------------------------------------------------------

const quote = (items: string[]): string => items.map((item) => `"${item.length > 120 ? `${item.slice(0, 117)}...` : item}"`).join(', ');

const modelOf = (state: ConversationState, id: string): string => state.models[id] ?? id;

/** Whether this is the moment to move from steps to a support case. */
export const shouldEscalate = (state: ConversationState): boolean =>
  !state.ticket && !state.offered && !state.declined && (progressOf(state).failed >= ESCALATE_AFTER || state.unknownAnswers >= ESCALATE_AFTER);

function describeMessage(state: ConversationState, intent: Intent): string | undefined {
  const asked = state.answering;
  switch (intent) {
    case 'acknowledge':
      return 'only an acknowledgement or thanks. Reply in one short sentence and do not call search or product tools.';
    case 'affirm':
      return asked?.kind === 'escalate'
        ? 'a yes to your offer of a support case. Create it now, without searching.'
        : 'a yes: the last step worked. Record the outcome as resolved and close warmly, without searching.';
    case 'deny':
      return asked?.kind === 'escalate'
        ? 'a no to your offer of a support case. Do not create one and do not search; ask if there is anything else.'
        : 'the last step did not help. Record that outcome, then give a different step from the results you already have, or move on to the warranty and a support case.';
    case 'continue':
      return 'a request for what comes next. Give the next step from the results you already have, one that you have not given yet; search again only if none is left, and offer a support case if there are no more steps.';
    case 'clarify':
      return 'a question about what you just said. Answer from the conversation; search again only if the answer is not there.';
    case 'which_product':
      return 'a question about which machine this is for. Answer with the machine model from this note, without searching.';
    case 'answer':
      return state.lastText && PATTERN_DONT_KNOW.test(state.lastText.toLowerCase())
        ? 'the customer could not answer your question. Do not ask it again; try a different angle or offer a support case.'
        : 'an answer to your question. Combine it with the problem so far.';
    case 'off_topic':
      return 'not about their product. Say briefly that you can only help with their home products. Do not call tools and do not ask which product.';
    case 'safety':
      return 'a safety concern. Follow the safety rule and do not troubleshoot.';
    default:
      return undefined;
  }
}

/** The facts the model should not have to dig out of a long history, ending with how to read the latest line. Empty when there is nothing to say. */
export function renderNote(state: ConversationState, intent: Intent): string {
  const progress = progressOf(state);
  const lines: string[] = [];
  if (state.product) lines.push(`Machine: ${modelOf(state, state.product.id)} (product_id ${state.product.id}). Use it in tools. Do not ask which machine again unless the customer names another.`);
  else if (state.owned.length > 1) lines.push(`The customer has ${state.owned.map((entry) => entry.model).join(' and ')} registered. Ask which one only if they have not said.`);
  if (state.caseId !== undefined) lines.push(`Case: ${state.caseId}.`);
  if (state.ticket) lines.push(`Support case ${state.ticket} is already filed. Do not create another.`);
  if (state.problem.length > 0 && intent !== 'request') lines.push(`Problem so far: ${state.problem.join(' ')}`);
  if (progress.steps.length > 0) lines.push(`Steps already given: ${quote(progress.steps)}. Do not give them again.`);
  if (progress.failed > 0) lines.push(`Attempts that did not help: ${progress.failed}.`);
  if (state.asked.length > 0) lines.push(`Questions you already asked: ${quote(state.asked.slice(-4))}. Do not ask them again.`);
  if (state.repeatedReply) lines.push('Your last reply repeated an earlier one. Say something new.');
  if (shouldEscalate(state) && intent !== 'off_topic' && intent !== 'safety') lines.push('Attempts have run out. Check the warranty and offer a support case now.');

  const meaning = describeMessage(state, intent);
  // With nothing established yet there is nothing to add: the playbook covers a first line on its own.
  if (lines.length === 0) return '';
  return ['[context from the system, not the customer: never read it aloud]', ...lines, ...(meaning ? [`The customer's message is ${meaning}`] : []), '[/context]'].join('\n');
}

/** Reads the customer's new line against the history so far: what it is, and the note that goes with it. */
export function analyzeMessage(messages: Message[], text: string): { intent: Intent; note: string; state: ConversationState } {
  const state = deriveState(messages);
  const intent = observeCustomer(state, text);
  return { intent, note: renderNote(state, intent), state };
}
