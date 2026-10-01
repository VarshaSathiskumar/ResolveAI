import { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './deps.js';
import { registerPingTool } from './tools/ping.js';
import { registerSearchTroubleshootingTool } from './tools/searchTroubleshooting.js';

/** Builds a fresh server instance. Both transport eras call this, so tools are defined once. */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'resolveai', version: '0.0.0' });
  registerPingTool(server);
  registerSearchTroubleshootingTool(server, deps);
  return server;
}
