// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '../shared/events';
import { Conversation } from '../web/src/components/Conversation';
import { PersonaPicker } from '../web/src/components/PersonaPicker';
import { TracePanel } from '../web/src/components/TracePanel';
import { describeInput, formatMs, formatTokens, shortCitation } from '../web/src/format';
import { initialState, reduce, type AppState } from '../web/src/state';

afterEach(cleanup);

const usage = { inputTokens: 5200, outputTokens: 40, cacheReadTokens: 4096, cacheWriteTokens: 0 };
const play = (events: TraceEvent[]): AppState => events.reduce(reduce, initialState);

const finishedTurn: TraceEvent[] = [
  { type: 'turn_started', turnId: 't1', at: 1, userText: 'my coffee machine is not brewing' },
  { type: 'model_call', turnId: 't1', round: 1, model: 'claude-sonnet-5-5', ms: 1300, stopReason: 'tool_use', usage },
  { type: 'tool_call', turnId: 't1', round: 1, toolUseId: 'u1', name: 'search_troubleshooting', input: { query: 'not brewing', product_id: 'brewwell-brew-pro-200' }, at: 2 },
  {
    type: 'tool_result',
    turnId: 't1',
    round: 1,
    toolUseId: 'u1',
    name: 'search_troubleshooting',
    ok: true,
    ms: 240,
    summary: { headline: '4 results, confidence high', badges: ['confidence: high', 'reranked in 181 ms'], citations: [{ citation: 'Brewwell Brew Pro 200 Troubleshooting Guide, page 2', uri: 'doc://3#p2' }] },
    text: 'Confidence: high.\n\n1. Clogged needle',
  },
  { type: 'text_delta', turnId: 't1', round: 2, text: 'Try cleaning the needle.' },
  { type: 'model_call', turnId: 't1', round: 2, model: 'claude-sonnet-5-5', ms: 900, stopReason: 'end_turn', usage },
  { type: 'turn_complete', turnId: 't1', ms: 2600, rounds: 2, reason: 'end_turn', text: 'Try cleaning the needle.' },
];

describe('format helpers', () => {
  it('formats times, citations, tokens and arguments for reading', () => {
    expect(formatMs(undefined)).toBe('');
    expect(formatMs(182.4)).toBe('182 ms');
    expect(formatMs(1500)).toBe('1.5 s');
    expect(shortCitation('Brewwell Brew Pro 200 Troubleshooting Guide, page 2')).toBe('Brew Pro 200 Troubleshooting Guide, p. 2');
    expect(formatTokens(usage)).toBe('5,200 in / 40 out / 4,096 cached');
    expect(formatTokens({ ...usage, cacheReadTokens: 0 })).toBe('5,200 in / 40 out');
    expect(describeInput({ query: 'x'.repeat(60), limit: 3 })).toBe(`query: "${'x'.repeat(48)}...", limit: 3`);
    expect(describeInput('nope')).toBe('');
  });
});

describe('PersonaPicker', () => {
  const personas = [{ id: 'alex', name: 'Alex', note: 'one machine' }, { id: 'sam', name: 'Sam', note: 'no machines' }];

  it('shows the personas as a radio group and reports the choice', async () => {
    const onSelect = vi.fn();
    render(<PersonaPicker personas={personas} selected="alex" onSelect={onSelect} />);
    expect(screen.getByRole('radio', { name: /Alex/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Sam/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /Sam/ }));
    expect(onSelect).toHaveBeenCalledWith('sam');
  });

  it('can be disabled while the assistant is answering', () => {
    render(<PersonaPicker personas={personas} selected="alex" onSelect={() => {}} disabled />);
    expect(screen.getByRole('radio', { name: /Sam/ })).toBeDisabled();
  });
});

describe('Conversation', () => {
  const baseProps = { persona: { id: 'alex', name: 'Alex', note: '' }, ready: true, onSend: vi.fn(), onCancel: vi.fn(), onOpenCitation: vi.fn() };

  it('offers starting questions when empty, and sends one when chosen', async () => {
    const onSend = vi.fn();
    render(<Conversation {...baseProps} onSend={onSend} state={initialState} />);
    expect(screen.getByText('You are speaking as Alex.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "My coffee machine isn't brewing" }));
    expect(onSend).toHaveBeenCalledWith("My coffee machine isn't brewing");
  });

  it('sends the typed message on submit and clears the box', async () => {
    const onSend = vi.fn();
    render(<Conversation {...baseProps} onSend={onSend} state={initialState} />);
    const input = screen.getByLabelText('Your message');
    await userEvent.type(input, '  the light is red  {enter}');
    expect(onSend).toHaveBeenCalledWith('the light is red');
    expect(input).toHaveValue('');
  });

  it('does not send an empty message, and cannot send until connected', async () => {
    const onSend = vi.fn();
    const { rerender } = render(<Conversation {...baseProps} onSend={onSend} state={initialState} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    rerender(<Conversation {...baseProps} onSend={onSend} state={initialState} ready={false} />);
    expect(screen.getByLabelText('Your message')).toBeDisabled();
    expect(screen.getByPlaceholderText('Connecting...')).toBeInTheDocument();
  });

  it('shows both sides, with the sources the answer used as chips that open the page', async () => {
    const onOpenCitation = vi.fn();
    render(<Conversation {...baseProps} onOpenCitation={onOpenCitation} state={play(finishedTurn)} />);
    expect(screen.getByText('my coffee machine is not brewing')).toBeInTheDocument();
    expect(screen.getByText('Try cleaning the needle.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Brew Pro 200 Troubleshooting Guide, p. 2' }));
    expect(onOpenCitation).toHaveBeenCalledWith({ citation: 'Brewwell Brew Pro 200 Troubleshooting Guide, page 2', uri: 'doc://3#p2' });
  });

  it('shows a working indicator and a Stop button while the assistant answers, and stops on request', async () => {
    const onCancel = vi.fn();
    render(<Conversation {...baseProps} onCancel={onCancel} state={play(finishedTurn.slice(0, 3))} />);
    expect(screen.getByRole('status', { name: /working on it/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onCancel).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('does not offer the sources while the answer is still streaming', () => {
    const streaming = play([...finishedTurn.slice(0, 5)]);
    render(<Conversation {...baseProps} state={streaming} />);
    expect(screen.queryByRole('button', { name: /Troubleshooting Guide/ })).not.toBeInTheDocument();
  });

  it('renders extra content after a finished reply (the ticket card slot)', () => {
    render(<Conversation {...baseProps} state={play(finishedTurn)} afterTurn={(turnId) => <div>card for {turnId}</div>} />);
    expect(screen.getByText('card for t1')).toBeInTheDocument();
  });

  it('shows notices from the backend as plain text', () => {
    const state = play([{ type: 'turn_started', turnId: 't', at: 1, userText: 'x' }, { type: 'turn_complete', turnId: 't', ms: 1, rounds: 8, reason: 'max_rounds', text: '' }]);
    render(<Conversation {...baseProps} state={state} />);
    expect(screen.getByText(/got stuck on that one/)).toBeInTheDocument();
  });
});

describe('TracePanel', () => {
  it('explains itself when empty', () => {
    render(<TracePanel state={initialState} />);
    expect(screen.getByText(/Every model call and tool call shows up here/)).toBeInTheDocument();
  });

  it('shows the model, a turn summary with time, calls and cached tokens, and each tool with its decision badges', () => {
    render(<TracePanel state={play(finishedTurn)} model="claude-sonnet-5-5" />);
    expect(screen.getByText('claude-sonnet-5-5', { selector: '.pill' })).toBeInTheDocument();
    expect(screen.getByText('2.6 s')).toBeInTheDocument();
    expect(screen.getByText(/2 model calls \/ 240 ms in tools \/ 8,192 tokens from cache/)).toBeInTheDocument();
    expect(screen.getByText('search_troubleshooting')).toBeInTheDocument();
    expect(screen.getByText('4 results, confidence high')).toBeInTheDocument();
    expect(screen.getByText('confidence: high')).toHaveClass('badge--good');
    expect(screen.getByText('reranked in 181 ms')).toBeInTheDocument();
    expect(screen.getByText('query: "not brewing", product_id: "brewwell-brew-pro-200"')).toBeInTheDocument();
  });

  it('flags a low-confidence result and a failure as warnings', () => {
    const state = play([
      { type: 'turn_started', turnId: 't', at: 1, userText: 'x' },
      { type: 'tool_call', turnId: 't', round: 1, toolUseId: 'a', name: 'search_troubleshooting', input: {}, at: 1 },
      { type: 'tool_result', turnId: 't', round: 1, toolUseId: 'a', name: 'search_troubleshooting', ok: true, ms: 5, summary: { headline: 'h', badges: ['confidence: low'], citations: [] }, text: '' },
      { type: 'tool_call', turnId: 't', round: 1, toolUseId: 'b', name: 'get_product', input: {}, at: 1 },
      { type: 'tool_result', turnId: 't', round: 1, toolUseId: 'b', name: 'get_product', ok: false, ms: 5, summary: { headline: 'get_product failed', badges: ['error'], citations: [] }, text: 'Unknown product' },
    ]);
    render(<TracePanel state={state} />);
    expect(screen.getByText('confidence: low')).toHaveClass('badge--warn');
    expect(screen.getByText('error')).toHaveClass('badge--warn');
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('shows a running tool before its result arrives and the raw result when a tool row is opened', async () => {
    const running = play(finishedTurn.slice(0, 3));
    const { unmount } = render(<TracePanel state={running} />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('working...')).toBeInTheDocument();
    unmount();

    render(<TracePanel state={play(finishedTurn)} />);
    expect(screen.queryByText(/1\. Clogged needle/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /search_troubleshooting/ }));
    expect(screen.getByText(/1\. Clogged needle/)).toBeInTheDocument();
  });

  it('lists the newest turn first, open, and older ones collapsed until clicked', async () => {
    const second: TraceEvent[] = [{ type: 'turn_started', turnId: 't2', at: 9, userText: 'second question' }, { type: 'turn_complete', turnId: 't2', ms: 500, rounds: 1, reason: 'end_turn', text: 'ok' }];
    render(<TracePanel state={play([...finishedTurn, ...second])} />);
    const heads = screen.getAllByRole('button', { expanded: undefined }).filter((button) => button.classList.contains('turn__head'));
    expect(heads.map((head) => head.textContent)).toEqual(['second question500 ms', 'my coffee machine is not brewing2.6 s']);
    expect(heads[1]).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(heads[1]!);
    expect(heads[1]).toHaveAttribute('aria-expanded', 'true');
  });

  it('notes how a turn ended when it was not normal', () => {
    render(<TracePanel state={play([{ type: 'turn_started', turnId: 't', at: 1, userText: 'x' }, { type: 'turn_complete', turnId: 't', ms: 9000, rounds: 8, reason: 'max_rounds', text: '' }])} />);
    expect(screen.getByText(/ended: max rounds/)).toBeInTheDocument();
  });
});
