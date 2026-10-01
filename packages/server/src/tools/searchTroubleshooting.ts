import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SearchHit, SearchResult } from '../retrieval/retriever.js';
import type { ServerDeps } from '../deps.js';

const DESCRIPTION = [
  "Search the product's manuals, troubleshooting guides and warranty documents for the user's problem.",
  'Use it once you know which product the user means (pass product_id) and have a symptom, error code or light pattern to search for.',
  'Every result carries a ready-to-say citation (document and page); name it when you give a step.',
  'To read more around a result, call get_document_section with its document_id and page.',
  'Read `confidence` before answering:',
  '- high: answer from the results, one or two steps at a time.',
  '- medium: the match is partial. Reword the query with the error code or what the machine does, or ask the user one clarifying question.',
  '- low: do not answer from these results. Follow `suggested_refinement`, ask the user one diagnostic question, or say it is not in their documentation.',
  '`needs` lists what to establish before searching again, for example product_id.',
  '`unknown_terms` are words the documentation never uses: do not assume the product has that feature.',
  '`synonym_matches` show where the user\'s word was matched through a synonym (for example jammed as clogged); the match is reliable but confirm with the user if the step is risky.',
].join('\n');

const docType = z.enum(['manual', 'troubleshooting', 'warranty']);

const resultSchema = z.object({
  citation: z.string(),
  uri: z.string(),
  product_id: z.string(),
  product_model: z.string(),
  doc_type: docType,
  document_id: z.number(),
  page: z.number(),
  section: z.string(),
  text: z.string(),
  score: z.number(),
});

const outputSchema = z.object({
  confidence: z.enum(['high', 'medium', 'low']),
  gaps: z.array(z.string()),
  unknown_terms: z.array(z.string()),
  synonym_matches: z.array(z.object({ term: z.string(), matched: z.string() })),
  needs: z.array(z.string()),
  suggested_refinement: z.string().optional(),
  results: z.array(resultSchema),
});

function toResult(hit: SearchHit): z.infer<typeof resultSchema> {
  return {
    citation: hit.citation,
    uri: `doc://${hit.documentId}#p${hit.page}`,
    product_id: hit.productId,
    product_model: hit.productModel,
    doc_type: hit.docType,
    document_id: hit.documentId,
    page: hit.page,
    section: hit.section,
    text: hit.text,
    score: Number(hit.score.toFixed(5)),
  };
}

function summarise(result: SearchResult): string {
  const lines = [`Confidence: ${result.confidence}.`];
  if (result.suggestedRefinement) lines.push(result.suggestedRefinement);
  result.hits.forEach((hit, index) => {
    lines.push('', `${index + 1}. ${hit.citation}, section "${hit.section}"`, hit.text);
  });
  if (result.hits.length === 0) lines.push('No matching documentation was found.');
  return lines.join('\n');
}

export function registerSearchTroubleshootingTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'search_troubleshooting',
    {
      title: 'Search troubleshooting documentation',
      description: DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe('The symptom in the user\'s words plus any error code or light pattern, for example "E04 pump runs no water".'),
        product_id: z.string().optional().describe('Scope the search to one product. Strongly recommended once the product is known.'),
        doc_types: z.array(docType).optional().describe('Limit to some document types. Leave out to search all of them.'),
        limit: z.number().int().min(1).max(8).optional().describe('Number of results, default 4.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, product_id, doc_types, limit }) => {
      if (product_id && !deps.retriever.productExists(product_id)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown product_id "${product_id}". Resolve the product first (list_owned_products or identify_product) and use the id they return.`,
            },
          ],
        };
      }
      const result = await deps.retriever.search({ query, productId: product_id, docTypes: doc_types, limit });
      const output: z.infer<typeof outputSchema> = {
        confidence: result.confidence,
        gaps: result.gaps,
        unknown_terms: result.unknownTerms,
        synonym_matches: result.synonymMatches,
        needs: result.needs,
        ...(result.suggestedRefinement ? { suggested_refinement: result.suggestedRefinement } : {}),
        results: result.hits.map(toResult),
      };
      return { content: [{ type: 'text', text: summarise(result) }], structuredContent: output };
    },
  );
}
