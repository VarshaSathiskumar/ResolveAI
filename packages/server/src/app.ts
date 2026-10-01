import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  createMcpHandler,
  isInitializeRequest,
  isJsonContentType,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
  originValidation,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import { isAuthorized } from './auth.js';
import type { Config } from './config.js';
import { HttpError, readJsonBody, sendError } from './http.js';
import { createMcpServer } from './mcpServer.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ALLOWED_METHODS = ['POST', 'GET', 'DELETE'];

export interface App {
  server: Server;
  close(): Promise<void>;
}

/**
 * One HTTP endpoint serving both protocol eras:
 * - 2026-07-28 traffic (per-request envelope) goes to the SDK's stateless handler.
 * - 2025-era traffic (initialize handshake, Mcp-Session-Id) goes to a per-session transport.
 */
export function createApp(config: Config): App {
  const modern = createMcpHandler(createMcpServer, {
    legacy: 'reject',
    onerror: (error) => console.error('mcp handler error:', error.message),
  });
  const serveModern = toNodeHandler(modern, {
    onerror: (error) => console.error('mcp adapter error:', error.message),
  });
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

  const validateHost = hostHeaderValidation(config.allowedHosts);
  const validateOrigin = originValidation(config.allowedOrigins);

  async function serveLegacy(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;

    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        sendError(res, 404, 'Unknown or expired session', -32001);
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    sendError(res, 400, 'Mcp-Session-Id header is required', -32000);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    if (!isAuthorized(req.headers.authorization, config.bearerToken)) {
      sendError(res, 401, 'Unauthorized', -32001, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== MCP_PATH) {
      sendError(res, 404, 'Not found');
      return;
    }
    if (!req.method || !ALLOWED_METHODS.includes(req.method)) {
      sendError(res, 405, 'Method not allowed', -32000, { Allow: ALLOWED_METHODS.join(', ') });
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'])) {
        sendError(res, 415, 'Content-Type must be application/json');
        return;
      }
      body = await readJsonBody(req, MAX_BODY_BYTES);
    }

    const probe = await toWebRequest(req, body);
    if (await isLegacyRequest(probe, body)) {
      await serveLegacy(req, res, body);
    } else {
      await serveModern(req, res, body);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message, error.rpcCode);
        return;
      }
      console.error('unhandled request error:', error);
      sendError(res, 500, 'Internal server error', -32603);
    });
  });

  return {
    server,
    async close() {
      await modern.close();
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
