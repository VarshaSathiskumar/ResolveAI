import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { SimConfig } from '../config.js';
import { PERSONAS } from '../personas.js';
import { MAX_MESSAGE_CHARS, SessionError, type SessionManager } from './sessions.js';

const MAX_BODY_BYTES = 8 * 1024;
const HEARTBEAT_MS = 15_000;
/** Only these schemes can be read through the backend: cited document pages and MCP App views. */
const READABLE_URI = /^(doc|ui):\/\//;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
}

const createBody = z.object({ persona: z.string().min(1) });
const messageBody = z.object({ text: z.string() });

export interface SimApp {
  server: Server;
  close(): Promise<void>;
}

/**
 * The backend the web app talks to. It never returns the Anthropic credential or an MCP token, only ever allows the
 * configured web origin, and keeps every conversation behind an unguessable session id.
 */
export function createSimApp(config: SimConfig, sessions: SessionManager): SimApp {
  const sseClosers = new Set<() => void>();

  const cors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (origin !== undefined && !config.webOrigins.includes(origin)) {
      sendJson(res, 403, { error: 'This origin is not allowed' });
      return false;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    }
    return true;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function streamEvents(req: IncomingMessage, res: ServerResponse, id: string) {
    const session = sessions.get(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const write = (entry: { id: number; event: unknown }) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    // A reconnecting client sends the last id it saw; a new one gets everything so far.
    const lastSeen = Number(req.headers['last-event-id'] ?? 0) || 0;
    for (const entry of session.log) if (entry.id > lastSeen) write(entry);

    session.listeners.add(write);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const close = () => {
      clearInterval(heartbeat);
      session.listeners.delete(write);
      sseClosers.delete(close);
      if (!res.writableEnded) res.end();
    };
    sseClosers.add(close);
    req.on('close', close);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!cors(req, res)) return;
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(path);

    if (req.method === 'GET' && path === '/api/personas') return sendJson(res, 200, { personas: PERSONAS });
    if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, sessions: sessions.count(), model: config.agent.model });

    if (req.method === 'POST' && path === '/api/sessions') {
      const body = createBody.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, 'Say which persona to use');
      const session = await sessions.create(body.data.persona);
      return sendJson(res, 201, {
        sessionId: session.id,
        persona: session.persona,
        model: config.agent.model,
        tools: session.conversation.tools.map((tool) => tool.name),
      });
    }

    if (route) {
      const [, id, action] = route as unknown as [string, string, string | undefined];
      if (req.method === 'GET' && action === 'events') return streamEvents(req, res, id);

      if (req.method === 'POST' && action === 'messages') {
        const body = messageBody.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, `Send {"text": "..."} with at most ${MAX_MESSAGE_CHARS} characters`);
        sessions.send(id, body.data.text);
        return sendJson(res, 202, { accepted: true });
      }
      if (req.method === 'POST' && action === 'cancel') return sendJson(res, 200, { cancelled: sessions.cancel(id) });

      if (req.method === 'GET' && action === 'resource') {
        const uri = url.searchParams.get('uri') ?? '';
        if (!READABLE_URI.test(uri)) throw new HttpError(400, 'Only doc:// and ui:// resources can be read');
        const session = sessions.get(id);
        const resource = await session.mcp.readResource(uri).catch((error: unknown) => {
          throw new HttpError(404, error instanceof Error ? error.message : 'Resource not found');
        });
        return sendJson(res, 200, resource);
      }

      if (req.method === 'DELETE' && !action) {
        await sessions.close(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    throw new HttpError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError || error instanceof SessionError) return sendJson(res, error.status, { error: error.message });
      console.error('unhandled request error:', error);
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  return {
    server,
    async close() {
      for (const close of [...sseClosers]) close();
      await sessions.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
