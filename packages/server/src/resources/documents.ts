import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../deps.js';

/** `doc://{documentId}#p{page}`: one page of a document, the target of every citation. */
export function registerDocumentResource(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'document-page',
    new ResourceTemplate('doc://{documentId}#p{page}', { list: undefined }),
    {
      title: 'Document page',
      description: 'One page of a manual, troubleshooting guide or warranty document, as cited by search results.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const documentId = Number(variables.documentId);
      const page = Number(variables.page);
      const document = Number.isInteger(documentId) ? deps.catalog.getDocument(documentId) : undefined;
      if (!document || !Number.isInteger(page) || page < 1 || page > document.pages) {
        throw new Error(`No such document page: ${uri.href}`);
      }
      const chunks = deps.catalog.chunksOnPages(documentId, [page]);
      const text = [`# ${document.title}, page ${page}`, ...chunks.map((chunk) => `## ${chunk.section}\n\n${chunk.text}`)].join('\n\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );
}
