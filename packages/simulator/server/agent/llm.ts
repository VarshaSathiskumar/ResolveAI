import Anthropic from '@anthropic-ai/sdk';
import type { Usage } from '../../shared/events.js';
import type { ModelTool } from '../mcp/tools.js';

/** A content block exactly as the API returned it. Kept opaque so it can be sent back unchanged. */
export type Block = { type: string; [key: string]: unknown };

export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface LlmRequest {
  model: string;
  system: string;
  tools: ModelTool[];
  messages: Message[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Retry on another model if a safety classifier declines this request. */
  fallback: boolean;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: Block[];
  stopReason: string | null;
  usage: Usage;
  model: string;
  /** Set when the refusal fallback served the call on a different model. */
  servedBy?: string;
}

export interface LlmClient {
  /** Streams one model call, reporting text as it arrives, and resolves with the complete message. */
  stream(request: LlmRequest, onText: (delta: string) => void): Promise<LlmResponse>;
}

export type LlmErrorKind = 'rate_limit' | 'auth' | 'bad_request' | 'overloaded' | 'connection' | 'aborted' | 'other';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  /** Worth trying the same call again. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'connection';
  }
}

/** Maps the SDK's typed errors, most specific first, so callers never match on message text. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new LlmError('aborted', 'The request was cancelled');
  if (error instanceof Anthropic.AuthenticationError) return new LlmError('auth', 'The Anthropic credential was rejected', error.status);
  if (error instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', 'Rate limited by the Anthropic API', error.status);
  if (error instanceof Anthropic.BadRequestError) return new LlmError('bad_request', error.message, error.status);
  if (error instanceof Anthropic.APIConnectionError) return new LlmError('connection', 'Could not reach the Anthropic API');
  if (error instanceof Anthropic.APIError) {
    const overloaded = error.status === 529 || (error.status !== undefined && error.status >= 500);
    return new LlmError(overloaded ? 'overloaded' : 'other', error.message, error.status);
  }
  return new LlmError('other', error instanceof Error ? error.message : String(error));
}

/** The Claude API, streamed. The system prompt and tool list are sent byte-identical on every call so they cache. */
export function createAnthropicLlm(client: Anthropic = new Anthropic()): LlmClient {
  return {
    async stream(request, onText) {
      try {
        const stream = client.beta.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: [{ type: 'text', text: request.system }],
            tools: request.tools as Anthropic.Beta.BetaTool[],
            messages: request.messages as Anthropic.Beta.BetaMessageParam[],
            // Caches the longest stable prefix (tools, system, earlier turns) without placing breakpoints by hand.
            cache_control: { type: 'ephemeral' },
            ...(request.effort ? { output_config: { effort: request.effort } } : {}),
            ...(request.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          },
          { signal: request.signal },
        );
        stream.on('text', (delta) => onText(delta));
        const message = await stream.finalMessage();

        const usage = message.usage as unknown as Record<string, number | undefined>;
        const content = message.content as unknown as Block[];
        const fallback = content.find((block) => block.type === 'fallback') as { to?: { model?: string } } | undefined;
        return {
          // Returned as is: the history must stay append-only, thinking blocks included.
          content,
          stopReason: message.stop_reason,
          model: message.model,
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          },
          ...(fallback?.to?.model ? { servedBy: fallback.to.model } : {}),
        };
      } catch (error) {
        throw toLlmError(error);
      }
    },
  };
}
