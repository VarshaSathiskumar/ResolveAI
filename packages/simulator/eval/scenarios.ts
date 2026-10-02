import type { Scenario } from './harness.js';
import {
  BP200, never, noLookups, noProductQuestion, noRepeat, noTicket, noTools, noTroubleshooting, offersSupport, opensTicket, queryMentions,
  recordsOutcome, replies, restatesPrevious, says, searches, warrantyFor,
} from './checks.js';

const PROBLEM = "my coffee machine isn't brewing, only drops come out";

export const SCENARIOS: Scenario[] = [
  // Context retention: the machine and the problem, once established, are not asked for again.
  {
    id: 'warranty-then-descale-same-machine',
    category: 'context',
    persona: 'alex',
    description: 'Alex states a problem, then asks about warranty and descaling without naming the machine again.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'is it still under warranty?', kind: 'problem', expect: [warrantyFor(BP200), never('list_owned_products', 'identify_product'), noProductQuestion] },
      { say: 'and how do I descale it?', kind: 'problem', expect: [searches(BP200), queryMentions(/descal/i), never('list_owned_products', 'identify_product'), noProductQuestion] },
    ],
  },
  {
    id: 'answer-adds-to-the-symptom',
    category: 'context',
    persona: 'alex',
    description: 'A vague complaint gets a diagnostic question; the answer is searched together with the complaint.',
    turns: [
      { say: 'my machine is not working', kind: 'problem', expect: [replies] },
      { say: 'the amber light is blinking and the flow is slow', kind: 'answer', expect: [searches(BP200), queryMentions(/amber/i), noProductQuestion] },
    ],
  },

  // Intent routing: lines that carry no new problem do not start a search.
  {
    id: 'acknowledgements-need-no-tools',
    category: 'routing',
    persona: 'alex',
    description: 'Short acknowledgements and thanks after an answer.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'ok', kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
      { say: 'thanks', kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
      { say: 'got it, bye', kind: 'ack', expect: [noTools, noTroubleshooting, replies] },
    ],
  },
  {
    id: 'confirmation-closes-the-case',
    category: 'routing',
    persona: 'alex',
    description: 'The customer says the step fixed it.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'yes that fixed it, thank you', kind: 'confirm', expect: [recordsOutcome(true), noLookups, noTroubleshooting, replies] },
      { say: 'thanks again', kind: 'ack', expect: [noTools, noTroubleshooting] },
    ],
  },
  {
    id: 'repeat-request-needs-no-search',
    category: 'routing',
    persona: 'alex',
    description: 'The customer asks to hear the last answer again.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'sorry, can you say that again?', kind: 'clarify', expect: [noLookups, restatesPrevious, replies] },
    ],
  },

  // Out of scope: unrelated lines stay out of the troubleshooting flow.
  {
    id: 'off-topic-mid-conversation',
    category: 'scope',
    persona: 'alex',
    description: 'An unrelated question in the middle of troubleshooting, then back to the machine.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'who won the football game last night?', kind: 'offtopic', expect: [noTools, noProductQuestion, noTroubleshooting, replies] },
      { say: 'ok back to the machine, it still only drips', kind: 'problem', expect: [searches(BP200), noProductQuestion] },
    ],
  },

  // Troubleshooting memory: the steps already given and their outcomes are tracked.
  {
    id: 'failed-step-is-not-repeated',
    category: 'memory',
    persona: 'alex',
    description: 'The first step does not work; the agent moves on instead of repeating it.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: 'I did that and nothing changed', kind: 'answer', expect: [recordsOutcome(false), noRepeat(), replies, noProductQuestion] },
      { say: 'still nothing, I tried that too', kind: 'answer', expect: [noRepeat(2), replies, noProductQuestion] },
    ],
  },

  // Loops: the same thing is not said or run twice for no reason.
  {
    id: 'same-complaint-three-times',
    category: 'loops',
    persona: 'alex',
    description: 'The customer repeats the same complaint; the agent must change course, not echo itself.',
    turns: [
      { say: 'it still will not brew', kind: 'problem', expect: [replies] },
      { say: 'it still will not brew', kind: 'problem', expect: [noRepeat(), replies] },
      { say: 'it still will not brew', kind: 'problem', expect: [noRepeat(2), offersSupport] },
    ],
  },
  {
    id: 'no-answer-twice',
    category: 'loops',
    persona: 'alex',
    description: 'The customer cannot answer the diagnostic question twice; the agent stops asking it.',
    turns: [
      { say: 'my machine is not working', kind: 'problem', expect: [replies] },
      { say: "I don't know", kind: 'answer', expect: [noRepeat(), replies] },
      { say: 'no idea', kind: 'answer', expect: [noRepeat(2), offersSupport] },
    ],
  },


  // Escalation: a support case follows an explicit request or an agreed offer, never silently.
  {
    id: 'explicit-case-request',
    category: 'escalation',
    persona: 'alex',
    description: 'The customer asks for a support case outright.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: "that's not working, please open a support case", kind: 'problem', expect: opensTicket },
      { say: 'thanks', kind: 'ack', expect: [noTools, noTroubleshooting, ...noTicket] },
    ],
  },
  {
    id: 'offer-then-accept',
    category: 'escalation',
    persona: 'alex',
    description: 'Two steps fail; the agent offers a case, waits for a yes, then opens it.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: "didn't work", kind: 'answer', expect: [replies] },
      { say: 'still nothing', kind: 'answer', expect: [offersSupport, ...noTicket] },
      { say: 'yes please', kind: 'confirm', expect: [...opensTicket, noLookups] },
    ],
  },
  {
    id: 'offer-then-decline',
    category: 'escalation',
    persona: 'alex',
    description: 'The same offer is declined; no case is opened.',
    turns: [
      { say: PROBLEM, kind: 'problem', expect: [searches(BP200)] },
      { say: "didn't work", kind: 'answer', expect: [replies] },
      { say: 'still nothing', kind: 'answer', expect: [offersSupport, ...noTicket] },
      { say: 'no thanks', kind: 'confirm', expect: [...noTicket, noLookups, noTroubleshooting, replies] },
    ],
  },
];
