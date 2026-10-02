import { randomUUID } from 'node:crypto';
import type { TraceListener, TurnEndReason } from '../../shared/events.js';
import type { SimConfig } from '../../../../config.js';
import type { McpConnection, McpTool } from '../mcp/client.js';
import { toModelTools, type ModelTool } from '../mcp/tools.js';
import { summarizeToolResult } from '../summary.js';
import { analyzeMessage, deriveState } from './context.js';
import { guardCall } from './guard.js';
import { toLlmError, type Block, type LlmClient, type Message } from './llm.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TRACE_TEXT_LIMIT } from '../../../../config.js';

/**
 * One conversation with one customer. `messages` is append-only: earlier entries are never edited, trimmed or
 * reordered, because the API binds thinking blocks to the exact history that produced them. The only thing ever removed
 * is the whole of a turn that failed, before the next one begins.
 */
export interface Conversation {
  system: string;
  tools: ModelTool[];
  /** Tools whose result renders as an MCP App, by tool name to ui:// resource. */
  uiTools: Map<string, string>;
  messages: Message[];
  turns: number;
}

export function createConversation(tools: McpTool[], system: string = SYSTEM_PROMPT): Conversation {
  return {
    system,
    tools: toModelTools(tools),
    uiTools: new Map(tools.flatMap((tool) => (tool.uiResourceUri ? [[tool.name, tool.uiResourceUri] as const] : []))),
    messages: [],
    turns: 0,
  };
}

export interface TurnResult {
  turnId: string;
  reason: TurnEndReason;
  /** What the assistant said in its final message. Empty when the turn did not end normally. */
  text: string;
  rounds: number;
}

const isToolUse = (block: Block): block is Block & { id: string; name: string; input: unknown } =>
  block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string';

/**
 * The model sees the readable text plus a [data] block with the exact ids and flags the text leaves out (document
 * ids, product ids, `needs`). Long passages are dropped from the data block because the text already carries them.
 */
export function withData(text: string, structured: Record<string, unknown> | undefined): string {
  if (!structured) return text || '(no output)';
  const data = JSON.stringify(structured, (key, value) => (key === 'text' && typeof value === 'string' && value.length > 80 ? undefined : value));
  return `${text}\n\n[data] ${data}`;
}

export async function runTurn(args: {
  conversation: Conversation;
  userText: string;
  llm: LlmClient;
  mcp: McpConnection;
  config: SimConfig['agent'];
  emit: TraceListener;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const { conversation, userText, llm, mcp, config, emit, signal } = args;
  const turnId = randomUUID();
  const turnStarted = performance.now();
  let rounds = 0;

  const finish = (reason: TurnEndReason, text = ''): TurnResult => {
    emit({ type: 'turn_complete', turnId, ms: performance.now() - turnStarted, rounds, reason, text });
    return { turnId, reason, text, rounds };
  };

  if (conversation.turns >= config.maxTurnsPerSession) {
    emit({ type: 'error', turnId, message: `This session reached its limit of ${config.maxTurnsPerSession} turns. Start a new one.`, retryable: false });
    return finish('error');
  }

  emit({ type: 'turn_started', turnId, at: Date.now(), userText });
  const checkpoint = conversation.messages.length;
  // What the conversation already settled, and what this line is, travel with the line itself. The note is written once,
  // here, so the history stays append-only and the cached prefix is untouched.
  const { note } = analyzeMessage(conversation.messages, userText);
  conversation.messages.push({ role: 'user', content: note ? [{ type: 'text', text: userText }, { type: 'text', text: note }] : userText });
  conversation.turns += 1;
  const rollBack = () => {
    conversation.messages.length = checkpoint;
  };

  try {
    for (let round = 1; round <= config.maxRounds; round++) {
      rounds = round;
      signal?.throwIfAborted();
      const callStarted = performance.now();
      const response = await llm.stream(
        {
          model: config.model,
          system: conversation.system,
          tools: conversation.tools,
          messages: conversation.messages,
          maxTokens: config.maxTokens,
          effort: config.effort,
          fallback: config.fallback,
          signal,
        },
        (text) => emit({ type: 'text_delta', turnId, round, text }),
      );
      // A cancelled turn is never committed, even if the client finished its call before noticing.
      signal?.throwIfAborted();
      emit({
        type: 'model_call',
        turnId,
        round,
        model: response.model,
        ms: performance.now() - callStarted,
        stopReason: response.stopReason,
        usage: response.usage,
        ...(response.servedBy ? { servedBy: response.servedBy } : {}),
      });

      // A declined or cut-off reply cannot be used or continued, so the whole turn is dropped.
      if (response.stopReason === 'refusal') {
        rollBack();
        return finish('refusal');
      }
      if (response.stopReason === 'max_tokens') {
        rollBack();
        return finish('max_tokens');
      }

      conversation.messages.push({ role: 'assistant', content: response.content });
      const toolUses = response.content.filter(isToolUse);
      if (response.stopReason !== 'tool_use' || toolUses.length === 0) {
        const text = response.content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
        return finish('end_turn', text);
      }

      // Run the calls together and answer them all in one user message, in the order they were asked.
      const state = deriveState(conversation.messages);
      const results = await Promise.all(
        toolUses.map(async (use): Promise<Block> => {
          const asked = typeof use.input === 'object' && use.input !== null && !Array.isArray(use.input) ? (use.input as Record<string, unknown>) : undefined;
          const decision = asked ? guardCall(state, conversation.tools, use.name, asked) : undefined;
          const input = decision?.action === 'run' ? decision.input : use.input;
          emit({ type: 'tool_call', turnId, round, toolUseId: use.id, name: use.name, input, at: Date.now() });
          const started = performance.now();
          let ok = true;
          let text: string;
          let structured: Record<string, unknown> | undefined;
          let ms: number;
          let skipped: 'not_needed' | 'repeat' | undefined;
          try {
            if (!asked) throw new Error('The tool arguments were not a JSON object.');
            if (decision?.action === 'skip') {
              skipped = decision.reason;
              text = decision.text;
              ms = 0;
            } else {
              const result = await mcp.callTool(use.name, (decision?.input ?? asked) as Record<string, unknown>, { signal });
              ok = result.ok;
              text = decision?.note ? `Note: ${decision.note}\n${result.text}` : result.text;
              structured = result.structured;
              ms = result.ms;
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            ok = false;
            text = `The ${use.name} tool failed: ${error instanceof Error ? error.message : String(error)}`;
            ms = performance.now() - started;
          }
          emit({
            type: 'tool_result',
            turnId,
            round,
            toolUseId: use.id,
            name: use.name,
            ok,
            ms,
            summary: skipped
              ? { headline: skipped === 'repeat' ? 'skipped: same call as before' : 'skipped: not needed', badges: ['skipped'], citations: [] }
              : summarizeToolResult(use.name, ok, structured, text),
            text: text.length > TRACE_TEXT_LIMIT ? `${text.slice(0, TRACE_TEXT_LIMIT)}...` : text,
            ...(skipped ? { skipped } : {}),
          });
          const uri = conversation.uiTools.get(use.name);
          if (ok && uri && !skipped) {
            emit({ type: 'ui_resource', turnId, toolUseId: use.id, uri, toolName: use.name, input, result: { text, ...(structured ? { structuredContent: structured } : {}) } });
          }
          return { type: 'tool_result', tool_use_id: use.id, content: ok ? withData(text, structured) : text, ...(ok ? {} : { is_error: true }) };
        }),
      );
      signal?.throwIfAborted();
      conversation.messages.push({ role: 'user', content: results });
    }

    rollBack();
    return finish('max_rounds');
  } catch (error) {
    rollBack();
    if (signal?.aborted) return finish('aborted');
    const failure = toLlmError(error);
    emit({ type: 'error', turnId, message: failure.message, retryable: failure.retryable });
    return finish('error');
  }
}
