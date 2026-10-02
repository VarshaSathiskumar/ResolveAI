import type { Citation, ToolSummary, TraceEvent, TurnEndReason, Usage } from '../../shared/events';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  turnId: string;
  streaming: boolean;
}

export type TraceItem =
  | { kind: 'model'; round: number; model: string; ms: number; stopReason: string | null; usage: Usage; servedBy?: string }
  | {
      kind: 'tool';
      round: number;
      toolUseId: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      startedAt: number;
      ms?: number;
      summary?: ToolSummary;
      text?: string;
    };

export interface TurnTrace {
  turnId: string;
  userText: string;
  startedAt: number;
  items: TraceItem[];
  /** Pages the assistant looked up this turn, shown under its answer. */
  citations: Citation[];
  ms?: number;
  reason?: TurnEndReason;
  rounds?: number;
}

export interface UiResource {
  turnId: string;
  toolUseId: string;
  uri: string;
  toolName: string;
  input: unknown;
  result: { text: string; structuredContent?: Record<string, unknown> };
}

export interface AppState {
  messages: ChatMessage[];
  turns: TurnTrace[];
  uiResources: UiResource[];
  running: boolean;
}

export const initialState: AppState = { messages: [], turns: [], uiResources: [], running: false };

/** What the screen state reacts to: a backend event, or starting a fresh conversation. */
export type Action = TraceEvent | { type: 'reset' };

const NOTICES: Partial<Record<TurnEndReason, string>> = {
  max_rounds: 'I got stuck on that one. Could you say it another way?',
  max_tokens: 'My answer got cut off. Please try again.',
  refusal: "I can't help with that request.",
  aborted: 'Stopped.',
};

const replaceTurn = (state: AppState, turnId: string, change: (turn: TurnTrace) => TurnTrace): AppState => ({
  ...state,
  turns: state.turns.map((turn) => (turn.turnId === turnId ? change(turn) : turn)),
});

/** Folds one backend event into the screen state. Pure, so a whole turn can be replayed from its events. */
export function reduce(state: AppState, event: Action): AppState {
  switch (event.type) {
    case 'reset':
      return initialState;

    case 'turn_started':
      return {
        ...state,
        running: true,
        messages: [...state.messages, { id: `u-${event.turnId}`, role: 'user', text: event.userText, turnId: event.turnId, streaming: false }],
        turns: [...state.turns, { turnId: event.turnId, userText: event.userText, startedAt: event.at, items: [], citations: [] }],
      };

    case 'text_delta': {
      const id = `a-${event.turnId}`;
      const existing = state.messages.find((message) => message.id === id);
      if (!existing) {
        return { ...state, messages: [...state.messages, { id, role: 'assistant', text: event.text, turnId: event.turnId, streaming: true }] };
      }
      // Text from a later model call (after tools ran) continues the same reply.
      const lastRound = state.turns.find((turn) => turn.turnId === event.turnId)?.items.findLast((item) => item.kind === 'model')?.round ?? 0;
      const joiner = event.round > lastRound && existing.text && !/\s$/.test(existing.text) && !/^\s/.test(event.text) ? ' ' : '';
      return { ...state, messages: state.messages.map((message) => (message.id === id ? { ...message, text: message.text + joiner + event.text } : message)) };
    }

    case 'model_call':
      return replaceTurn(state, event.turnId, (turn) => ({
        ...turn,
        items: [...turn.items, { kind: 'model', round: event.round, model: event.model, ms: event.ms, stopReason: event.stopReason, usage: event.usage, ...(event.servedBy ? { servedBy: event.servedBy } : {}) }],
      }));

    case 'tool_call':
      return replaceTurn(state, event.turnId, (turn) => ({
        ...turn,
        items: [...turn.items, { kind: 'tool', round: event.round, toolUseId: event.toolUseId, name: event.name, input: event.input, status: 'running', startedAt: event.at }],
      }));

    case 'tool_result':
      return replaceTurn(state, event.turnId, (turn) => {
        const known = new Set(turn.citations.map((citation) => citation.uri));
        return {
          ...turn,
          items: turn.items.map((item) =>
            item.kind === 'tool' && item.toolUseId === event.toolUseId ? { ...item, status: event.ok ? 'ok' : 'error', ms: event.ms, summary: event.summary, text: event.text } : item,
          ),
          citations: [...turn.citations, ...event.summary.citations.filter((citation) => !known.has(citation.uri))],
        };
      });

    case 'ui_resource':
      return {
        ...state,
        uiResources: [...state.uiResources, { turnId: event.turnId, toolUseId: event.toolUseId, uri: event.uri, toolName: event.toolName, input: event.input, result: event.result }],
      };

    case 'error':
      return {
        ...state,
        messages: [...state.messages, { id: `e-${state.messages.length}`, role: 'notice', text: event.message, turnId: event.turnId ?? '', streaming: false }],
      };

    case 'turn_complete': {
      const id = `a-${event.turnId}`;
      let messages = state.messages.map((message) => (message.id === id ? { ...message, streaming: false } : message));
      if (!messages.some((message) => message.id === id) && event.text) {
        messages = [...messages, { id, role: 'assistant', text: event.text, turnId: event.turnId, streaming: false }];
      }
      const notice = NOTICES[event.reason];
      const alreadyExplained = messages.some((message) => message.role === 'notice' && message.turnId === event.turnId);
      if (notice && !alreadyExplained) {
        messages = [...messages, { id: `n-${event.turnId}`, role: 'notice', text: notice, turnId: event.turnId, streaming: false }];
      }
      return { ...replaceTurn({ ...state, messages }, event.turnId, (turn) => ({ ...turn, ms: event.ms, reason: event.reason, rounds: event.rounds })), running: false };
    }
  }
}
