import { stem, words } from '../retrieval/text.js';
import type { Product } from './catalog.js';

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface Candidate {
  productId: string;
  brand: string;
  model: string;
  category: string;
  score: number;
  confidence: MatchConfidence;
  owned: boolean;
  /** Specs that differ from the other candidates in the same ambiguous group, as "key: value". */
  distinguishing: string[];
}

export interface Identification {
  candidates: Candidate[];
  /** Several candidates are about equally good: the user has to say which. */
  ambiguous: boolean;
  needs: string[];
  suggestedQuestion?: string;
}

/** Candidates this close to the best score are treated as equally likely. */
const AMBIGUITY_MARGIN = 0.15;
/** Fuzzy word overlap never outranks a phrase match. */
const FUZZY_CEILING = 0.6;
const HIGH = 0.85;
const MEDIUM = 0.4;
const GENERIC = new Set(['coffee', 'machine', 'maker', 'the', 'a', 'an', 'my', 'one', 'with', 'and', 'of', 'i', 'have', 'got']);

/** "BP-200" becomes "bp200" so a model number matches however it is typed. */
function tokens(text: string): string[] {
  return words(text.toLowerCase().replace(/\b([a-z]{1,3})-(\d)/g, '$1$2'));
}

function compact(text: string): string {
  return tokens(text).join('');
}

function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, offset) => haystack[i + offset] === token)) return true;
  }
  return false;
}

function specText(product: Product): string[] {
  return Object.values(product.specs).flatMap((value) => (typeof value === 'string' ? tokens(value) : []));
}

/**
 * Deterministic match of a free-text description against the catalog. A name the user typed is
 * strongest (model or alias found in the description), a description that sits inside a name
 * comes next, and shared word overlap is the weakest. A name that several products share
 * ("Brew Pro") scores lower than one that belongs to a single product ("Brew Pro 300"),
 * which is what makes the ambiguous cases ambiguous.
 */
export function identifyProduct(
  description: string,
  products: Product[],
  ownedProductIds: ReadonlySet<string> = new Set(),
  limit = 3,
): Identification {
  const said = tokens(description);
  const saidCompact = said.join('');
  const saidTerms = said.filter((token) => !GENERIC.has(token) && token.length > 1).map(stem);

  // How many products carry each name, to tell a shared alias from a unique one.
  const names = (product: Product) => [`${product.brand} ${product.model}`, product.model, ...product.aliases];
  const owners = new Map<string, number>();
  for (const product of products) {
    for (const key of new Set(names(product).map(compact))) owners.set(key, (owners.get(key) ?? 0) + 1);
  }

  const scored = products.map((product) => {
    let score = 0;
    for (const name of names(product)) {
      const nameTokens = tokens(name);
      const key = nameTokens.join('');
      const unique = owners.get(key) === 1;
      if (key === saidCompact || containsRun(said, nameTokens)) score = Math.max(score, unique ? 1 : 0.75);
      else if (said.length >= 2 && containsRun(nameTokens, said)) score = Math.max(score, unique ? 0.9 : 0.7);
    }
    if (score === 0 && saidTerms.length > 0) {
      const vocabulary = new Set(
        [...names(product).flatMap(tokens), ...tokens(product.category), ...specText(product)].map(stem),
      );
      const matched = saidTerms.filter((term) => vocabulary.has(term)).length;
      score = (matched / saidTerms.length) * FUZZY_CEILING;
    }
    return { product, score: Number(score.toFixed(3)) };
  });

  const ranked = scored
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(ownedProductIds.has(b.product.id)) - Number(ownedProductIds.has(a.product.id)) ||
        a.product.model.localeCompare(b.product.model),
    );

  if (ranked.length === 0) {
    return { candidates: [], ambiguous: false, needs: ['model'] };
  }

  const best = ranked[0]!.score;
  const tied = ranked.filter((entry) => entry.score >= best - AMBIGUITY_MARGIN);
  const ambiguous = tied.length > 1;
  const tiedIds = new Set(tied.map((entry) => entry.product.id));

  const differing = ambiguous ? differingSpecs(tied.map((entry) => entry.product)) : new Map<string, string[]>();

  const candidates: Candidate[] = ranked.slice(0, limit).map(({ product, score }) => {
    let confidence: MatchConfidence = score >= HIGH ? 'high' : score >= MEDIUM ? 'medium' : 'low';
    if (ambiguous && tiedIds.has(product.id) && confidence === 'high') confidence = 'medium';
    return {
      productId: product.id,
      brand: product.brand,
      model: product.model,
      category: product.category,
      score,
      confidence,
      owned: ownedProductIds.has(product.id),
      distinguishing: differing.get(product.id) ?? [],
    };
  });

  return {
    candidates,
    ambiguous,
    needs: ambiguous ? ['model'] : [],
    ...(ambiguous ? { suggestedQuestion: question(candidates.filter((c) => tiedIds.has(c.productId))) } : {}),
  };
}

/** For each product, the spec fields whose value is not the same across the whole group. */
function differingSpecs(group: Product[]): Map<string, string[]> {
  const keys = [...new Set(group.flatMap((product) => Object.keys(product.specs)))];
  const different = keys.filter((key) => new Set(group.map((product) => String(product.specs[key] ?? ''))).size > 1);
  // The kind of machine and what its display looks like are the easiest things for a person to check.
  different.sort((a, b) => Number(['type', 'display'].includes(b)) - Number(['type', 'display'].includes(a)));
  return new Map(
    group.map((product) => [
      product.id,
      different.slice(0, 2).map((key) => `${key.replace(/_/g, ' ')}: ${String(product.specs[key] ?? 'none')}`),
    ]),
  );
}

function question(group: Candidate[]): string {
  const owned = group.filter((candidate) => candidate.owned);
  const names = group.map((candidate) => `the ${candidate.model}`);
  const lead =
    owned.length === 1
      ? `Is it your registered ${owned[0]!.model}, or ${names.filter((name) => !name.endsWith(owned[0]!.model)).join(' or ')}?`
      : `Is it ${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} or ${names[names.length - 1]}?`;
  const detail = group
    .map((candidate) => `${candidate.model}: ${candidate.distinguishing.join(', ')}`)
    .filter((line) => !line.endsWith(': '))
    .join('; ');
  return detail ? `${lead} (${detail})` : lead;
}
