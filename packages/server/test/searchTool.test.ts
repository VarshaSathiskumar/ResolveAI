import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../../../config.js';
import { makeDeps } from './helpers.js';

const TOKEN = 'test-token';

let app: App;
let client: Client;

beforeAll(async () => {
  app = createApp(loadConfig({ MCP_BEARER_TOKEN: TOKEN, PORT: '0' }), await makeDeps());
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  client = new Client({ name: 'search-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
  );
});

afterAll(async () => {
  await client.close();
  await app.close();
});

async function search(args: Record<string, unknown>) {
  return client.callTool({ name: 'search_troubleshooting', arguments: args });
}

describe('search_troubleshooting tool', () => {
  it('is listed with guidance on how to read confidence', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'search_troubleshooting');
    expect(tool?.description).toMatch(/confidence/);
    expect(tool?.description).toMatch(/low/);
  });

  it('returns structured results with citations, confidence and next-step hints', async () => {
    const result = await search({ query: 'it says E04', product_id: 'brewwell-brew-pro-300' });
    const output = result.structuredContent as {
      confidence: string;
      needs: string[];
      results: { citation: string; page: number; text: string; product_id: string }[];
    };
    expect(output.confidence).not.toBe('low');
    expect(output.needs).toEqual([]);
    expect(output.results[0]?.text).toMatch(/E04/);
    expect(output.results[0]?.citation).toMatch(/Brew Pro 300.*page \d+/);
    expect(output.results.every((hit) => hit.product_id === 'brewwell-brew-pro-300')).toBe(true);
  });

  it('reports synonym matches in the structured output', async () => {
    const result = await search({ query: 'I think the needle is jammed', product_id: 'brewwell-brew-pro-200' });
    const output = result.structuredContent as {
      unknown_terms: string[];
      synonym_matches: { term: string; matched: string }[];
    };
    expect(output.unknown_terms).not.toContain('jammed');
    expect(output.synonym_matches.map((entry) => entry.term)).toContain('jammed');
  });

  it('puts the citation and the text in the human-readable content too', async () => {
    const result = await search({ query: 'needle clogged', product_id: 'brewwell-brew-pro-200' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^Confidence: /);
    expect(text).toMatch(/Brewwell Brew Pro 200 Troubleshooting Guide, page 2/);
  });

  it('flags an unscoped, ambiguous search so the agent asks which product', async () => {
    const result = await search({ query: 'Brew Pro is not brewing' });
    expect((result.structuredContent as { needs: string[] }).needs).toContain('product_id');
  });

  it('returns a tool error for an unknown product id', async () => {
    const result = await search({ query: 'not brewing', product_id: 'no-such-product' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/list_owned_products|identify_product/);
  });

  it('rejects an out-of-range limit', async () => {
    const result = await search({ query: 'not brewing', limit: 50 }).catch((error: Error) => error);
    const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });
});
