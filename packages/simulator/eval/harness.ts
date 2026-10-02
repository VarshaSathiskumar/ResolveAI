import { createConversation, runTurn } from '../server/agent/loop.js';
import { createMockLlm } from '../server/agent/mock.js';
import type { LlmClient } from '../server/agent/llm.js';
import type { SimConfig } from '../server/config.js';
import type { TraceEvent } from '../shared/events.js';
import type { Stack } from '../test/helpers.js';

export type Persona = 'alex';

/**
 * What the customer's line is, known by the author of the scenario. The eval uses it to count retrieval spent on lines
 * that need none; the agent never sees it.
 */
export type TurnKind = 'problem' | 'answer' | 'switch' | 'ack' | 'confirm' | 'clarify' | 'offtopic';

export const NON_PROBLEM: TurnKind[] = ['ack', 'confirm', 'clarify', 'offtopic'];

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
}

export interface TurnRecord {
  say: string;
  kind: TurnKind;
  reply: string;
  /** Tool calls that ran. */
  calls: ToolCall[];
  /** Tool calls the loop answered itself (not needed, or a repeat), so they never reached the server. */
  skipped: ToolCall[];
  rounds: number;
  reason: string;
}

export interface Check {
  name: string;
  test(turn: TurnRecord, history: TurnRecord[]): boolean;
}

export interface ScenarioTurn {
  say: string;
  kind: TurnKind;
  expect?: Check[];
}

export interface Scenario {
  id: string;
  category: Category;
  persona: Persona;
  description: string;
  turns: ScenarioTurn[];
}

export const CATEGORIES = ['context', 'routing', 'scope', 'memory', 'loops', 'switching', 'escalation'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CheckResult {
  turn: number;
  name: string;
  passed: boolean;
}

export interface ScenarioRun {
  scenario: Scenario;
  turns: TurnRecord[];
  checks: CheckResult[];
}

/** Roomy limits: the eval is about behavior, not the spend guards. */
export const EVAL_AGENT: SimConfig['agent'] = {
  model: 'mock-agent',
  effort: 'low',
  fallback: false,
  maxTokens: 8192,
  maxRounds: 8,
  maxTurnsPerSession: 50,
};

export async function runScenario(stack: Stack, scenario: Scenario, llm: LlmClient = createMockLlm({ delayMs: 0 })): Promise<ScenarioRun> {
  const mcp = await stack.connect(scenario.persona);
  const conversation = createConversation(await mcp.tools());
  const turns: TurnRecord[] = [];
  const checks: CheckResult[] = [];

  for (const [index, line] of scenario.turns.entries()) {
    const events: TraceEvent[] = [];
    const result = await runTurn({ conversation, userText: line.say, llm, mcp, config: EVAL_AGENT, emit: (event) => void events.push(event) });
    const results = new Map(events.flatMap((event) => (event.type === 'tool_result' ? [[event.toolUseId, event] as const] : [])));
    const all = events.flatMap((event) =>
      event.type === 'tool_call'
        ? [{ call: { name: event.name, input: (event.input ?? {}) as Record<string, unknown>, ok: results.get(event.toolUseId)?.ok ?? false }, skipped: results.get(event.toolUseId)?.skipped }]
        : [],
    );
    const record: TurnRecord = {
      say: line.say,
      kind: line.kind,
      reply: result.text,
      calls: all.filter((entry) => !entry.skipped).map((entry) => entry.call),
      skipped: all.filter((entry) => entry.skipped).map((entry) => entry.call),
      rounds: result.rounds,
      reason: result.reason,
    };
    turns.push(record);
    for (const check of line.expect ?? []) {
      checks.push({ turn: index + 1, name: check.name, passed: check.test(record, turns.slice(0, -1)) });
    }
  }
  return { scenario, turns, checks };
}
