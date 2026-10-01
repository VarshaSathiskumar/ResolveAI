import { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from './auth.js';
import type { ServerDeps } from './deps.js';
import { registerGetProductTool } from './tools/getProduct.js';
import { registerIdentifyProductTool } from './tools/identifyProduct.js';
import { registerListOwnedProductsTool } from './tools/listOwnedProducts.js';
import { registerPingTool } from './tools/ping.js';
import { registerSearchTroubleshootingTool } from './tools/searchTroubleshooting.js';

/**
 * Builds a fresh server instance for one user. Both transport eras call this, so tools are
 * defined once, and the principal is fixed when the instance is created rather than read per call.
 */
export function createMcpServer(deps: ServerDeps, principal: Principal = {}): McpServer {
  const server = new McpServer({ name: 'resolveai', version: '0.0.0' });
  registerPingTool(server);
  registerListOwnedProductsTool(server, deps, principal);
  registerIdentifyProductTool(server, deps, principal);
  registerGetProductTool(server, deps);
  registerSearchTroubleshootingTool(server, deps);
  return server;
}
