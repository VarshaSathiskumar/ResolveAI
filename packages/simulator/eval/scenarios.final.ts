import type { Scenario } from './harness.js';
import {
  BP200, doesNotSay, never, noLookups, noProductQuestion, noRepeat, noTools, noTroubleshooting, opensTicket, recordsOutcome, replies,
  searches, warrantyFor,
} from './checks.js';

const PROBLEM = "my coffee machine won't brew, only drops come out";

/**
 * The third set. Written after the intent rules were last changed and run once against the old code and once against
 * the new, then left alone. It is the number to trust for how the agent behaves on lines it was not shaped on, and it
 * includes lines the rules were not built for.
 */
export const FINAL: Scenario[] = [
  {
    id: 'final-next-step-after-acknowledging',
    category: 'routing',
    persona: 'alex',
    description: 'An acknowledgement, then a request for the next step: the first needs no tools, the second no new question.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'okay', kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
      { say: 'so what is the next step?', kind: 'problem', expect: [noLookups, noRepeat(2), noProductQuestion, doesNotSay(/couldn't find/), replies] },
    ],
  },
  {
    id: 'final-trivia-then-thanks-then-problem',
    category: 'scope',
    persona: 'alex',
    description: 'Unrelated trivia, a thank-you for the refusal, then the real problem.',
    turns: [
      { say: "what's the capital of France?", kind: 'offtopic', expect: [noTools, noProductQuestion, noTroubleshooting, replies] },
      { say: 'thanks anyway', kind: 'ack', expect: [noTools, doesNotSay(/can't help|cannot help|outside what i can/i), replies] },
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
    ],
  },
  {
    id: 'final-still-the-same',
    category: 'loops',
    persona: 'alex',
    description: 'The customer answers every step with the same words, past the offer of a support case.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'still the same', kind: 'answer', expect: [recordsOutcome(false), noRepeat(), replies] },
      { say: 'still the same', kind: 'answer', expect: [noRepeat(2), replies] },
      // The offer of a support case is still open and is ignored: a blind search is not an answer to that.
      { say: 'still the same', kind: 'answer', expect: [noLookups, noRepeat(), replies] },
    ],
  },
  {
    id: 'final-ticket-then-warranty-question',
    category: 'escalation',
    persona: 'alex',
    description: 'A ticket on request, then a warranty question that must not open a second one.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'this is ridiculous, open a ticket', kind: 'problem', expect: opensTicket },
      { say: 'can you also check my warranty?', kind: 'problem', expect: [warrantyFor(BP200), never('create_support_case')] },
    ],
  },
  {
    id: 'final-repeat-the-last-step',
    category: 'routing',
    persona: 'alex',
    description: 'The customer asks to hear the step again, then confirms it fixed the problem.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'could you repeat the last step?', kind: 'clarify', expect: [noLookups, replies] },
      { say: 'that worked, thank you', kind: 'confirm', expect: [recordsOutcome(true), noLookups, noTroubleshooting] },
    ],
  },
];
