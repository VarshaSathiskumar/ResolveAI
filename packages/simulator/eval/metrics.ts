import { CATEGORIES, NON_PROBLEM, type Category, type ScenarioRun, type TurnRecord } from './harness.js';

/**
 * Counts that need no per-scenario expectation: they read the trace of any conversation. Lower is better for every
 * count. They are the same measurements before and after a change, so the two runs can be compared directly.
 */
export interface Counts {
  /** The assistant asked which machine or model after the conversation had already settled one. */
  productReasks: number;
  /** A product lookup (list_owned_products, identify_product) when the product was already settled and the line named none. */
  redundantLookups: number;
  /** A search or lookup spent on a line that is an acknowledgement, a confirmation, a clarification or off topic. */
  retrievalOnNonProblem: number;
  /** Any tool call at all on an off-topic line. */
  toolsOnOffTopic: number;
  /** The same read-only tool call, with the same arguments, made again in one conversation. */
  repeatedToolCalls: number;
  /** A question put again after it was already asked. */
  repeatedQuestions: number;
  /** A reply that says (nearly) what an earlier reply already said. */
  repeatedReplies: number;
}

export const COUNT_KEYS = Object.keys({
  productReasks: 0,
  redundantLookups: 0,
  retrievalOnNonProblem: 0,
  toolsOnOffTopic: 0,
  repeatedToolCalls: 0,
  repeatedQuestions: 0,
  repeatedReplies: 0,
} satisfies Counts) as (keyof Counts)[];

const READ_ONLY = new Set(['search_troubleshooting', 'identify_product', 'list_owned_products', 'get_product', 'check_warranty', 'get_document_section']);
const LOOKUPS = new Set(['search_troubleshooting', 'identify_product', 'list_owned_products']);
const PRODUCT_LOOKUPS = new Set(['identify_product', 'list_owned_products']);

export const asksWhichProduct = (text: string): boolean => /\bwhich (one|model|machine|product)\b|\bis it the\b.*\bor the\b|which .* do you have/i.test(text);

const STOP = new Set(['the', 'a', 'an', 'is', 'it', 'that', 'this', 'you', 'your', 'to', 'of', 'and', 'or', 'do', 'did', 'can', 'what', 'i']);
const words = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !STOP.has(word)));

/** Share of words two texts have in common, from 0 to 1. */
export function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export const SAME = 0.8;

const CHECK_IN = /\b(did|does|is|has) (that|it|this)\b.*\b(help|work|fix|brewing)\b/i;

const questionsIn = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().endsWith('?'));

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );

const hasProduct = (turn: TurnRecord): boolean => turn.calls.some((call) => typeof call.input.product_id === 'string');

export function countsOf(run: ScenarioRun): Counts {
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as unknown as Counts;
  const seenCalls = new Set<string>();
  const seenQuestions: string[] = [];
  const seenReplies: string[] = [];
  let productSettled = false;

  for (const turn of run.turns) {
    const settledBefore = productSettled;
    if (settledBefore && turn.kind !== 'switch' && asksWhichProduct(turn.reply)) counts.productReasks += 1;
    if (settledBefore && turn.kind !== 'switch' && turn.kind !== 'problem') {
      counts.redundantLookups += turn.calls.filter((call) => PRODUCT_LOOKUPS.has(call.name)).length;
    }
    if (NON_PROBLEM.includes(turn.kind)) counts.retrievalOnNonProblem += turn.calls.filter((call) => LOOKUPS.has(call.name)).length;
    if (turn.kind === 'offtopic') counts.toolsOnOffTopic += turn.calls.length;

    for (const call of turn.calls) {
      if (!READ_ONLY.has(call.name)) continue;
      const key = `${call.name}:${stable(call.input)}`;
      if (seenCalls.has(key)) counts.repeatedToolCalls += 1;
      seenCalls.add(key);
    }
    // "Did that help?" follows every step by design, and a customer who asks to hear something again is owed it.
    const questions = questionsIn(turn.reply).filter((question) => !CHECK_IN.test(question));
    for (const question of questions) {
      if (seenQuestions.some((earlier) => overlap(earlier, question) >= SAME)) counts.repeatedQuestions += 1;
    }
    seenQuestions.push(...questions);
    const owedAgain = turn.kind === 'clarify' || turn.kind === 'ack';
    if (!owedAgain && words(turn.reply).size >= 4 && seenReplies.some((earlier) => overlap(earlier, turn.reply) >= SAME)) counts.repeatedReplies += 1;
    seenReplies.push(turn.reply);

    if (hasProduct(turn)) productSettled = true;
  }
  return counts;
}

export interface Report {
  /** Calls the loop answered itself (not needed, or a repeat). Not an error: they never reached the server. */
  blockedCalls: number;
  /** Passed and total expectations, overall and by category. */
  checks: { passed: number; total: number };
  byCategory: Record<Category, { passed: number; total: number }>;
  counts: Counts;
  failures: { scenario: string; turn: number; check: string }[];
  scenarios: number;
  turns: number;
}

export function summarize(runs: ScenarioRun[]): Report {
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, { passed: 0, total: 0 }])) as Report['byCategory'];
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as unknown as Counts;
  const failures: Report['failures'] = [];
  let passed = 0;
  let total = 0;

  for (const run of runs) {
    for (const [key, value] of Object.entries(countsOf(run))) counts[key as keyof Counts] += value;
    for (const check of run.checks) {
      total += 1;
      byCategory[run.scenario.category].total += 1;
      if (check.passed) {
        passed += 1;
        byCategory[run.scenario.category].passed += 1;
      } else {
        failures.push({ scenario: run.scenario.id, turn: check.turn, check: check.name });
      }
    }
  }
  const blockedCalls = runs.reduce((sum, run) => sum + run.turns.reduce((inner, turn) => inner + turn.skipped.length, 0), 0);
  return { blockedCalls, checks: { passed, total }, byCategory, counts, failures, scenarios: runs.length, turns: runs.reduce((sum, run) => sum + run.turns.length, 0) };
}
