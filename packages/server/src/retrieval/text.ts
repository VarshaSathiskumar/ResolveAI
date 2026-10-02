import { stemmer } from 'stemmer';
import { FILLER_WORDS, STOPWORDS } from '../../../../config.js';

/** Lower-cased alphanumeric words from free text, with apostrophes removed ("isn't" becomes "isnt"). */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) ?? [];
}

/**
 * Error codes and model numbers: one to three letters followed by one to three digits, with an
 * optional hyphen ("E04", "E-04", "BP-200", "ES1"). Returned lower-case without the hyphen.
 */
export function codeTerms(query: string): string[] {
  const found = query.toLowerCase().match(/\b[a-z]{1,3}-?\d{1,3}\b/g) ?? [];
  return [...new Set(found.map((code) => code.replace('-', '')))];
}

/** The distinct content words of a query: no stopwords, no single characters, codes kept. */
export function queryTerms(query: string, options: { filler?: boolean } = {}): string[] {
  const codes = codeTerms(query);
  // Take the codes out first so "E-04" is one term rather than "e" and "04".
  const rest = query.toLowerCase().replace(/\b[a-z]{1,3}-?\d{1,3}\b/g, ' ');
  const terms = words(rest).filter(
    (word) => word.length > 1 && !STOPWORDS.has(word) && !(options.filler && FILLER_WORDS.has(word)),
  );
  return [...new Set([...terms, ...codes])];
}

/** Builds an FTS5 query that matches any of the terms. Each term is quoted so it is never parsed as syntax. */
export function ftsAnyOf(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ');
}

/** Porter stem of a word, so "jammed", "jamming" and "jam" compare equal. */
export function stem(word: string): string {
  return stemmer(word.toLowerCase());
}
