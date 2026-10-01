import type { Db } from '../db/schema.js';
import { stem } from './text.js';

export interface SynonymLookup {
  /** The term itself first, then the other words of its group. A term with no group expands to just itself. */
  expand(term: string): string[];
}

/** Reads the ingested synonym groups once. An index without the table simply has no synonyms. */
export function createSynonymLookup(db: Db): SynonymLookup {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'synonyms'").get();
  const rows = hasTable
    ? (db.prepare('SELECT stem, group_id, word FROM synonyms').all() as { stem: string; group_id: number; word: string }[])
    : [];

  const groupOf = new Map<string, number>();
  const wordsOf = new Map<number, string[]>();
  for (const row of rows) {
    groupOf.set(row.stem, row.group_id);
    wordsOf.set(row.group_id, [...(wordsOf.get(row.group_id) ?? []), row.word]);
  }

  return {
    expand(term) {
      const group = groupOf.get(stem(term));
      if (group === undefined) return [term];
      return [term, ...wordsOf.get(group)!.filter((word) => word !== term)];
    },
  };
}
