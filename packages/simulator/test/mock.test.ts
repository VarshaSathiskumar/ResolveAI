import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, runTurn } from '../server/agent/loop.js';
import { createMockLlm } from '../server/agent/mock.js';
import { AGENT, collect, startStack, type Stack } from './helpers.js';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => stack.close());

/** One customer line against the mock agent and the real tools. */
async function ask(persona: 'alex', text: string) {
  const mcp = await stack.connect(persona);
  const trace = collect();
  const result = await runTurn({ conversation: createConversation(await mcp.tools()), userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: AGENT, emit: trace.emit });
  return { result, tools: trace.of('tool_call').map((event) => event.name), trace };
}

/** Several customer lines in one conversation, with the tools and reply of each. */
async function chat(persona: 'alex', lines: string[]) {
  const mcp = await stack.connect(persona);
  const conversation = createConversation(await mcp.tools());
  const turns: { tools: string[]; queries: unknown[]; text: string }[] = [];
  for (const text of lines) {
    const trace = collect();
    const result = await runTurn({ conversation, userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: AGENT, emit: trace.emit });
    turns.push({ tools: trace.of('tool_call').map((event) => event.name), queries: trace.of('tool_call').map((event) => (event.input as { query?: unknown }).query), text: result.text });
  }
  return turns;
}

describe('mock agent (offline demo mode)', () => {
  it('records the step that did not help, so the support case lists what was tried', async () => {
    const mcp = await stack.connect('alex');
    const conversation = createConversation(await mcp.tools());
    const turns: ReturnType<typeof collect>[] = [];
    for (const text of ["my coffee machine isn't brewing, only drops come out", "didn't work", 'nope', 'yes please']) {
      const trace = collect();
      await runTurn({ conversation, userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: AGENT, emit: trace.emit });
      turns.push(trace);
    }
    const recorded = turns[1]!.of('tool_call').filter((event) => event.name === 'record_diagnostic_step').map((event) => (event.input as { kind: string }).kind);
    expect(recorded).toEqual(['step', 'outcome']);
    const ticket = turns.at(-1)!.of('tool_result').find((event) => event.name === 'create_support_case')!;
    expect(ticket.summary.badges.join(' ')).not.toMatch(/No troubleshooting steps/);
  });

  it('a no to "anything else?" after a declined support case closes politely, without re-offering the case', async () => {
    const turns = await chat('alex', ["my coffee machine isn't brewing, only drops come out", "didn't work", "that did not help either", 'no', 'no']);
    const last = turns.at(-1)!;
    expect(last.tools).toEqual([]);
    expect(last.text).not.toMatch(/support case|sorry|covered/i);
  });

  it('Alex has one machine: resolves it without asking and answers from the manual with the source', async () => {
    const { result, tools, trace } = await ask('alex', "my coffee machine isn't brewing, only drops come out");
    expect(tools).toEqual(['list_owned_products', 'search_troubleshooting']);
    expect(result.reason).toBe('end_turn');
    expect(result.text).toMatch(/That is from .*Brew Pro 200.*page \d/);
    expect(trace.of('tool_result').at(-1)!.summary.citations.length).toBeGreaterThan(0);
  });

  it('checks the warranty of the one machine Alex owns', async () => {
    const { result, tools } = await ask('alex', 'is my machine still under warranty?');
    expect(tools).toEqual(['list_owned_products', 'check_warranty']);
    expect(result.text).toMatch(/covered until 2028-03-14/);
  });

  it('says it cannot find it, and asks for a code, when the documentation does not cover the question', async () => {
    const { result } = await ask('alex', 'the wifi will not connect to the app');
    expect(result.text).toMatch(/couldn't find that in your documentation/);
  });

  it('tells a customer who mentions smoke to unplug it and contact support, without any tools', async () => {
    const { result, tools } = await ask('alex', 'there is smoke coming from my machine');
    expect(tools).toEqual([]);
    expect(result.text).toMatch(/unplug it only if that is safe/);
  });

  it('opens a support case when asked: records the step, files the ticket, reads the reference back', async () => {
    const { result, tools } = await ask('alex', 'that did not work, please open a support case');
    expect(tools).toEqual(['list_owned_products', 'record_diagnostic_step', 'create_support_case']);
    expect(result.text).toMatch(/I have opened support case RAI-\d{4}-\d{6}/);
  });

  it('can be cancelled mid-reply', async () => {
    const mcp = await stack.connect('alex');
    const controller = new AbortController();
    const trace = collect();
    const pending = runTurn({ conversation: createConversation(await mcp.tools()), userText: 'hello there', llm: createMockLlm({ delayMs: 20 }), mcp, config: AGENT, emit: trace.emit, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect((await pending).reason).toBe('aborted');
  });

});
