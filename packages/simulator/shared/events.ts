/**
 * The event stream between the backend and the web app. Everything the trace panel and the conversation show is one
 * of these, in order, so a turn can be replayed from its events.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Citation {
  /** Ready to say aloud, for example "Brewwell Brew Pro 200 Troubleshooting Guide, page 2". */
  citation: string;
  /** doc://{documentId}#p{page}, readable through the backend. */
  uri: string;
  section?: string;
}

/** What a tool result means, boiled down for the trace panel. Derived from the tool's structured output. */
export interface ToolSummary {
  headline: string;
  /** Short labels such as "confidence: high", "needs: product_id", "reranked 180 ms". */
  badges: string[];
  citations: Citation[];
}

export type TurnEndReason = 'end_turn' | 'max_rounds' | 'max_tokens' | 'refusal' | 'aborted' | 'error';

export type TraceEvent =
  | { type: 'turn_started'; turnId: string; at: number; userText: string }
  | { type: 'text_delta'; turnId: string; round: number; text: string }
  | {
      type: 'model_call';
      turnId: string;
      round: number;
      model: string;
      ms: number;
      stopReason: string | null;
      usage: Usage;
      /** Set when the refusal fallback served this call on another model. */
      servedBy?: string;
    }
  | { type: 'tool_call'; turnId: string; round: number; toolUseId: string; name: string; input: unknown; at: number }
  | {
      type: 'tool_result';
      turnId: string;
      round: number;
      toolUseId: string;
      name: string;
      ok: boolean;
      ms: number;
      summary: ToolSummary;
      /** The text the model saw, trimmed for display. */
      text: string;
      /** Set when the loop answered the call itself instead of running the tool: it was not needed, or it repeated an earlier call. */
      skipped?: 'not_needed' | 'repeat';
    }
  | {
      type: 'ui_resource';
      turnId: string;
      toolUseId: string;
      /** The ui:// resource that renders this tool's result as an MCP App. */
      uri: string;
      toolName: string;
      /** What the view needs to render: the call's arguments and its result, as the host hands them to the app. */
      input: unknown;
      result: { text: string; structuredContent?: Record<string, unknown> };
    }
  | { type: 'turn_complete'; turnId: string; ms: number; rounds: number; reason: TurnEndReason; text: string }
  | { type: 'error'; turnId?: string; message: string; retryable: boolean };

export type TraceListener = (event: TraceEvent) => void;

export interface PersonaInfo {
  id: string;
  name: string;
  note: string;
}
