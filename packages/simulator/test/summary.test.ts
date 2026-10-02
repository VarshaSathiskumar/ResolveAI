import { describe, expect, it } from 'vitest';
import { summarizeToolResult } from '../server/summary.js';

describe('summarizeToolResult', () => {
  it('summarises a search with confidence, needs, competing models, synonyms, unknown words, rerank time and citations', () => {
    const summary = summarizeToolResult(
      'search_troubleshooting',
      true,
      {
        confidence: 'medium',
        needs: ['product_id'],
        competing_products: [{ product_id: 'a', model: 'Brew Pro 200' }, { product_id: 'b', model: 'Brew Pro 300' }],
        synonym_matches: [{ term: 'jammed', matched: 'clogged' }],
        unknown_terms: ['grinder'],
        rerank: { model: 'm', candidates: 10, ms: 181.6 },
        results: [
          { citation: 'Guide, page 2', uri: 'doc://3#p2', section: 'Clogged needle' },
          { citation: 'Guide, page 2', uri: 'doc://3#p2', section: 'Clogged needle' },
          { citation: 'Guide, page 1', uri: 'doc://3#p1', section: 'Quick table' },
        ],
      },
      '',
    );
    expect(summary.headline).toBe('3 results, confidence medium');
    expect(summary.badges).toEqual([
      'confidence: medium',
      'needs: product_id',
      'could be: Brew Pro 200 / Brew Pro 300',
      'jammed matched as clogged',
      'not in docs: grinder',
      'reranked in 182 ms',
    ]);
    expect(summary.citations.map((citation) => citation.uri)).toEqual(['doc://3#p2', 'doc://3#p1']);
  });

  it('summarises the product, warranty and case tools', () => {
    expect(summarizeToolResult('list_owned_products', true, { resolution: 'several', needs: ['which_product'], owned: [{ model: 'A' }, { model: 'B' }] }, '').headline).toBe('several: A, B');
    expect(summarizeToolResult('identify_product', true, { ambiguous: true, needs: ['model'], candidates: [{ model: 'A', confidence: 'medium' }, { model: 'B', confidence: 'medium' }] }, '').headline).toBe('ambiguous: A (medium) or B (medium)');
    expect(summarizeToolResult('check_warranty', true, { model: 'Brew Pro 200', status: 'in_warranty', end_date: '2028-03-14' }, '')).toMatchObject({ headline: 'Brew Pro 200: in warranty', badges: ['in warranty', 'ends 2028-03-14'] });
    expect(summarizeToolResult('record_diagnostic_step', true, { started_new_case: true, case_id: 4, steps_recorded: 1, status: 'open' }, '').headline).toBe('started case 4');
    expect(summarizeToolResult('get_case_state', true, { case: null, steps_tried: [], needs: ['case'] }, '')).toMatchObject({ headline: 'no open case', badges: ['needs: case'] });
    expect(summarizeToolResult('create_support_case', true, { ticket_ref: 'RAI-2026-000001', already_existed: false, warranty: { status: 'in_warranty' }, warnings: [] }, '').headline).toBe('ticket RAI-2026-000001');
    expect(summarizeToolResult('get_document_section', true, { citation: 'Guide, page 2', uri: 'doc://3#p2' }, '').citations).toEqual([{ citation: 'Guide, page 2', uri: 'doc://3#p2' }]);
  });

  it('marks a failure and still summarises output it does not know about', () => {
    expect(summarizeToolResult('anything', false, undefined, 'boom')).toEqual({ headline: 'anything failed', badges: ['error'], citations: [] });
    expect(summarizeToolResult('new_tool', true, { x: 1 }, 'first line\nsecond').headline).toBe('first line');
    expect(summarizeToolResult('new_tool', true, undefined, 'first line\nsecond').headline).toBe('first line');
    expect(summarizeToolResult('new_tool', true, { x: 1 }, '').headline).toBe('new_tool returned');
  });
});
