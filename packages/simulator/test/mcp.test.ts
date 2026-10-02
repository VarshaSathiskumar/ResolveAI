import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toModelTools } from '../server/mcp/tools.js';
import type { McpConnection } from '../server/mcp/client.js';
import { startStack, type Stack } from './helpers.js';

let stack: Stack;
let alex: McpConnection;

beforeAll(async () => {
  stack = await startStack();
  alex = await stack.connect('alex');
});

afterAll(() => stack.close());

describe('MCP connection', () => {
  it('lists the server tools sorted by name', async () => {
    const names = (await alex.tools()).map((tool) => tool.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual(
      expect.arrayContaining(['check_warranty', 'create_support_case', 'get_case_state', 'get_document_section', 'get_product', 'identify_product', 'list_owned_products', 'record_diagnostic_step', 'search_troubleshooting']),
    );
  });

  it('calls a tool as the persona and returns text, structured output and a time', async () => {
    const result = await alex.callTool('list_owned_products', {});
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/One registered product/);
    expect((result.structured as { resolution: string }).resolution).toBe('one');
    expect(result.ms).toBeGreaterThan(0);
  });

  it('reports a failed tool call as not ok, with the tool message', async () => {
    const result = await alex.callTool('get_product', { product_id: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Unknown product_id/);
  });

  it('reads a document page resource', async () => {
    const product = (await alex.callTool('get_product', { product_id: 'brewwell-brew-pro-200' })).structured as { documents: { document_id: number; type: string }[] };
    const documentId = product.documents.find((doc) => doc.type === 'troubleshooting')!.document_id;
    const resource = await alex.readResource(`doc://${documentId}#p2`);
    expect(resource.text).toMatch(/Clogged needle/);
  });

  it('gives up on a call that outlasts its time limit or is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(alex.callTool('list_owned_products', {}, { signal: controller.signal })).rejects.toThrow();
  });
});

describe('toModelTools', () => {
  it('maps MCP schemas to Claude tools, sorted, and drops $schema so the cached prefix is lean and stable', async () => {
    const tools = toModelTools(await alex.tools());
    expect(tools.map((tool) => tool.name)).toEqual([...tools.map((tool) => tool.name)].sort((a, b) => a.localeCompare(b)));
    for (const tool of tools) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema).not.toHaveProperty('$schema');
      expect(tool.description.length).toBeGreaterThan(20);
    }
    const search = tools.find((tool) => tool.name === 'search_troubleshooting')!;
    expect((search.input_schema.properties as Record<string, unknown>).product_id).toBeDefined();
  });

  it('is byte-identical every time, which is what prompt caching needs', async () => {
    const first = JSON.stringify(toModelTools(await alex.tools()));
    const again = JSON.stringify(toModelTools([...(await alex.tools())].reverse()));
    expect(again).toBe(first);
  });
});
