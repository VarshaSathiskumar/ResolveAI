import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeDeps } from './helpers.js';

const TOKEN = 'test-token';

let app: App;
let url: URL;

beforeAll(async () => {
  app = createApp(loadConfig({ MCP_BEARER_TOKEN: TOKEN, PORT: '0' }), await makeDeps());
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await app.close();
});

function transport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
}

async function pingWith(client: Client): Promise<unknown> {
  await client.connect(transport());
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');
    const result = await client.callTool({ name: 'ping', arguments: { message: 'sdk' } });
    return result.structuredContent;
  } finally {
    await client.close();
  }
}

describe('SDK client against the server', () => {
  it('works over the 2025-era session handshake', async () => {
    const client = new Client({ name: 'legacy-client', version: '0.0.0' });
    expect(await pingWith(client)).toEqual({ reply: 'pong: sdk' });
  });

  it('works over the pinned 2026-07-28 stateless path', async () => {
    const client = new Client(
      { name: 'modern-client', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    expect(await pingWith(client)).toEqual({ reply: 'pong: sdk' });
  });
});
