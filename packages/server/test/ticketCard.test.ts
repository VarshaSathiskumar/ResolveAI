import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getToolUiResourceUri, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTicketCardHtml } from '../src/ui/ticketCard.js';
import { startTestApp, TOKENS, type TestApp } from './testApp.js';
import { TICKET_CARD_URI } from '../../../config.js';

const HTML = '<!doctype html><html><body>ticket card</body></html>';
const apps: TestApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

async function connect(options: { ticketCardHtml?: string }) {
  const app = await startTestApp(options);
  apps.push(app);
  const client = new Client({ name: 'card-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(app.url, { requestInit: { headers: { Authorization: `Bearer ${TOKENS.alex}` } } }));
  return { app, client };
}

describe('ticket card, built', () => {
  it('links create_support_case to the ui:// resource and leaves the other tools plain', async () => {
    const { client } = await connect({ ticketCardHtml: HTML });
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === 'create_support_case')!;
    expect(getToolUiResourceUri(create)).toBe(TICKET_CARD_URI);
    expect(tools.filter((tool) => getToolUiResourceUri(tool) !== undefined).map((tool) => tool.name)).toEqual(['create_support_case']);
  });

  it('serves the view as an MCP App resource with the right MIME type', async () => {
    const { client } = await connect({ ticketCardHtml: HTML });
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(TICKET_CARD_URI);
    const read = await client.readResource({ uri: TICKET_CARD_URI });
    expect(read.contents[0]).toMatchObject({ uri: TICKET_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: HTML });
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
  });

  it('declares no network access for the view', async () => {
    const { client } = await connect({ ticketCardHtml: HTML });
    const content = (await client.readResource({ uri: TICKET_CARD_URI })).contents[0] as { _meta?: { ui?: { csp?: unknown } } };
    expect(content._meta?.ui?.csp).toBeUndefined();
  });

  it('returns the same text and structured ticket as the plain tool, so the model and text-only clients are unaffected', async () => {
    const { client } = await connect({ ticketCardHtml: HTML });
    await client.callTool({ name: 'record_diagnostic_step', arguments: { kind: 'step', content: 'Cleaned the needle', product_id: 'brewwell-brew-pro-200', symptom: 'drips', new_case: true } });
    const result = await client.callTool({ name: 'create_support_case', arguments: { summary: 'Still dripping after cleaning the needle.' } });
    expect((result.content[0] as { text: string }).text).toMatch(/Support ticket created: RAI-\d{4}-\d{6} \(simulated\)/);
    expect(result.structuredContent).toMatchObject({ simulated: true, product: { model: 'Brew Pro 200' }, steps_tried: ['Cleaned the needle'] });
  });
});

describe('ticket card, not built', () => {
  it('is a plain text tool with no ui:// resource, and the resource cannot be read', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(getToolUiResourceUri(tools.find((tool) => tool.name === 'create_support_case')!)).toBeUndefined();
    const { resources } = await client.listResources().catch(() => ({ resources: [] as { uri: string }[] }));
    expect(resources.map((resource) => resource.uri)).not.toContain(TICKET_CARD_URI);
    await expect(client.readResource({ uri: TICKET_CARD_URI })).rejects.toThrow();
  });
});

describe('loadTicketCardHtml', () => {
  it('reads the built view when it exists and is undefined when it does not', () => {
    const built = resolve(import.meta.dirname, '../dist/ui/ticket-card.html');
    const html = loadTicketCardHtml();
    if (existsSync(built)) {
      expect(html).toBe(readFileSync(built, 'utf8'));
      expect(html).toContain('<html');
    } else {
      expect(html).toBeUndefined();
    }
  });
});
