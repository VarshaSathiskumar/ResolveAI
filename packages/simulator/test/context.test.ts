import { describe, expect, it } from 'vitest';
import { classifyMessage, deriveState, ESCALATE_AFTER, overlap, progressOf, renderNote, shouldEscalate, signature, SKIPPED_PREFIX, type Intent } from '../server/agent/context.js';
import { guardCall } from '../server/agent/guard.js';
import type { Block, Message } from '../server/agent/llm.js';
import type { ModelTool } from '../server/mcp/tools.js';

const BP200 = 'brewwell-brew-pro-200';
const DRIPMATE = 'brewwell-dripmate-12';

const customer = (text: string): Message => ({ role: 'user', content: text });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });

/** One tool call and its result, as the loop writes them into the history. */
function exchange(id: string, name: string, input: Record<string, unknown>, readable: string, data: Record<string, unknown> = {}, isError = false): Message[] {
  const content = Object.keys(data).length > 0 ? `${readable}\n\n[data] ${JSON.stringify(data)}` : readable;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input } as Block] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) } as Block] },
  ];
}

const ownsOne = (id = BP200, model = 'Brew Pro 200') => exchange('l1', 'list_owned_products', {}, 'One registered product.', { resolution: 'one', owned: [{ product_id: id, model }] });
const ownsTwo = exchange('l2', 'list_owned_products', {}, 'Two registered products.', {
  resolution: 'several',
  owned: [{ product_id: 'brewwell-espresso-studio-es1', model: 'Espresso Studio ES-1' }, { product_id: DRIPMATE, model: 'DripMate 12' }],
});
const searchResult = (productId: string, query: string, confidence = 'high') =>
  exchange(`s-${query}`, 'search_troubleshooting', { query, product_id: productId }, `Confidence: ${confidence}.\n\n1. Guide, page 2, section "Clogged needle"\nThe red light blinks.\n\n1. Unplug the machine.\n2. Open the lid.`, {
    confidence,
    results: [{ citation: 'Guide, page 2' }],
  });

const classify = (messages: Message[], text: string): Intent => classifyMessage(text, deriveState(messages));

const PROBLEM = "my coffee machine isn't brewing, only drops come out";
const advised: Message[] = [customer(PROBLEM), ...ownsOne(), ...searchResult(BP200, PROBLEM), assistant('Unplug the machine. Did that help?')];
const offered: Message[] = [...advised, customer("didn't work"), assistant('Good news, you are covered until 2028. Would you like me to open a support case?')];

describe('reading a customer line in context', () => {
  it.each([
    ['ok', 'acknowledge'],
    ['thanks', 'acknowledge'],
    ['got it, bye', 'acknowledge'],
    ["alright, I'll try that", 'acknowledge'],
    ['thanks anyway', 'acknowledge'],
    ['yes that fixed it, thank you', 'affirm'],
    ['that worked!', 'affirm'],
    ["didn't work", 'deny'],
    ['I did that and nothing changed', 'deny'],
    ['still nothing, I tried that too', 'deny'],
    ['sorry, can you say that again?', 'clarify'],
    ['so what is the next step?', 'continue'],
    ["what's the weather like tomorrow?", 'off_topic'],
    ['who won the football game last night?', 'off_topic'],
    ['it keeps clicking and then stops', 'request'],
    ['and how do I descale it?', 'request'],
    ['there is smoke coming from it', 'safety'],
  ] as const)('after a step, "%s" is %s', (text, expected) => {
    expect(classify(advised, text)).toBe(expected);
  });

  it('reads a yes or a no as the answer to the offer that was just made', () => {
    expect(classify(offered, 'yes please')).toBe('affirm');
    expect(classify(offered, 'ok')).toBe('affirm');
    expect(classify(offered, 'no thanks')).toBe('deny');
    expect(classify(offered, 'not now, thanks')).toBe('deny');
  });

  it('does not take a statement of the problem for a refusal of the offer', () => {
    expect(classify(offered, 'it still does not work, honestly')).not.toBe('deny');
  });

  it('reads "ok" as thanks, not as a yes, when nothing was offered', () => {
    expect(classify(advised, 'ok')).toBe('acknowledge');
    expect(classify([], 'hello')).toBe('acknowledge');
    expect(classify([], 'yes')).toBe('acknowledge');
  });

  it('treats a reply to a "which machine" question as an answer, however short', () => {
    const asked = [customer("my coffee machine isn't brewing"), ...ownsTwo, assistant('Which one is it, the Espresso Studio ES-1 or the DripMate 12?')];
    expect(classify(asked, 'the second one')).toBe('answer');
    expect(classify(asked, 'DripMate')).toBe('answer');
  });

  it('treats a detail as an answer but a new question as a request', () => {
    const asked = [customer('my machine is not working'), assistant('What error code or light pattern do you see?')];
    expect(classify(asked, 'the amber light is blinking')).toBe('answer');
    expect(classify(asked, "I don't know")).toBe('answer');
    expect(classify(asked, 'where is the water tank?')).toBe('request');
  });

  it('keeps an unrelated line out of the product flow, with or without a product', () => {
    expect(classify([], 'tell me a joke')).toBe('off_topic');
    expect(classify(advised, 'can you recommend a pasta recipe?')).toBe('off_topic');
  });

  it('lets a line with no product word through when it refers back to the machine in an active conversation', () => {
    expect(classify(advised, 'does it make a noise when it is working')).toBe('request');
    expect(classify([], 'does it do that often')).toBe('off_topic');
  });

  it('counts asking for a person as being about the product', () => {
    expect(classify(advised, "this isn't helping, can I talk to a human?")).toBe('request');
  });
});

describe('the closing question', () => {
  const declined: Message[] = [...offered, customer('no'), assistant('No problem, I will leave it there. Is there anything else I can help with?')];

  it.each([['no', 'acknowledge'], ['nope', 'acknowledge'], ['yes', 'acknowledge']] as const)('"%s" to "anything else?" is %s, not a failed step', (text, expected) => {
    expect(classify(declined, text)).toBe(expected);
    expect(progressOf(deriveState([...declined, customer(text)])).failed).toBe(progressOf(deriveState(declined)).failed);
  });

  it('still reads a new problem after it as a request', () => {
    expect(classify(declined, 'it keeps clicking and then stops')).toBe('request');
  });
});

describe('what the conversation has established', () => {
  it('knows the one machine a customer owns, and does not know which of two', () => {
    expect(deriveState([customer(PROBLEM), ...ownsOne()]).product).toEqual({ id: BP200 });
    const two = deriveState([customer(PROBLEM), ...ownsTwo]);
    expect(two.product).toBeUndefined();
    expect(two.owned.map((entry) => entry.model)).toEqual(['Espresso Studio ES-1', 'DripMate 12']);
  });

  it('settles on a machine the customer identified, but not on an ambiguous match', () => {
    const settled = deriveState([customer('my DripMate leaks'), ...exchange('i1', 'identify_product', { description: 'x' }, 'Match.', { ambiguous: false, candidates: [{ product_id: DRIPMATE, model: 'DripMate 12' }] })]);
    expect(settled.product).toEqual({ id: DRIPMATE });
    expect(settled.models[DRIPMATE]).toBe('DripMate 12');
    const unsure = deriveState([customer('my Brew Pro leaks'), ...exchange('i1', 'identify_product', { description: 'x' }, 'Two match.', { ambiguous: true, candidates: [{ product_id: BP200, model: 'Brew Pro 200' }] })]);
    expect(unsure.product).toBeUndefined();
  });

  it('keeps what was tried per machine, and treats what the customer says after a switch as the new problem', () => {
    const state = deriveState([
      customer(PROBLEM),
      ...ownsOne(),
      ...exchange('r1', 'record_diagnostic_step', { kind: 'step', content: 'Cleaned the needle', product_id: BP200 }, 'Recorded.', { case_id: 3, product_id: BP200 }),
      customer('actually my DripMate is leaking'),
      ...exchange('i1', 'identify_product', { description: 'x' }, 'Match.', { ambiguous: false, candidates: [{ product_id: DRIPMATE, model: 'DripMate 12' }] }),
    ]);
    expect(state.product).toEqual({ id: DRIPMATE });
    expect(state.problem).toEqual(['actually my DripMate is leaking']);
    expect(progressOf(state).steps).toEqual([]);
    expect(progressOf(state, BP200).steps).toEqual(['Cleaned the needle']);
  });

  it('counts attempts that did not help and says when it is time for a support case', () => {
    const base = [...advised, customer("didn't work"), assistant('Open the lid. Did that help?')];
    expect(shouldEscalate(deriveState(base))).toBe(false);
    const twice = [...base, customer('still nothing'), assistant('Let me check.')];
    const state = deriveState(twice);
    expect(progressOf(state).failed).toBe(ESCALATE_AFTER);
    expect(shouldEscalate(state)).toBe(true);
    // Once the offer has been made, it is not made again.
    expect(shouldEscalate(deriveState([...twice, assistant('Would you like me to open a support case?')]))).toBe(false);
  });

  it('closes the problem when the customer confirms the fix, and starts afresh on the next one', () => {
    const fixed = deriveState([...advised, customer('that worked, thank you')]);
    expect(fixed.resolved).toBe(true);
    const next = deriveState([...advised, customer('that worked, thank you'), assistant('Glad it did.'), customer('now it leaks from the bottom')]);
    expect(next.resolved).toBe(false);
    expect(next.problem).toEqual(['now it leaks from the bottom']);
    expect(progressOf(next).failed).toBe(0);
  });

  it('remembers the question it is waiting on, and what kind it is, ignoring an aside in brackets', () => {
    const state = deriveState([customer('hi'), assistant('Is it the Brew Pro 200 or the Brew Pro 300? (Brew Pro 200: single-serve; Brew Pro 300: colour LCD)')]);
    expect(state.pending).toMatchObject({ kind: 'product', question: 'Is it the Brew Pro 200 or the Brew Pro 300?' });
    expect(deriveState(advised).pending?.kind).toBe('outcome');
    expect(deriveState(offered).pending?.kind).toBe('escalate');
    expect(deriveState([customer('hi'), assistant('What error code do you see?')]).pending?.kind).toBe('detail');
    expect(deriveState([customer('hi'), assistant('Is there anything else I can help with?')]).pending?.kind).toBe('closing');
  });

  it('notices when the assistant repeats itself', () => {
    const twice = deriveState([customer('a'), assistant('What error code or light pattern do you see?'), customer('b'), assistant('What error code or light pattern do you see?')]);
    expect(twice.repeatedReply).toBe(true);
    const varied = deriveState([customer('a'), assistant('What error code or light pattern do you see?'), customer('b'), assistant('Does it make any noise or leak?')]);
    expect(varied.repeatedReply).toBe(false);
  });

  it('remembers the read-only calls it has answered, and not the ones that failed or were skipped', () => {
    const ok = deriveState([...ownsOne()]);
    expect(ok.seen.has(signature('list_owned_products', {}))).toBe(true);
    const failed = deriveState([...exchange('x', 'get_product', { product_id: 'nope' }, 'Unknown product_id.', {}, true)]);
    expect(failed.seen.size).toBe(0);
    const skipped = deriveState([...exchange('x', 'list_owned_products', {}, `${SKIPPED_PREFIX}Not run.`)]);
    expect(skipped.seen.size).toBe(0);
  });

  it('counts a call that left out the machine as the same call with it filled in', () => {
    const state = deriveState([...ownsOne(), ...exchange('s', 'search_troubleshooting', { query: 'drips' }, 'Confidence: high.', { confidence: 'high', results: [] })]);
    expect(state.seen.has(signature('search_troubleshooting', { query: 'drips', product_id: BP200 }))).toBe(true);
  });

  it('is the same however often it is derived, and does not change the history', () => {
    const before = JSON.stringify(offered);
    expect(JSON.stringify(deriveState(offered).progress)).toBe(JSON.stringify(deriveState(offered).progress));
    expect(JSON.stringify(offered)).toBe(before);
  });

  it('compares two texts by what they say, not by filler', () => {
    expect(overlap('What error code or light pattern do you see?', 'What light pattern or error code do you see?')).toBeGreaterThan(0.8);
    expect(overlap('What error code do you see?', 'Does it leak?')).toBeLessThan(0.3);
  });
});

describe('the note the model reads', () => {
  const noteFor = (messages: Message[], text: string) => {
    const state = deriveState(messages);
    const intent = classifyMessage(text, state);
    // The loop reads the line in before it writes the note.
    const read = deriveState([...messages, customer(text)]);
    return { note: renderNote(read, intent), intent };
  };

  it('is empty for a first line, where there is nothing yet to say', () => {
    expect(noteFor([], PROBLEM).note).toBe('');
    expect(noteFor([], 'hello').note).toBe('');
  });

  it('carries the machine, the steps given, the questions asked and how to read the line', () => {
    const { note } = noteFor(advised, 'ok');
    expect(note).toContain('Machine: Brew Pro 200');
    expect(note).toContain(`product_id ${BP200}`);
    expect(note).toContain('Machine: Brew Pro 200');
    expect(note).toMatch(/only an acknowledgement/);
    expect(note.startsWith('[context from the system')).toBe(true);
    expect(note.endsWith('[/context]')).toBe(true);
  });

  it('does not tell the model to stop asking whether a step helped, which follows every step', () => {
    expect(noteFor(advised, 'ok').note).not.toMatch(/already asked/);
    const asked = [customer('my machine is not working'), assistant('What error code or light pattern do you see?')];
    expect(noteFor(asked, "I don't know").note).toMatch(/Questions you already asked: "What error code or light pattern do you see\?"/);
  });

  it('says to move to a support case once attempts have run out, and not before', () => {
    const base = [...advised, customer("didn't work"), assistant('Open the lid. Did that help?')];
    expect(noteFor(base, 'ok').note).not.toMatch(/Attempts have run out/);
    const { note } = noteFor(base, 'still nothing');
    expect(note).toMatch(/Attempts that did not help: 2/);
    expect(note).toMatch(/Attempts have run out/);
  });

  it('tells the model to create the case on a yes, and not to on a no', () => {
    expect(noteFor(offered, 'yes please').note).toMatch(/Create it now/);
    expect(noteFor(offered, 'no thanks').note).toMatch(/Do not create one/);
  });

  it('names the registered machines when it is not yet known which one is meant', () => {
    expect(noteFor([customer('my machine is loud'), ...ownsTwo, assistant('Which one is it?')], 'the dripmate').note).toMatch(/Espresso Studio ES-1 and DripMate 12 registered/);
  });

  it('uses no dash that reads badly aloud and no per-user data beyond the conversation', () => {
    expect(noteFor(advised, 'ok').note).not.toContain('—');
  });
});

describe('checking a tool call before it runs', () => {
  const tool = (name: string, withProduct: boolean): ModelTool => ({ name, description: '', input_schema: { type: 'object', properties: withProduct ? { product_id: { type: 'string' } } : {} } });
  const tools = [tool('search_troubleshooting', true), tool('check_warranty', true), tool('list_owned_products', false), tool('create_support_case', false), tool('record_diagnostic_step', true)];
  const guard = (messages: Message[], text: string, name: string, input: Record<string, unknown>) => guardCall(deriveState([...messages, customer(text)]), tools, name, input);

  it.each(['search_troubleshooting', 'list_owned_products'])('holds back %s for a line that is only thanks', (name) => {
    const decision = guard(advised, 'thanks', name, name === 'search_troubleshooting' ? { query: 'thanks' } : {});
    expect(decision).toMatchObject({ action: 'skip', reason: 'not_needed' });
    expect((decision as { text: string }).text.startsWith(SKIPPED_PREFIX)).toBe(true);
  });

  it('holds back a lookup for an unrelated line and for a safety line', () => {
    expect(guard(advised, 'who won the football game last night?', 'search_troubleshooting', { query: 'x' })).toMatchObject({ reason: 'not_needed' });
    expect(guard([], 'there is smoke coming from my machine', 'list_owned_products', {})).toMatchObject({ reason: 'not_needed' });
  });

  it('holds back a lookup when the customer has said yes or no to an offer, but lets the offer itself through', () => {
    expect(guard(offered, 'yes please', 'search_troubleshooting', { query: 'yes please' })).toMatchObject({ reason: 'not_needed' });
    expect(guard(offered, 'no thanks', 'search_troubleshooting', { query: 'no thanks' })).toMatchObject({ reason: 'not_needed' });
    expect(guard(offered, 'yes please', 'create_support_case', { summary: 'It drips and nothing helped.' })).toMatchObject({ action: 'run' });
  });

  it('lets a lookup through when the line has something to look up, even right after a refusal', () => {
    expect(guard(advised, "didn't work", 'search_troubleshooting', { query: 'drips', product_id: BP200 })).toMatchObject({ action: 'run' });
    expect(guard(advised, 'and how do I descale it?', 'search_troubleshooting', { query: 'descale' })).toMatchObject({ action: 'run' });
  });

  it('does not run an identical read-only call a second time', () => {
    const decision = guard(advised, 'it still drips from the outlet', 'search_troubleshooting', { query: PROBLEM, product_id: BP200 });
    expect(decision).toMatchObject({ action: 'skip', reason: 'repeat' });
    expect(guard(advised, 'it still drips from the outlet', 'search_troubleshooting', { query: 'a different query', product_id: BP200 })).toMatchObject({ action: 'run' });
  });

  it('never skips a call that writes', () => {
    const state = [...advised, ...exchange('r1', 'record_diagnostic_step', { kind: 'step', content: 'x', product_id: BP200 }, 'Recorded.', { case_id: 1 })];
    expect(guard(state, 'it still drips from the outlet', 'record_diagnostic_step', { kind: 'step', content: 'x', product_id: BP200 })).toMatchObject({ action: 'run' });
  });

  it('fills in the machine the conversation settled on when a tool that takes one is called without it', () => {
    const decision = guard(advised, 'is it still under warranty?', 'check_warranty', {});
    expect(decision).toMatchObject({ action: 'run', input: { product_id: BP200 } });
    expect((decision as { note: string }).note).toMatch(/product_id was left out.*Brew Pro 200/);
  });

  it('leaves an explicit product alone, and a tool that takes no product alone', () => {
    expect(guard(advised, 'is it covered?', 'check_warranty', { product_id: DRIPMATE })).toEqual({ action: 'run', input: { product_id: DRIPMATE } });
    expect(guard(advised, 'is it covered?', 'create_support_case', { summary: 'x'.repeat(20) })).toEqual({ action: 'run', input: { summary: 'x'.repeat(20) } });
  });

  it('fills nothing in when no machine is settled, so the tool can say what it needs', () => {
    expect(guard([], 'is it covered by the warranty?', 'check_warranty', {})).toEqual({ action: 'run', input: {} });
  });

  it('judges a call with the machine filled in, so leaving it out does not dodge the repeat check', () => {
    const decision = guard(advised, 'it still drips from the outlet', 'search_troubleshooting', { query: PROBLEM });
    expect(decision).toMatchObject({ action: 'skip', reason: 'repeat' });
  });
});
