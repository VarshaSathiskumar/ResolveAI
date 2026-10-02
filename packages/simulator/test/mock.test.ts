import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, runTurn } from '../server/agent/loop.js';
import { createMockLlm } from '../server/agent/mock.js';
import { questionKind } from '../server/agent/context.js';
import { MAX_FOLLOW_UPS } from '../../../config.js';
import { AGENT, collect, startStack, type Stack } from './helpers.js';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => stack.close());

/** One customer line against the mock agent and the real tools. */
async function ask(persona: 'alex' | 'raj' | 'nate', text: string) {
  const mcp = await stack.connect(persona);
  const trace = collect();
  const result = await runTurn({ conversation: createConversation(await mcp.tools()), userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: AGENT, emit: trace.emit });
  return { result, tools: trace.of('tool_call').map((event) => event.name), trace };
}

/** Several customer lines in one conversation, with the tools and reply of each. */
async function chat(persona: 'alex' | 'raj' | 'nate', lines: string[], maxTurns?: number) {
  const mcp = await stack.connect(persona);
  const conversation = createConversation(await mcp.tools());
  const turns: { tools: string[]; queries: unknown[]; products: unknown[]; text: string; streamed: string }[] = [];
  for (const text of lines) {
    const trace = collect();
    const result = await runTurn({ conversation, userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: maxTurns ? { ...AGENT, maxTurnsPerSession: maxTurns } : AGENT, emit: trace.emit });
    turns.push({ tools: trace.of('tool_call').map((event) => event.name), queries: trace.of('tool_call').map((event) => (event.input as { query?: unknown }).query), products: trace.of('tool_call').map((event) => (event.input as { product_id?: unknown }).product_id), text: result.text, streamed: trace.of('text_delta').map((event) => event.text).join('') });
  }
  return turns;
}

describe('mock agent with Alex (eleven products, a vague "it is slow")', () => {
  const PIXEL = 'google-pixel-9';
  const BREW = 'brewwell-brew-pro-200';
  const LAPTOP = 'nimbus-laptop-14';

  it('asks which product is slow, naming only the ones whose guides can be slow', async () => {
    const turns = await chat('alex', ["it's slow"]);
    expect(turns[0]!.tools).toEqual(['list_owned_products', 'find_products_by_symptom']);
    expect(turns[0]!.text).toMatch(/Which one is slow, your phone \(Pixel 9\), your coffee machine \(Brew Pro 200\) or your laptop \(Air 14\)\?/);
    expect(turns[0]!.text).not.toMatch(/storage box|towel|lamp|umbrella|backpack|mat|cutlery|bottle/i);
  });

  it('looks at only the product he names', async () => {
    const turns = await chat('alex', ["it's slow", 'the laptop']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[1]!.products).toEqual([LAPTOP]);
  });

  it('takes the products one at a time when he says all three', async () => {
    const turns = await chat('alex', ["it's slow", 'all 3']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[1]!.products).toEqual([PIXEL]);
    expect(turns[1]!.streamed).toMatch(/one at a time, starting with your phone \(Pixel 9\)/);
  });

  it('remembers where he is: the next product, then the one after, then the end', async () => {
    const turns = await chat('alex', ["it's slow", 'all 3', "didn't work", 'move to next product', 'move to next product', 'move to next product'], 20);
    expect(turns[2]!.products.every((product) => product === PIXEL)).toBe(true);
    expect(turns[3]!.products[0]).toBe(BREW);
    expect(turns[3]!.streamed).toMatch(/Moving on to your coffee machine \(Brew Pro 200\)/);
    expect(turns[4]!.products[0]).toBe(LAPTOP);
    expect(turns[4]!.streamed).toMatch(/Moving on to your laptop \(Air 14\)/);
    expect(turns[5]!.tools).toEqual([]);
    expect(turns[5]!.text).toMatch(/last one/);
  });

  it('searches each product with the original complaint, not with "move to next product"', async () => {
    const turns = await chat('alex', ["it's slow", 'all three', 'next product'], 20);
    expect(turns[2]!.queries).toEqual(["it's slow"]);
  });

  it('carries on from the product he picked when he asks for the next one', async () => {
    const turns = await chat('alex', ["it's slow", 'phone', 'next product'], 20);
    expect(turns[1]!.products).toEqual([PIXEL]);
    expect(turns[2]!.products).toEqual([BREW]);
  });

  it('still resolves "my coffee machine" without asking, though he owns eleven products', async () => {
    const turns = await chat('alex', ["my coffee machine isn't brewing, only drops come out"]);
    expect(turns[0]!.tools).toEqual(['list_owned_products', 'search_troubleshooting']);
    expect(turns[0]!.products).toEqual([undefined, BREW]);
  });
});

describe('mock agent with Nate (a Pixel 9 and vague complaints)', () => {
  /** The last question of a reply that asks the customer for a detail, if it does. */
  const detailQuestion = (text: string): string | undefined => {
    const last = text.split(/(?<=[.!?])\s+/).at(-1) ?? '';
    return last.endsWith('?') && questionKind(last) === 'detail' ? last : undefined;
  };

  it('asks a follow-up question about a vague complaint instead of guessing a fix', async () => {
    const turns = await chat('nate', ['my phone is acting up']);
    expect(turns[0]!.tools).toEqual(['list_owned_products', 'search_troubleshooting']);
    expect(detailQuestion(turns[0]!.text)).toBeDefined();
    expect(turns[0]!.text).not.toMatch(/That is from/);
  });

  it('searches again with each answer, then gives a step once the page is clear', async () => {
    const turns = await chat('nate', ['my phone is acting up', 'charging', 'with the cable']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[1]!.queries[0]).toMatch(/acting up.*charging/);
    expect(detailQuestion(turns[1]!.text)).toBeDefined();
    expect(turns[2]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[2]!.text).toMatch(/USB-C cable.*That is from Google Pixel 9 Troubleshooting Guide, page 2/);
  });

  it('gives the step straight away when the complaint already names the page', async () => {
    const turns = await chat('nate', ['the screen is flickering']);
    expect(turns[0]!.text).toMatch(/screen protector.*That is from Google Pixel 9 Troubleshooting Guide/);
  });

  it('asks at most five follow-up questions, then offers a support case', async () => {
    const turns = await chat('nate', ['my phone is weird', 'its just weird', 'still weird', 'hard to say', 'nothing in particular', 'same', 'whatever'], 20);
    expect(turns.filter((turn) => detailQuestion(turn.text)).length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    expect(turns.some((turn) => /support case/.test(turn.text))).toBe(true);
  });

  it('says so when he names something the documentation never mentions, instead of asking more questions', async () => {
    const turns = await chat('nate', ['not working', 'camera not working']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting', 'check_warranty']);
    expect(turns[1]!.streamed).toMatch(/couldn't find "camera" in your documentation/);
    expect(turns[1]!.text).toMatch(/support case/);
    expect(detailQuestion(turns[1]!.text)).toBeUndefined();
  });

  it('knows his phone is covered', async () => {
    const turns = await chat('nate', ['is my phone still under warranty?']);
    expect(turns[0]!.text).toMatch(/covered until 2027-09-05/);
  });
});

describe('mock agent with Raj (two machines, one out of warranty)', () => {
  it('asks which machine he means instead of guessing', async () => {
    const { result, tools } = await ask('raj', "the milk from my coffee machine is not frothing");
    expect(tools).toEqual(['list_owned_products']);
    expect(result.text).toMatch(/Which one is it/);
    expect(result.text).toMatch(/Brew Pro 300/);
    expect(result.text).toMatch(/Espresso Studio ES-1/);
  });

  it('carries on with the machine he picks', async () => {
    const turns = await chat('raj', ["the milk from my coffee machine is not frothing", 'the brew pro 300']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[1]!.text).toMatch(/That is from .*Brew Pro 300/);
  });

  it('tells him the warranty on the Brew Pro 300 has expired', async () => {
    const turns = await chat('raj', ['is my machine still under warranty?', 'the brew pro 300']);
    expect(turns[1]!.tools).toEqual(['check_warranty']);
    expect(turns[1]!.text).toMatch(/warranty ended on 2025-06-20/);
  });

  it('checks the warranty of both machines when he says both', async () => {
    const turns = await chat('raj', ['is my machine still under warranty?', 'both']);
    expect(turns[1]!.tools).toEqual(['check_warranty', 'check_warranty']);
    expect(turns[1]!.text).toMatch(/Brew Pro 300: warranty ended on 2025-06-20/);
    expect(turns[1]!.text).toMatch(/Espresso Studio ES-1: covered until 2028-08-15/);
  });

  it('reads "check for both the models" as the same answer, not as off topic', async () => {
    const turns = await chat('raj', ['is my machine still under warranty?', 'check for both the models']);
    expect(turns[1]!.tools).toEqual(['check_warranty', 'check_warranty']);
    expect(turns[1]!.text).not.toMatch(/outside what I can help with/);
  });

  it('takes the machines one at a time for a problem', async () => {
    const turns = await chat('raj', ['the milk from my coffee machine is not frothing', 'both']);
    expect(turns[1]!.tools).toEqual(['search_troubleshooting']);
    expect(turns[1]!.streamed).toMatch(/one at a time, starting with the/);
  });

  it('names the machine when asked which device it is for', async () => {
    const turns = await chat('raj', ['the milk from my coffee machine is not frothing', 'the brew pro 300', 'for which device is this?']);
    expect(turns[2]!.tools).toEqual([]);
    expect(turns[2]!.text).toMatch(/Brew Pro 300/);
  });

  it('files a case on the expired machine and warns that a repair is not covered', async () => {
    const mcp = await stack.connect('raj');
    const conversation = createConversation(await mcp.tools());
    const turns: ReturnType<typeof collect>[] = [];
    const texts: string[] = [];
    for (const text of ["the milk from my coffee machine is not frothing", 'the brew pro 300', "didn't work", 'nope', 'yes please']) {
      const trace = collect();
      const result = await runTurn({ conversation, userText: text, llm: createMockLlm({ delayMs: 0 }), mcp, config: AGENT, emit: trace.emit });
      turns.push(trace);
      texts.push(result.text);
    }
    const ticket = turns.flatMap((trace) => trace.of('tool_result')).find((event) => event.name === 'create_support_case');
    expect(ticket?.summary.badges).toContain('expired');
    expect(texts.at(-1)).toMatch(/warranty has expired, so a repair would not be covered/);
  });

  it('lists no tried steps on a ticket for a new conversation, even if an earlier one left a case open', async () => {
    await chat('raj', ['the milk from my coffee machine is not frothing', 'the brew pro 300', "didn't work"]);
    await chat('raj', ['is my machine still under warranty?', 'the brew pro 300', 'yes please']);
    const ticket = stack.app.deps.db.prepare('SELECT summary, steps_tried FROM support_cases ORDER BY id DESC LIMIT 1').get() as { summary: string; steps_tried: string };
    expect(JSON.parse(ticket.steps_tried)).toEqual([]);
    expect(ticket.summary).not.toMatch(/steps from the guide/);
  });

  it('keeps his machines and cases apart from Alex', async () => {
    const alex = await ask('alex', 'is my machine still under warranty?');
    expect(alex.tools).toEqual(['list_owned_products', 'check_warranty']);
    expect(alex.result.text).toMatch(/covered until 2028-03-14/);
  });
});

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
    const { result, tools } = await ask('alex', 'that did not work on my coffee machine, please open a support case');
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
