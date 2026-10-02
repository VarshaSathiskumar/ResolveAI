import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../../../config.js';
import { makeDeps } from './helpers.js';

const TOKENS = { alex: 'token-alex', service: 'token-service' };

let app: App;
let url: URL;

beforeAll(async () => {
  app = createApp(
    loadConfig({
      MCP_USER_TOKENS: `${TOKENS.alex}:demo-alex`,
      MCP_BEARER_TOKEN: TOKENS.service,
      PORT: '0',
    }),
    await makeDeps(),
  );
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await app.close();
});

type Era = 'legacy' | 'modern';

async function call(era: Era, token: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client(
    { name: 'product-tools-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

interface Owned {
  resolution: string;
  needs: string[];
  note?: string;
  owned: { product_id: string; model: string }[];
}

describe.each(['legacy', 'modern'] as const)('list_owned_products over the %s transport', (era) => {
  it('resolves to the one coffee machine Alex owns, with nothing to ask', async () => {
    const out = (await call(era, TOKENS.alex, 'list_owned_products', { category: 'coffee machine' })).structuredContent as Owned;
    expect(out.resolution).toBe('one');
    expect(out.needs).toEqual([]);
    expect(out.owned.map((product) => product.product_id)).toEqual(['brewwell-brew-pro-200']);
  });

  it('lists all eleven products Alex owns when no kind is given', async () => {
    const out = (await call(era, TOKENS.alex, 'list_owned_products')).structuredContent as Owned;
    expect(out.resolution).toBe('several');
    expect(out.needs).toEqual(['which_product']);
    expect(out.owned).toHaveLength(11);
  });

  it('has no products for the token that has no user behind it', async () => {
    const out = (await call(era, TOKENS.service, 'list_owned_products')).structuredContent as Owned;
    expect(out.resolution).toBe('none');
    expect(out.note).toMatch(/No account/);
  });

  it('flags the owned product when identifying', async () => {
    const out = (await call(era, TOKENS.alex, 'identify_product', { description: 'Brew Pro' })).structuredContent as {
      ambiguous: boolean;
      candidates: { product_id: string; owned: boolean }[];
    };
    expect(out.ambiguous).toBe(true);
    expect(out.candidates[0]).toMatchObject({ product_id: 'brewwell-brew-pro-200', owned: true });
  });
});

describe('identify_product and get_product tools', () => {
  it('returns the product record with its documents and page counts', async () => {
    const result = await call('legacy', TOKENS.alex, 'get_product', { product_id: 'brewwell-brew-pro-200' });
    const out = result.structuredContent as {
      model: string;
      warranty_term_months: number;
      known_issues: string[];
      documents: { type: string; title: string; pages: number }[];
    };
    expect(out.model).toBe('Brew Pro 200');
    expect(out.warranty_term_months).toBe(24);
    expect(out.known_issues).toContain('clogged piercing needle');
    expect(out.documents.map((doc) => doc.type)).toEqual(['manual', 'troubleshooting', 'warranty']);
    expect(out.documents.find((doc) => doc.type === 'manual')?.pages).toBe(8);
  });

  it('returns a tool error for an unknown product id', async () => {
    const result = await call('legacy', TOKENS.alex, 'get_product', { product_id: 'nope' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/identify_product/);
  });
});

describe('sessions belong to the user who opened them', () => {
  const headers = (token: string, extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extra,
  });

  async function openSession(token: string): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolation', version: '0' } },
      }),
    });
    await res.text();
    return res.headers.get('mcp-session-id')!;
  }

  const listTools = (token: string, sessionId: string) =>
    fetch(url, {
      method: 'POST',
      headers: headers(token, { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-11-25' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

  it("treats another user's session id as unknown", async () => {
    const alexSession = await openSession(TOKENS.alex);
    expect((await listTools(TOKENS.alex, alexSession)).status).toBe(200);
    expect((await listTools(TOKENS.service, alexSession)).status).toBe(404);
  });

  it('treats an anonymous session as unavailable to a user token', async () => {
    const anonymousSession = await openSession(TOKENS.service);
    expect((await listTools(TOKENS.alex, anonymousSession)).status).toBe(404);
  });

  it('still rejects an unknown token with 401', async () => {
    const res = await fetch(url, { method: 'POST', headers: headers('nope'), body: '{}' });
    expect(res.status).toBe(401);
  });
});
