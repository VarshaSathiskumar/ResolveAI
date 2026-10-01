import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TOKENS, type TestApp } from './testApp.js';

let app: TestApp;
let troubleshootingId: number;

beforeAll(async () => {
  app = await startTestApp();
  const product = (await app.call('legacy', TOKENS.alex, 'get_product', { product_id: 'brewwell-brew-pro-200' })).structuredContent as {
    documents: { document_id: number; type: string }[];
  };
  troubleshootingId = product.documents.find((doc) => doc.type === 'troubleshooting')!.document_id;
});

afterAll(() => app.close());

interface Section {
  document: { document_id: number; title: string; pages: number; product_model: string };
  uri: string;
  citation: string;
  chunks: { page: number; section: string; text: string }[];
}

const section = async (args: Record<string, unknown>) =>
  (await app.call('legacy', TOKENS.alex, 'get_document_section', { document_id: troubleshootingId, ...args })).structuredContent as Section;

describe('get_document_section', () => {
  it('returns every chunk on the page with a citation and a uri', async () => {
    const out = await section({ page: 2 });
    expect(out.citation).toBe('Brewwell Brew Pro 200 Troubleshooting Guide, page 2');
    expect(out.uri).toBe(`doc://${troubleshootingId}#p2`);
    expect(out.document).toMatchObject({ pages: 4, product_model: 'Brew Pro 200' });
    expect(out.chunks.every((chunk) => chunk.page === 2)).toBe(true);
    expect(out.chunks.map((chunk) => chunk.section).join(' ')).toMatch(/Clogged needle/);
  });

  it('can include the neighbouring pages', async () => {
    const out = await section({ page: 2, include_adjacent_pages: true });
    expect([...new Set(out.chunks.map((chunk) => chunk.page))]).toEqual([1, 2, 3]);
  });

  it('does not run off the ends of the document', async () => {
    expect([...new Set((await section({ page: 1, include_adjacent_pages: true })).chunks.map((c) => c.page))]).toEqual([1, 2]);
    expect([...new Set((await section({ page: 4, include_adjacent_pages: true })).chunks.map((c) => c.page))]).toEqual([3, 4]);
  });

  it('returns a tool error for a page past the end or an unknown document', async () => {
    const pastEnd = await app.call('legacy', TOKENS.alex, 'get_document_section', { document_id: troubleshootingId, page: 99 });
    expect(pastEnd.isError).toBe(true);
    expect((pastEnd.content[0] as { text: string }).text).toMatch(/4 pages/);
    const unknown = await app.call('legacy', TOKENS.alex, 'get_document_section', { document_id: 99999, page: 1 });
    expect(unknown.isError).toBe(true);
  });
});

describe('document resource', () => {
  it('reads a cited page by its uri', async () => {
    const read = await app.readResource(TOKENS.alex, `doc://${troubleshootingId}#p2`);
    const content = read.contents[0] as { uri: string; text: string; mimeType?: string };
    expect(content.text).toMatch(/Troubleshooting Guide, page 2/);
    expect(content.text).toMatch(/Clogged needle/);
    expect(content.mimeType).toBe('text/markdown');
  });

  it('fails for a page that does not exist', async () => {
    await expect(app.readResource(TOKENS.alex, `doc://${troubleshootingId}#p99`)).rejects.toThrow();
  });

  it('serves the uri that search results carry', async () => {
    const search = (await app.call('legacy', TOKENS.alex, 'search_troubleshooting', { query: 'needle clogged', product_id: 'brewwell-brew-pro-200' })).structuredContent as {
      results: { uri: string; section: string }[];
    };
    const hit = search.results.find((result) => /needle/i.test(result.section))!;
    expect(hit.uri).toMatch(/^doc:\/\/\d+#p\d+$/);
    const read = await app.readResource(TOKENS.alex, hit.uri);
    expect((read.contents[0] as { text: string }).text).toMatch(/needle/i);
  });
});
