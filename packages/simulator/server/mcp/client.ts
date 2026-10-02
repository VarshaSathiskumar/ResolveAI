import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../../../../config.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP Apps link: `_meta.ui.resourceUri` names the ui:// resource that renders this tool's result. */
  uiResourceUri?: string;
}

export interface ToolCallResult {
  ok: boolean;
  /** The text content the model will see. */
  text: string;
  structured?: Record<string, unknown>;
  ms: number;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
  meta?: Record<string, unknown>;
}

/** One authenticated connection to the ResolveAI MCP server, for one persona. */
export interface McpConnection {
  /** Tools sorted by name, so the list is byte-stable and the prompt cache prefix does not move. */
  tools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ToolCallResult>;
  readResource(uri: string): Promise<ResourceContent>;
  close(): Promise<void>;
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function uiResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  if (typeof ui?.resourceUri === 'string') return ui.resourceUri;
  // The older flat key some servers still use.
  const flat = meta?.['ui/resourceUri'];
  return typeof flat === 'string' ? flat : undefined;
}

export async function connectMcp(options: { url: string; token: string; clientName?: string }): Promise<McpConnection> {
  const client = new Client({ name: options.clientName ?? 'resolveai-simulator', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    }),
  );

  let cached: McpTool[] | undefined;

  return {
    async tools() {
      if (cached) return cached;
      const listed: RawTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        listed.push(...(page.tools as RawTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      cached = listed
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          ...(uiResourceUri(tool._meta) ? { uiResourceUri: uiResourceUri(tool._meta) } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return cached;
    },

    async callTool(name, args, callOptions = {}) {
      const started = performance.now();
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: callOptions.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, signal: callOptions.signal },
      );
      const content = (result.content ?? []) as { type: string; text?: string }[];
      const text = content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
      return {
        ok: result.isError !== true,
        text,
        ...(result.structuredContent ? { structured: result.structuredContent as Record<string, unknown> } : {}),
        ms: performance.now() - started,
      };
    },

    async readResource(uri) {
      const result = await client.readResource({ uri });
      const first = result.contents[0] as { uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> } | undefined;
      if (!first || typeof first.text !== 'string') throw new Error(`Resource ${uri} has no text content`);
      return { uri: first.uri, mimeType: first.mimeType, text: first.text, ...(first._meta ? { meta: first._meta } : {}) };
    },

    close: () => client.close(),
  };
}
