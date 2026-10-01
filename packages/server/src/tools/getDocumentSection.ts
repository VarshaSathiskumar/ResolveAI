import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../deps.js';
import { errorResult } from './caseAccess.js';

const DESCRIPTION = [
  'Read a whole page of a manual, troubleshooting guide or warranty document.',
  'Use it when a search result is relevant but cut off, or you need the text around it, for example the steps before and after one you found.',
  'Take `document_id` and `page` from a search_troubleshooting result.',
  'Set `include_adjacent_pages` to also get the page before and after.',
].join('\n');

const outputSchema = z.object({
  document: z.object({
    document_id: z.number(),
    product_id: z.string(),
    product_model: z.string(),
    type: z.enum(['manual', 'troubleshooting', 'warranty']),
    title: z.string(),
    pages: z.number(),
  }),
  uri: z.string(),
  citation: z.string(),
  chunks: z.array(z.object({ page: z.number(), section: z.string(), text: z.string() })),
});

export function registerGetDocumentSectionTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_document_section',
    {
      title: 'Read a document page',
      description: DESCRIPTION,
      inputSchema: z.object({
        document_id: z.number().int().positive(),
        page: z.number().int().positive(),
        include_adjacent_pages: z.boolean().optional().describe('Also return the page before and after. Default false.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ document_id, page, include_adjacent_pages }) => {
      const document = deps.catalog.getDocument(document_id);
      if (!document) return errorResult(`Unknown document_id ${document_id}. Use a document_id from a search_troubleshooting or get_product result.`);
      if (page > document.pages) return errorResult(`${document.title} has ${document.pages} pages, so page ${page} does not exist.`);

      const pages = include_adjacent_pages ? [page - 1, page, page + 1].filter((n) => n >= 1 && n <= document.pages) : [page];
      const chunks = deps.catalog.chunksOnPages(document_id, pages);
      const output: z.infer<typeof outputSchema> = {
        document: {
          document_id: document.documentId,
          product_id: document.productId,
          product_model: document.productModel,
          type: document.type,
          title: document.title,
          pages: document.pages,
        },
        uri: `doc://${document.documentId}#p${page}`,
        citation: `${document.title}, page ${page}`,
        chunks,
      };
      const text = [
        `${document.title}, page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}`,
        ...chunks.map((chunk) => `\n[page ${chunk.page}] ${chunk.section}\n${chunk.text}`),
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
