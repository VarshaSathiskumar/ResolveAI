const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from get got had has have how i if in into is isnt it its ' +
    'just me my no not of on or our please so that the their them then there these they this to up was we were what when ' +
    'where which while who why will with would you your wont dont doesnt cant im ive help need want long many much often think thinks maybe seems seem really very bit kind sort thing something' +
    // Generic to every document in the corpus, so they say nothing about whether the right page was found.
    ' coffee machine maker'
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
export function queryTerms(query: string): string[] {
  const codes = codeTerms(query);
  // Take the codes out first so "E-04" is one term rather than "e" and "04".
  const rest = query.toLowerCase().replace(/\b[a-z]{1,3}-?\d{1,3}\b/g, ' ');
  const terms = words(rest).filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set([...terms, ...codes])];
}

/** Builds an FTS5 query that matches any of the terms. Each term is quoted so it is never parsed as syntax. */
export function ftsAnyOf(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ');
}
