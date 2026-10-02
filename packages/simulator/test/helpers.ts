import type { TraceEvent } from '../shared/events.js';
import type { Block, LlmClient, LlmRequest, LlmResponse, Message } from '../server/agent/llm.js';
import type { SimConfig } from '../../../config.js';
import { startTestApp, TOKENS, type TestApp } from '../../server/test/testApp.js';
import { connectMcp, type McpConnection } from '../server/mcp/client.js';

export { TOKENS };

export const AGENT: SimConfig['agent'] = {
  model: 'claude-sonnet-5-5',
  effort: 'low',
  fallback: true,
  maxTokens: 8192,
  maxRounds: 4,
  maxTurnsPerSession: 5,
};

export const textBlock = (text: string): Block => ({ type: 'text', text });
export const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input });

const USAGE = { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function reply(content: Block[], stopReason: string | null = 'end_turn', extra: Partial<LlmResponse> = {}): LlmResponse {
  return { content, stopReason, usage: USAGE, model: 'claude-sonnet-5-5', ...extra };
}

export const sayThenStop = (text: string): LlmResponse => reply([textBlock(text)]);
export const callTools = (...uses: Block[]): LlmResponse => reply(uses, 'tool_use');

export interface ScriptedLlm extends LlmClient {
  requests: LlmRequest[];
  /** Deep copies of the messages at the moment each call was made. */
  history: Message[][];
}

/** A stand-in model: each call gets the next scripted response (a function sees the request and call index). */
export function scriptedLlm(
  script: (LlmResponse | ((request: LlmRequest, index: number) => LlmResponse | Promise<LlmResponse>))[],
): ScriptedLlm {
  const requests: LlmRequest[] = [];
  const history: Message[][] = [];
  return {
    requests,
    history,
    async stream(request, onText) {
      const index = requests.length;
      requests.push(request);
      history.push(JSON.parse(JSON.stringify(request.messages)) as Message[]);
      const step = script[Math.min(index, script.length - 1)]!;
      const response = typeof step === 'function' ? await step(request, index) : step;
      for (const block of response.content) {
        if (block.type === 'text') for (const word of String(block.text).split(/(?<= )/)) onText(word);
      }
      return response;
    },
  };
}

export const collect = () => {
  const events: TraceEvent[] = [];
  return { events, emit: (event: TraceEvent) => void events.push(event), of: <T extends TraceEvent['type']>(type: T) => events.filter((e): e is Extract<TraceEvent, { type: T }> => e.type === type) };
};

export interface Stack {
  app: TestApp;
  connect(persona: 'alex' | 'raj' | 'service'): Promise<McpConnection>;
  close(): Promise<void>;
}

/** The real ResolveAI MCP server, in process, with the demo users. */
export async function startStack(options: { ticketCardHtml?: string } = {}): Promise<Stack> {
  const app = await startTestApp(options);
  const open: McpConnection[] = [];
  return {
    app,
    async connect(persona) {
      const connection = await connectMcp({ url: app.url.toString(), token: TOKENS[persona] });
      open.push(connection);
      return connection;
    },
    async close() {
      await Promise.all(open.map((connection) => connection.close().catch(() => {})));
      await app.close();
    },
  };
}
