import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmError, type LlmRequest } from '../server/agent/llm.js';
import { createConversation, runTurn, withData } from '../server/agent/loop.js';
import { SYSTEM_PROMPT } from '../server/agent/prompt.js';
import type { McpConnection, McpTool } from '../server/mcp/client.js';
import { AGENT, callTools, collect, reply, sayThenStop, scriptedLlm, startStack, textBlock, toolUse, type Stack } from './helpers.js';

let stack: Stack;
let alex: McpConnection;
let tools: McpTool[];

beforeAll(async () => {
  stack = await startStack();
  alex = await stack.connect('alex');
  tools = await alex.tools();
});

afterAll(() => stack.close());

const run = (llm: ReturnType<typeof scriptedLlm>, userText = 'my coffee machine is not brewing', options: { mcp?: McpConnection; conversation?: ReturnType<typeof createConversation>; config?: Partial<typeof AGENT>; signal?: AbortSignal } = {}) => {
  const trace = collect();
  const conversation = options.conversation ?? createConversation(tools);
  const result = runTurn({ conversation, userText, llm, mcp: options.mcp ?? alex, config: { ...AGENT, ...options.config }, emit: trace.emit, signal: options.signal });
  return { trace, conversation, result };
};

describe('a turn with no tools', () => {
  it('streams the reply and records the exchange', async () => {
    const llm = scriptedLlm([sayThenStop('Hi, how can I help?')]);
    const { trace, conversation, result } = run(llm, 'hello');
    expect(await result).toMatchObject({ reason: 'end_turn', text: 'Hi, how can I help?', rounds: 1 });
    expect(trace.events.map((event) => event.type)).toEqual(['turn_started', ...Array(5).fill('text_delta'), 'model_call', 'turn_complete']);
    expect(trace.of('text_delta').map((event) => event.text).join('')).toBe('Hi, how can I help?');
    expect(conversation.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [textBlock('Hi, how can I help?')] },
    ]);
    expect(trace.of('model_call')[0]).toMatchObject({ round: 1, stopReason: 'end_turn', model: 'claude-sonnet-5-5' });
    expect(trace.of('model_call')[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it('sends the model, effort, token limit, fallback setting, system prompt and tools it was configured with', async () => {
    const llm = scriptedLlm([sayThenStop('ok')]);
    await run(llm, 'hi', { config: { model: 'claude-haiku-4-5', effort: 'medium', fallback: false, maxTokens: 999 } }).result;
    const request = llm.requests[0]!;
    expect(request).toMatchObject({ model: 'claude-haiku-4-5', effort: 'medium', fallback: false, maxTokens: 999, system: SYSTEM_PROMPT });
    expect(request.tools.map((tool) => tool.name)).toContain('search_troubleshooting');
  });
});

describe('a turn with tools', () => {
  it('runs the tool as the persona and sends the result back with the exact flags in a [data] block', async () => {
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', { category: 'coffee machine' })), sayThenStop('I see your Brew Pro 200.')]);
    const { trace, conversation, result } = run(llm, 'my coffee machine is not brewing');
    expect(await result).toMatchObject({ reason: 'end_turn', text: 'I see your Brew Pro 200.', rounds: 2 });

    const second = llm.history[1]!;
    expect(second).toHaveLength(3);
    const toolResults = second[2]!.content as { type: string; tool_use_id: string; content: string; is_error?: boolean }[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(toolResults[0]!.content).toMatch(/One registered product/);
    expect(toolResults[0]!.content).toMatch(/\[data\] .*"resolution":"one"/);
    expect(toolResults[0]!.is_error).toBeUndefined();

    expect(trace.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn_started', 'model_call', 'tool_call', 'tool_result', 'text_delta', 'turn_complete']),
    );
    const call = trace.of('tool_call')[0]!;
    const resultEvent = trace.of('tool_result')[0]!;
    expect(call).toMatchObject({ name: 'list_owned_products', toolUseId: 't1', round: 1 });
    expect(resultEvent).toMatchObject({ ok: true, round: 1, summary: { headline: 'one: Brew Pro 200' } });
    expect(resultEvent.ms).toBeGreaterThan(0);
    expect(conversation.messages).toHaveLength(4);
  });

  it('answers parallel tool calls together, in one user message, in the order they were asked', async () => {
    const llm = scriptedLlm([
      callTools(toolUse('a', 'list_owned_products', {}), toolUse('b', 'get_product', { product_id: 'brewwell-brew-pro-200' })),
      sayThenStop('done'),
    ]);
    const { trace, result } = run(llm);
    await result;
    const results = llm.history[1]![2]!.content as { tool_use_id: string }[];
    expect(results.map((entry) => entry.tool_use_id)).toEqual(['a', 'b']);
    expect(llm.history[1]!.filter((message) => message.role === 'user' && Array.isArray(message.content))).toHaveLength(1);
    expect(trace.of('tool_call').map((event) => event.toolUseId)).toEqual(['a', 'b']);
    expect(trace.of('tool_result')).toHaveLength(2);
  });

  it('hands a failing tool back to the model as an error result instead of failing the turn', async () => {
    const llm = scriptedLlm([callTools(toolUse('t1', 'get_product', { product_id: 'nope' })), sayThenStop('Sorry, I could not find that.')]);
    const { trace, result } = run(llm);
    expect(await result).toMatchObject({ reason: 'end_turn' });
    const entry = (llm.history[1]![2]!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(entry.is_error).toBe(true);
    expect(entry.content).toMatch(/Unknown product_id/);
    expect(trace.of('tool_result')[0]).toMatchObject({ ok: false, summary: { headline: 'get_product failed', badges: ['error'] } });
  });

  it('does not call a tool whose arguments are not a JSON object', async () => {
    const calls: string[] = [];
    const mcp: McpConnection = { ...alex, callTool: async (name) => (calls.push(name), { ok: true, text: '', ms: 1 }) };
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', 'oops')), sayThenStop('ok')]);
    const { result } = run(llm, 'hi', { mcp });
    await result;
    expect(calls).toEqual([]);
    expect((llm.history[1]![2]!.content as { is_error?: boolean }[])[0]!.is_error).toBe(true);
  });

  it('turns a tool that throws (a dropped connection, a timeout) into an error result', async () => {
    const mcp: McpConnection = { ...alex, callTool: async () => { throw new Error('connection reset'); } };
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', { category: 'coffee machine' })), sayThenStop('I could not check that.')]);
    const { trace, result } = run(llm, 'my coffee machine is not brewing', { mcp });
    expect(await result).toMatchObject({ reason: 'end_turn' });
    expect(trace.of('tool_result')[0]).toMatchObject({ ok: false });
    expect((llm.history[1]![2]!.content as { content: string }[])[0]!.content).toMatch(/connection reset/);
  });

  it('shows citations from a real search in the trace', async () => {
    const llm = scriptedLlm([callTools(toolUse('t1', 'search_troubleshooting', { query: 'needle clogged', product_id: 'brewwell-brew-pro-200' })), sayThenStop('Try cleaning the needle.')]);
    const { trace, result } = run(llm);
    await result;
    const summary = trace.of('tool_result')[0]!.summary;
    expect(summary.headline).toMatch(/results, confidence/);
    expect(summary.citations.length).toBeGreaterThan(0);
    expect(summary.citations[0]!.uri).toMatch(/^doc:\/\/\d+#p\d+$/);
  });

  it('shows the model the data block but strips long passages already in the text', () => {
    const long = 'x'.repeat(200);
    const out = withData('readable', { confidence: 'high', results: [{ text: long, document_id: 3, page: 2 }] });
    expect(out).toMatch(/^readable\n\n\[data\] /);
    expect(out).toContain('"document_id":3');
    expect(out).not.toContain(long);
    expect(withData('', undefined)).toBe('(no output)');
  });
});

describe('MCP App results', () => {
  it('announces the ui:// resource when a tool linked to one succeeds', async () => {
    const withUi: McpTool[] = tools.map((tool) => (tool.name === 'list_owned_products' ? { ...tool, uiResourceUri: 'ui://ticket/card.html' } : tool));
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', { category: 'coffee machine' })), sayThenStop('ok')]);
    const { trace, result } = run(llm, 'my coffee machine is not brewing', { conversation: createConversation(withUi) });
    await result;
    expect(trace.of('ui_resource')).toEqual([
      {
        type: 'ui_resource',
        turnId: expect.any(String),
        toolUseId: 't1',
        uri: 'ui://ticket/card.html',
        toolName: 'list_owned_products',
        input: { category: 'coffee machine' },
        result: { text: expect.stringMatching(/One registered product/), structuredContent: expect.objectContaining({ resolution: 'one' }) },
      },
    ]);
  });

  it('does not announce one for a failed call', async () => {
    const withUi: McpTool[] = tools.map((tool) => (tool.name === 'get_product' ? { ...tool, uiResourceUri: 'ui://x' } : tool));
    const llm = scriptedLlm([callTools(toolUse('t1', 'get_product', { product_id: 'nope' })), sayThenStop('ok')]);
    const { trace, result } = run(llm, 'hi', { conversation: createConversation(withUi) });
    await result;
    expect(trace.of('ui_resource')).toEqual([]);
  });
});

describe('MCP App results from a server that has the card built', () => {
  it('announces the ticket card, with the call input and the structured ticket the view renders', async () => {
    const cardStack = await startStack({ ticketCardHtml: '<!doctype html><html><body>card</body></html>' });
    try {
      const mcp = await cardStack.connect('alex');
      const cardTools = await mcp.tools();
      expect(cardTools.find((tool) => tool.name === 'create_support_case')?.uiResourceUri).toBe('ui://resolveai/ticket-card.html');
      const llm = scriptedLlm([
        callTools(toolUse('r1', 'record_diagnostic_step', { kind: 'step', content: 'Cleaned the needle', product_id: 'brewwell-brew-pro-200', symptom: 'drips', new_case: true })),
        callTools(toolUse('c1', 'create_support_case', { summary: 'Still dripping after cleaning the needle.' })),
        sayThenStop('Your ticket is open.'),
      ]);
      const trace = collect();
      await runTurn({ conversation: createConversation(cardTools), userText: 'open a case', llm, mcp, config: AGENT, emit: trace.emit });
      const [card] = trace.of('ui_resource');
      expect(card).toMatchObject({ toolUseId: 'c1', toolName: 'create_support_case', uri: 'ui://resolveai/ticket-card.html', input: { summary: 'Still dripping after cleaning the needle.' } });
      expect(card!.result.structuredContent).toMatchObject({ simulated: true, product: { model: 'Brew Pro 200' } });
      expect(card!.result.text).toMatch(/Support ticket created/);
      // The model still gets the ordinary text result, not the card.
      expect(JSON.stringify(llm.history[2])).toMatch(/Support ticket created/);
    } finally {
      await cardStack.close();
    }
  });
});

describe('a turn that cannot finish', () => {
  it('stops after the round limit and drops the unfinished turn from the history', async () => {
    const llm = scriptedLlm([callTools(toolUse('t', 'list_owned_products', {}))]);
    const { trace, conversation, result } = run(llm, 'loop forever', { config: { maxRounds: 3 } });
    expect(await result).toMatchObject({ reason: 'max_rounds', rounds: 3 });
    expect(llm.requests).toHaveLength(3);
    expect(conversation.messages).toEqual([]);
    expect(trace.of('turn_complete')[0]!.reason).toBe('max_rounds');
  });

  it.each(['max_tokens', 'refusal'] as const)('drops a turn the model cut off or declined (%s) and says why', async (stopReason) => {
    const llm = scriptedLlm([reply([textBlock('partial')], stopReason)]);
    const { trace, conversation, result } = run(llm);
    expect(await result).toMatchObject({ reason: stopReason, text: '' });
    expect(conversation.messages).toEqual([]);
    expect(trace.of('turn_complete')[0]!.reason).toBe(stopReason);
  });

  it('reports a rate limit as a retryable error and leaves the history as it was', async () => {
    const llm = scriptedLlm([() => { throw new LlmError('rate_limit', 'Rate limited by the Anthropic API', 429); }]);
    const { trace, conversation, result } = run(llm);
    expect(await result).toMatchObject({ reason: 'error' });
    expect(trace.of('error')).toEqual([{ type: 'error', turnId: expect.any(String), message: 'Rate limited by the Anthropic API', retryable: true }]);
    expect(conversation.messages).toEqual([]);
  });

  it('reports a rejected credential as not retryable', async () => {
    const llm = scriptedLlm([() => { throw new LlmError('auth', 'The Anthropic credential was rejected', 401); }]);
    const { trace, result } = run(llm);
    await result;
    expect(trace.of('error')[0]!.retryable).toBe(false);
  });

  it('stops quietly when cancelled, and drops the turn', async () => {
    const controller = new AbortController();
    const llm = scriptedLlm([async () => { controller.abort(); return callTools(toolUse('t', 'list_owned_products', {})); }]);
    const { trace, conversation, result } = run(llm, 'hi', { signal: controller.signal });
    expect(await result).toMatchObject({ reason: 'aborted' });
    expect(conversation.messages).toEqual([]);
    expect(trace.of('error')).toEqual([]);
  });

  it('does not commit a reply that arrived after the turn was cancelled', async () => {
    const controller = new AbortController();
    const llm = scriptedLlm([async () => { controller.abort(); return sayThenStop('too late'); }]);
    const { conversation, result } = run(llm, 'hi', { signal: controller.signal });
    expect(await result).toMatchObject({ reason: 'aborted', text: '' });
    expect(conversation.messages).toEqual([]);
  });

  it('refuses a turn past the session limit without calling the model', async () => {
    const llm = scriptedLlm([sayThenStop('ok')]);
    const conversation = createConversation(tools);
    for (let turn = 0; turn < 2; turn++) await run(llm, `turn ${turn}`, { conversation, config: { maxTurnsPerSession: 2 } }).result;
    const calls = llm.requests.length;
    const { trace, result } = run(llm, 'one too many', { conversation, config: { maxTurnsPerSession: 2 } });
    expect(await result).toMatchObject({ reason: 'error', rounds: 0 });
    expect(llm.requests).toHaveLength(calls);
    expect(trace.of('error')[0]!.message).toMatch(/limit of 2 turns/);
  });

  it('a failed turn does not poison the next one', async () => {
    const llm = scriptedLlm([() => { throw new LlmError('overloaded', 'busy', 529); }, sayThenStop('back again')]);
    const conversation = createConversation(tools);
    await run(llm, 'first', { conversation }).result;
    const second = await run(llm, 'second', { conversation }).result;
    expect(second).toMatchObject({ reason: 'end_turn', text: 'back again' });
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[0]).toEqual({ role: 'user', content: 'second' });
  });
});

describe('append-only history and a stable prefix', () => {
  it('never changes earlier messages once later turns are added, thinking blocks included', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
    const llm = scriptedLlm([
      reply([thinking, toolUse('t1', 'list_owned_products', { category: 'coffee machine' })], 'tool_use'),
      reply([thinking, textBlock('You have one machine.')]),
      sayThenStop('Sure.'),
      callTools(toolUse('t2', 'get_product', { product_id: 'brewwell-brew-pro-200' })),
      sayThenStop('Done.'),
    ]);
    const conversation = createConversation(tools);
    await run(llm, 'first', { conversation }).result;
    const afterFirst = JSON.stringify(conversation.messages);
    await run(llm, 'second', { conversation }).result;
    await run(llm, 'third', { conversation }).result;
    expect(JSON.stringify(conversation.messages).startsWith(afterFirst.slice(0, -1))).toBe(true);
    // The assistant blocks went back exactly as received, thinking block and all.
    expect(conversation.messages[1]).toEqual({ role: 'assistant', content: [thinking, toolUse('t1', 'list_owned_products', { category: 'coffee machine' })] });
    // And every request the model saw began with what it had seen before.
    for (let index = 1; index < llm.history.length; index++) {
      const previous = JSON.stringify(llm.history[index - 1]).slice(0, -1);
      expect(JSON.stringify(llm.history[index]).startsWith(previous) || llm.history[index]!.length < llm.history[index - 1]!.length).toBe(true);
    }
  });

  it('sends the same system prompt and tool list on every call of every turn', async () => {
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', { category: 'coffee machine' })), sayThenStop('a'), sayThenStop('b')]);
    const conversation = createConversation(tools);
    await run(llm, 'one', { conversation }).result;
    await run(llm, 'two', { conversation }).result;
    const seen = (select: (request: LlmRequest) => unknown) => new Set(llm.requests.map((request) => JSON.stringify(select(request))));
    expect(seen((request) => request.system).size).toBe(1);
    expect(seen((request) => request.tools).size).toBe(1);
  });

  it('keeps the system prompt free of anything that varies per user or per day', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\bAlex\b/);
    expect(SYSTEM_PROMPT).not.toContain('—');
  });
});
