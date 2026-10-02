import type { Usage } from '../../shared/events';

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "Brewwell Brew Pro 200 Troubleshooting Guide, page 2" becomes "Brew Pro 200 Troubleshooting Guide, p. 2". */
export function shortCitation(citation: string): string {
  return citation.replace(/^Brewwell\s+/, '').replace(/, page (\d+)$/, ', p. $1');
}

export function formatTokens(usage: Usage): string {
  const parts = [`${usage.inputTokens.toLocaleString()} in`, `${usage.outputTokens.toLocaleString()} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${usage.cacheReadTokens.toLocaleString()} cached`);
  return parts.join(' / ');
}

/** A short, readable view of a tool call's arguments for one line of the trace. */
export function describeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const entries = Object.entries(input as Record<string, unknown>);
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value.length > 48 ? `${value.slice(0, 48)}...` : value}"` : JSON.stringify(value)}`)
    .join(', ');
}
