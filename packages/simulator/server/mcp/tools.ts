import type { McpTool } from './client.js';

/** A tool in the shape the Claude API takes. */
export interface ModelTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

/**
 * MCP tool definitions to Claude tool definitions. The list is sorted and every field is deterministic, because the
 * tool definitions are the start of the cached prefix: anything that varies between turns would defeat prompt caching.
 */
export function toModelTools(tools: McpTool[]): ModelTool[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      // `$schema` is metadata the API does not need, and it adds bytes to every request.
      const { $schema: _ignored, ...schema } = tool.inputSchema as { $schema?: unknown; type?: string };
      void _ignored;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: { ...schema, type: 'object' as const },
      };
    });
}
