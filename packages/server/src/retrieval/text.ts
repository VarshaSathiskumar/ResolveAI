import { stemmer } from 'stemmer';

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from get got had has have how i if in into is isnt it its ' +
    'just me my no not of on or our please so that the their them then there these they this to up was we were what when ' +
    'where which while who why will with would you your wont dont doesnt cant im ive help need want long many much often think thinks maybe seems seem really very bit kind sort thing something' +
    // Generic to every document in the corpus, so they say nothing about whether the right page was found.
    ' coffee machine maker'
  ).split(' '),
);

/**
 * Generic English verbs, adverbs and pronouns that say nothing about a product problem ("air is getting into the
 * pump", "it barely trickles", "if none of this works"). A general rule, not a list built from particular queries.
 * Left out by default so it can be measured on its own; the calibrated retriever turns it on.
 */
const FILLER = new Set(
  (
    'get gets getting got gotten make makes making made take takes taking took go goes going went gone come comes coming came ' +
    'keep keeps keeping kept put puts putting say says said see sees seen seem seems seemed happen happens happening happened ' +
    'try tries trying tried work works working worked barely hardly almost still even already always ever again anymore also ' +
    'properly actually basically anything everything nothing none something someone anyone everyone ' +
    'ok okay hi hello thanks thank'
  ).split(' '),
);

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
    (word) => word.length > 1 && !STOPWORDS.has(word) && !(options.filler && FILLER.has(word)),
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
