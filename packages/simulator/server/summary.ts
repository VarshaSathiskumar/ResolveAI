import type { Citation, ToolSummary } from '../shared/events.js';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function citationsOf(results: Obj[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const result of results) {
    if (typeof result.citation !== 'string' || typeof result.uri !== 'string') continue;
    const key = result.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ citation: result.citation, uri: result.uri, ...(typeof result.section === 'string' ? { section: result.section } : {}) });
  }
  return out;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Turns a tool's structured output into a headline, a few badges and any citations, for the trace panel.
 * Unknown tools and missing output still get a plain summary, so a new tool never breaks the panel.
 */
export function summarizeToolResult(name: string, ok: boolean, structured: Obj | undefined, text: string): ToolSummary {
  if (!ok) return { headline: `${name} failed`, badges: ['error'], citations: [] };
  const s = structured;
  if (!s) return { headline: text.split('\n')[0]?.slice(0, 120) || `${name} returned`, badges: [], citations: [] };

  switch (name) {
    case 'search_troubleshooting': {
      const results = list(s.results);
      const badges = [`confidence: ${String(s.confidence)}`];
      const needs = strings(s.needs);
      if (needs.length) badges.push(`needs: ${needs.join(', ')}`);
      const competing = list(s.competing_products).map((entry) => String(entry.model));
      if (competing.length) badges.push(`could be: ${competing.join(' / ')}`);
      for (const match of list(s.synonym_matches)) badges.push(`${String(match.term)} matched as ${String(match.matched)}`);
      const unknown = strings(s.unknown_terms);
      if (unknown.length) badges.push(`not in docs: ${unknown.join(', ')}`);
      if (isObj(s.rerank) && typeof s.rerank.ms === 'number') badges.push(`reranked in ${Math.round(s.rerank.ms)} ms`);
      return { headline: `${plural(results.length, 'result')}, confidence ${String(s.confidence)}`, badges, citations: citationsOf(results) };
    }
    case 'list_owned_products': {
      const owned = list(s.owned).map((entry) => String(entry.model));
      return { headline: `${String(s.resolution)}: ${owned.join(', ') || 'no registered products'}`, badges: strings(s.needs).map((need) => `needs: ${need}`), citations: [] };
    }
    case 'identify_product': {
      const candidates = list(s.candidates).map((entry) => `${String(entry.model)} (${String(entry.confidence)})`);
      return {
        headline: s.ambiguous === true ? `ambiguous: ${candidates.join(' or ')}` : candidates[0] ?? 'no match',
        badges: strings(s.needs).map((need) => `needs: ${need}`),
        citations: [],
      };
    }
    case 'get_product':
      return { headline: `${String(s.brand)} ${String(s.model)}`, badges: [`warranty ${String(s.warranty_term_months)} months`], citations: [] };
    case 'check_warranty': {
      const badges = [String(s.status).replace('_', ' ')];
      if (typeof s.end_date === 'string') badges.push(`ends ${s.end_date}`);
      return { headline: `${String(s.model)}: ${String(s.status).replace('_', ' ')}`, badges, citations: [] };
    }
    case 'record_diagnostic_step':
      return {
        headline: `${s.started_new_case === true ? 'started' : 'updated'} case ${String(s.case_id)}`,
        badges: [`${String(s.steps_recorded)} steps`, String(s.status)],
        citations: [],
      };
    case 'get_case_state': {
      const current = isObj(s.case) ? s.case : undefined;
      return {
        headline: current ? `case ${String(current.case_id)} (${String(current.status)})` : 'no open case',
        badges: [...strings(s.steps_tried).map((step) => `tried: ${step}`), ...strings(s.needs).map((need) => `needs: ${need}`)],
        citations: [],
      };
    }
    case 'create_support_case':
      return {
        headline: `ticket ${String(s.ticket_ref)}${s.already_existed === true ? ' (already filed)' : ''}`,
        badges: [...(isObj(s.warranty) ? [String(s.warranty.status).replace('_', ' ')] : []), ...strings(s.warnings).slice(0, 2)],
        citations: [],
      };
    case 'get_document_section': {
      const citation = typeof s.citation === 'string' ? s.citation : 'document page';
      return { headline: citation, badges: [], citations: typeof s.uri === 'string' ? [{ citation, uri: s.uri }] : [] };
    }
    default:
      return { headline: text.split('\n')[0]?.slice(0, 120) || `${name} returned`, badges: [], citations: [] };
  }
}
