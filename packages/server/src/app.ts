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
import { authenticate, principalFromAuthInfo, toAuthInfo, type Principal } from './auth.js';
import type { Config } from '../../../config.js';
import type { ServerDeps } from './deps.js';
import { HttpError, readJsonBody, sendError } from './http.js';
import { createMcpServer } from './mcpServer.js';
import { SERVER_ALLOWED_METHODS, SERVER_MAX_BODY_BYTES, SERVER_MCP_PATH } from '../../../config.js';

export interface App {
  server: Server;
  close(): Promise<void>;
}

/**
 * One HTTP endpoint serving both protocol eras:
 * - 2026-07-28 traffic (per-request envelope) goes to the SDK's stateless handler.
 * - 2025-era traffic (initialize handshake, Mcp-Session-Id) goes to a per-session transport.
 */
export function createApp(config: Config, deps: ServerDeps): App {
  const modern = createMcpHandler((ctx) => createMcpServer(deps, principalFromAuthInfo(ctx.authInfo)), {
    legacy: 'reject',
    onerror: (error) => console.error('mcp handler error:', error.message),
  });
  const serveModern = toNodeHandler(modern, {
    onerror: (error) => console.error('mcp adapter error:', error.message),
  });
  /** Each session belongs to the user whose token opened it. */
  const sessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; userId?: string }>();

  const validateHost = hostHeaderValidation(config.allowedHosts);
  const validateOrigin = originValidation(config.allowedOrigins);

  async function serveLegacy(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    principal: Principal,
  ): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      // Another user's session looks exactly like one that does not exist.
      if (!session || session.userId !== principal.userId) {
        sendError(res, 404, 'Unknown or expired session', -32001);
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, userId: principal.userId });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer(deps, principal).connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    sendError(res, 400, 'Mcp-Session-Id header is required', -32000);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const principal = authenticate(req.headers.authorization, config);
    if (!principal) {
      sendError(res, 401, 'Unauthorized', -32001, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    // The node adapter hands req.auth to the stateless handler as authInfo.
    (req as IncomingMessage & { auth?: ReturnType<typeof toAuthInfo> }).auth = toAuthInfo(principal);

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== SERVER_MCP_PATH) {
      sendError(res, 404, 'Not found');
      return;
    }
    if (!req.method || !SERVER_ALLOWED_METHODS.includes(req.method)) {
      sendError(res, 405, 'Method not allowed', -32000, { Allow: SERVER_ALLOWED_METHODS.join(', ') });
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'])) {
        sendError(res, 415, 'Content-Type must be application/json');
        return;
      }
      body = await readJsonBody(req, SERVER_MAX_BODY_BYTES);
    }

    const probe = await toWebRequest(req, body);
    if (await isLegacyRequest(probe, body)) {
      await serveLegacy(req, res, body, principal);
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
      await Promise.all([...sessions.values()].map((session) => session.transport.close()));
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
