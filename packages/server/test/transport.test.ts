import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../../../config.js';
import { makeDeps } from './helpers.js';

const TOKEN = 'test-token';
const PROTOCOL = '2025-11-25';

let app: App;
let url: string;

beforeAll(async () => {
  app = createApp(loadConfig({ MCP_BEARER_TOKEN: TOKEN, PORT: '0' }), await makeDeps());
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await app.close();
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'conformance', version: '0.0.0' },
  },
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extra,
  };
}

function post(body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });
}

/** Reads a JSON-RPC message from either a JSON or an SSE response. */
async function rpc(res: Response): Promise<any> {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:') && line.slice(5).trim())
      .map((line) => line.slice(5).trim());
    return JSON.parse(data[data.length - 1] ?? 'null');
  }
  return JSON.parse(text);
}

async function openSession(): Promise<string> {
  const res = await post(initializeBody);
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  await res.text();
  const ack = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'Mcp-Session-Id': id!, 'MCP-Protocol-Version': PROTOCOL },
  );
  expect(ack.status).toBe(202);
  return id!;
}

describe('guards', () => {
  it('rejects a missing bearer token with 401', async () => {
    const res = await fetch(url, { method: 'POST', headers: { ...headers(), Authorization: '' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('rejects a wrong bearer token with 401', async () => {
    const res = await post(initializeBody, { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it('rejects a foreign Origin with 403', async () => {
    const res = await post(initializeBody, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('accepts a localhost Origin', async () => {
    const res = await post(initializeBody, { Origin: 'http://localhost:5173' });
    expect(res.status).toBe(200);
    await res.text();
  });

  it('returns 404 for other paths', async () => {
    const res = await fetch(url.replace('/mcp', '/other'), { headers: headers() });
    expect(res.status).toBe(404);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = await fetch(url, { method: 'PUT', headers: headers(), body: '{}' });
    expect(res.status).toBe(405);
  });

  it('returns 415 for a non-JSON content type', async () => {
    const res = await post(initializeBody, { 'Content-Type': 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: '{not json' });
    expect(res.status).toBe(400);
  });
});

describe('sessions (2025-era)', () => {
  it('issues Mcp-Session-Id at initialize and negotiates the protocol version', async () => {
    const res = await post(initializeBody);
    expect(res.status).toBe(200);
    const id = res.headers.get('mcp-session-id');
    expect(id).toMatch(/^[\x21-\x7e]+$/);
    const message = await rpc(res);
    expect(message.result.protocolVersion).toBe(PROTOCOL);
  });

  it('returns 400 when the session header is missing after initialize', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': 'does-not-exist', 'MCP-Protocol-Version': PROTOCOL },
    );
    expect(res.status).toBe(404);
  });

  it('returns 202 with no body for a notification', async () => {
    const id = await openSession();
    const res = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': PROTOCOL },
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('returns 400 for an unsupported MCP-Protocol-Version', async () => {
    const id = await openSession();
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': '1999-01-01' },
    );
    expect(res.status).toBe(400);
  });

  it('returns 406 when Accept does not list both response types', async () => {
    const res = await post(initializeBody, { Accept: 'application/json' });
    expect(res.status).toBe(406);
  });

  it('DELETE ends the session, after which it is unknown', async () => {
    const id = await openSession();
    const del = await fetch(url, {
      method: 'DELETE',
      headers: headers({ 'Mcp-Session-Id': id, 'MCP-Protocol-Version': PROTOCOL }),
    });
    expect(del.status).toBe(200);
    const after = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': PROTOCOL },
    );
    expect(after.status).toBe(404);
  });
});

describe('tools', () => {
  it('lists and calls a tool', async () => {
    const id = await openSession();
    const session = { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': PROTOCOL };

    const list = await rpc(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session));
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('get_product');

    const call = await rpc(
      await post(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_product', arguments: { product_id: 'brewwell-brew-pro-200' } } },
        session,
      ),
    );
    expect(call.result.structuredContent.model).toBe('Brew Pro 200');
  });
});
