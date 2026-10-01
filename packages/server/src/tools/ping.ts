import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Stub tool used to prove the transport end to end. Replaced by the real tools later. */
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health check. Replies with pong and echoes the optional message.',
      inputSchema: z.object({ message: z.string().optional() }),
      outputSchema: z.object({ reply: z.string() }),
    },
    async ({ message }) => {
      const output = { reply: message ? `pong: ${message}` : 'pong' };
      return {
        content: [{ type: 'text', text: output.reply }],
        structuredContent: output,
      };
    },
  );
}
