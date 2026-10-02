import type { Scenario } from './harness.js';
import {
  BP200, never, noLookups, noProductQuestion, noRepeat, noTicket, noTools, noTroubleshooting, offersSupport, opensTicket, recordsOutcome,
  replies, searches, warrantyFor,
} from './checks.js';

/**
 * A second set, written once the first one passed, with other phrasings and a few lines the first never tried. Its first
 * run showed gaps in the intent rules, and those were fixed, so it is no longer a fair check: it is a record of what the
 * first set missed. The third set (scenarios.final.ts) was written after those fixes and run once.
 */
export const SECOND: Scenario[] = [
  {
    id: 'second-side-question-then-warranty',
    category: 'context',
    persona: 'alex',
    description: 'A side question about a part and then warranty, never naming the machine again.',
    turns: [
      { say: "Hi, my Brewwell machine keeps showing a red light and won't make coffee", kind: 'problem', expect: [searches(BP200)] },
      { say: 'where is the water tank on it?', kind: 'problem', expect: [searches(BP200), never('identify_product', 'list_owned_products'), noProductQuestion] },
      { say: 'and do I still have warranty on it?', kind: 'problem', expect: [warrantyFor(BP200), noProductQuestion] },
    ],
  },
  {
    id: 'second-intent-to-act-is-not-a-request',
    category: 'routing',
    persona: 'alex',
    description: 'The customer says they will try the step, then thanks the agent.',
    turns: [
      { say: 'the amber light keeps blinking and the coffee comes out slowly', kind: 'problem', expect: [searches(BP200)] },
      { say: "alright, I'll try that", kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
      { say: 'perfect, thank you!', kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
    ],
  },
  {
    id: 'second-greeting-then-fixed-then-new-problem',
    category: 'routing',
    persona: 'alex',
    description: 'A greeting, a problem, a fix, and a different problem in the same conversation.',
    turns: [
      { say: 'Hello', kind: 'ack', expect: [noTools, replies] },
      { say: "my coffee machine won't brew, only drops come out", kind: 'problem', expect: [searches(BP200)] },
      { say: 'yeah it worked', kind: 'confirm', expect: [recordsOutcome(true), noLookups, noTroubleshooting] },
      { say: 'actually now it leaks from the bottom as well', kind: 'problem', expect: [searches(BP200), noProductQuestion] },
    ],
  },
  {
    id: 'second-same-question-twice',
    category: 'loops',
    persona: 'alex',
    description: 'The customer asks the same question twice in the same words.',
    turns: [
      { say: 'how do I descale it?', kind: 'problem', expect: [searches(BP200)] },
      { say: 'how do I descale it?', kind: 'problem', expect: [noRepeat(), replies] },
    ],
  },
  {
    id: 'second-fixed-then-new-problem-keeps-history-apart',
    category: 'memory',
    persona: 'alex',
    description: 'A step fails, another works, and a later problem does not inherit the old steps.',
    turns: [
      { say: "my coffee machine won't brew, only drops come out", kind: 'problem', expect: [searches(BP200)] },
      { say: 'tried it, no luck', kind: 'answer', expect: [recordsOutcome(false), noRepeat(), replies] },
      { say: 'ok that worked!', kind: 'confirm', expect: [recordsOutcome(true), noLookups] },
    ],
  },
  {
    id: 'second-ask-for-a-human',
    category: 'escalation',
    persona: 'alex',
    description: 'The customer asks for a person.',
    turns: [
      { say: 'my machine shows an E01 error', kind: 'problem', expect: [searches(BP200)] },
      { say: "this isn't helping, can I talk to a human?", kind: 'problem', expect: opensTicket },
    ],
  },
  {
    id: 'second-decline-with-different-words',
    category: 'escalation',
    persona: 'alex',
    description: 'The offer of a support case is turned down with "not now".',
    turns: [
      { say: "my coffee machine won't brew, only drops come out", kind: 'problem', expect: [searches(BP200)] },
      { say: 'no change', kind: 'answer', expect: [replies] },
      { say: 'nothing again', kind: 'answer', expect: [offersSupport, ...noTicket] },
      { say: 'not now, thanks', kind: 'confirm', expect: [...noTicket, noLookups, noTroubleshooting, replies] },
    ],
  },
];
