import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../shared/events';
import { initialState, reduce, type AppState } from '../web/src/state';

const T = 't1';
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
const play = (events: TraceEvent[], from: AppState = initialState) => events.reduce(reduce, from);

const started: TraceEvent = { type: 'turn_started', turnId: T, at: 1000, userText: 'my machine is not brewing' };
const complete = (reason: 'end_turn' | 'max_rounds' | 'max_tokens' | 'refusal' | 'aborted' | 'error' = 'end_turn', text = ''): TraceEvent => ({ type: 'turn_complete', turnId: T, ms: 2400, rounds: 2, reason, text });
const search = (extra: Partial<Extract<TraceEvent, { type: 'tool_result' }>> = {}): TraceEvent => ({
  type: 'tool_result',
  turnId: T,
  round: 1,
  toolUseId: 'u1',
  name: 'search_troubleshooting',
  ok: true,
  ms: 210,
  summary: { headline: '2 results, confidence high', badges: ['confidence: high'], citations: [{ citation: 'Guide, page 2', uri: 'doc://3#p2' }] },
  text: 'Confidence: high.',
  ...extra,
});

describe('reduce', () => {
  it('starts a turn with the user message and an empty trace, and marks the app running', () => {
    const state = play([started]);
    expect(state.running).toBe(true);
    expect(state.messages).toEqual([{ id: 'u-t1', role: 'user', text: 'my machine is not brewing', turnId: T, streaming: false }]);
    expect(state.turns).toEqual([{ turnId: T, userText: 'my machine is not brewing', startedAt: 1000, items: [], citations: [] }]);
  });

  it('builds the assistant reply from text deltas and stops streaming at completion', () => {
    const mid = play([started, { type: 'text_delta', turnId: T, round: 1, text: 'Is a ' }, { type: 'text_delta', turnId: T, round: 1, text: 'light blinking?' }]);
    expect(mid.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Is a light blinking?', streaming: true });
    const done = reduce(mid, complete('end_turn', 'Is a light blinking?'));
    expect(done.messages.at(-1)).toMatchObject({ text: 'Is a light blinking?', streaming: false });
    expect(done.running).toBe(false);
    expect(done.turns[0]).toMatchObject({ ms: 2400, rounds: 2, reason: 'end_turn' });
  });

  it('continues one reply across model calls, with a space between what was said before and after the tools', () => {
    const state = play([
      started,
      { type: 'text_delta', turnId: T, round: 1, text: 'Let me check.' },
      { type: 'model_call', turnId: T, round: 1, model: 'm', ms: 900, stopReason: 'tool_use', usage },
      { type: 'text_delta', turnId: T, round: 2, text: 'It looks like the needle.' },
    ]);
    expect(state.messages.at(-1)!.text).toBe('Let me check. It looks like the needle.');
  });

  it('creates the reply from the completed text when no deltas arrived', () => {
    const state = play([started, complete('end_turn', 'All done.')]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'All done.', streaming: false });
  });

  it('shows a tool call as running, then fills in its result, time and summary', () => {
    const running = play([started, { type: 'tool_call', turnId: T, round: 1, toolUseId: 'u1', name: 'search_troubleshooting', input: { query: 'x' }, at: 1100 }]);
    expect(running.turns[0]!.items[0]).toMatchObject({ kind: 'tool', status: 'running', name: 'search_troubleshooting' });
    const finished = reduce(running, search());
    expect(finished.turns[0]!.items[0]).toMatchObject({ status: 'ok', ms: 210, summary: { headline: '2 results, confidence high' } });
  });

  it('marks a failed tool and keeps its text', () => {
    const state = play([started, { type: 'tool_call', turnId: T, round: 1, toolUseId: 'u1', name: 'get_product', input: {}, at: 1 }, search({ ok: false, name: 'get_product', text: 'Unknown product', summary: { headline: 'get_product failed', badges: ['error'], citations: [] } })]);
    expect(state.turns[0]!.items[0]).toMatchObject({ status: 'error', text: 'Unknown product' });
  });

  it('collects citations for the turn and never lists the same page twice', () => {
    const state = play([started, search(), search({ toolUseId: 'u2' }), search({ toolUseId: 'u3', summary: { headline: 'x', badges: [], citations: [{ citation: 'Guide, page 3', uri: 'doc://3#p3' }] } })]);
    expect(state.turns[0]!.citations.map((citation) => citation.uri)).toEqual(['doc://3#p2', 'doc://3#p3']);
  });

  it('records a MCP App resource to show', () => {
    const resource = { type: 'ui_resource' as const, turnId: T, toolUseId: 'u9', uri: 'ui://ticket/card.html', toolName: 'create_support_case', input: { summary: 's' }, result: { text: 'ticket', structuredContent: { ticket_ref: 'RAI-1' } } };
    const state = play([started, resource]);
    const { type: _type, ...expected } = resource;
    void _type;
    expect(state.uiResources).toEqual([expected]);
  });

  it.each([
    ['max_rounds', /got stuck/],
    ['max_tokens', /cut off/],
    ['refusal', /can't help/],
    ['aborted', /Stopped/],
  ] as const)('explains a turn that ended with %s in a notice', (reason, pattern) => {
    const state = play([started, complete(reason)]);
    const notice = state.messages.find((message) => message.role === 'notice');
    expect(notice?.text).toMatch(pattern);
    expect(state.running).toBe(false);
  });

  it('shows a backend error once and does not add a second notice when the turn then ends in error', () => {
    const state = play([started, { type: 'error', turnId: T, message: 'Rate limited by the Anthropic API', retryable: true }, complete('error')]);
    expect(state.messages.filter((message) => message.role === 'notice').map((message) => message.text)).toEqual(['Rate limited by the Anthropic API']);
  });

  it('adds no notice for a normal ending', () => {
    expect(play([started, complete('end_turn', 'ok')]).messages.some((message) => message.role === 'notice')).toBe(false);
  });

  it('keeps model calls in the trace with their usage', () => {
    const state = play([started, { type: 'model_call', turnId: T, round: 1, model: 'claude-sonnet-5-5', ms: 1200, stopReason: 'end_turn', usage: { ...usage, cacheReadTokens: 4096 }, servedBy: 'claude-opus-4-8' }]);
    expect(state.turns[0]!.items[0]).toMatchObject({ kind: 'model', model: 'claude-sonnet-5-5', ms: 1200, servedBy: 'claude-opus-4-8', usage: { cacheReadTokens: 4096 } });
  });

  it('starts over on reset', () => {
    expect(reduce(play([started, complete('end_turn', 'x')]), { type: 'reset' })).toEqual(initialState);
  });

  it('handles several turns in order and does not mutate the previous state', () => {
    const first = play([started, complete('end_turn', 'one')]);
    const snapshot = JSON.stringify(first);
    const second = play([{ type: 'turn_started', turnId: 't2', at: 5000, userText: 'again' }], first);
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(second.turns.map((turn) => turn.turnId)).toEqual(['t1', 't2']);
    expect(second.messages.map((message) => message.id)).toEqual(['u-t1', 'a-t1', 'u-t2']);
  });
});
