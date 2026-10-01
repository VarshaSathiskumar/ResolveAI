import { McpServer } from '@modelcontextprotocol/server';
import { registerPingTool } from './tools/ping.js';

/** Builds a fresh server instance. Both transport eras call this, so tools are defined once. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'resolveai', version: '0.0.0' });
  registerPingTool(server);
  return server;
}
