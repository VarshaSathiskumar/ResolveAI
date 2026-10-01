import { describe, expect, it } from 'vitest';
import { chunkMarkdown, documentTitle } from '../src/ingest/chunk.js';

const doc = `# Guide

<!-- page: 1 -->
## First section

Para one.

Para two.

<!-- page: 2 -->
## Second section

### Detail

Detail text.
`;

describe('chunkMarkdown', () => {
  it('assigns page and section from markers and headings', () => {
    const chunks = chunkMarkdown(doc);
    expect(chunks).toEqual([
      { page: 1, section: 'First section', text: 'Para one.\n\nPara two.' },
      { page: 2, section: 'Second section > Detail', text: 'Detail text.' },
    ]);
  });

  it('never lets a chunk span two pages', () => {
    const chunks = chunkMarkdown('## S\n\nA\n\n<!-- page: 2 -->\n\nB\n');
    expect(chunks.map((chunk) => [chunk.page, chunk.text])).toEqual([
      [1, 'A'],
      [2, 'B'],
    ]);
  });

  it('splits an oversized section on block boundaries without cutting a block', () => {
    const block = 'x'.repeat(60);
    const chunks = chunkMarkdown(`## S\n\n${block}\n\n${block}\n\n${block}\n`, { maxChars: 100 });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.text === block)).toBe(true);
  });

  it('keeps a table together as one block', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    const chunks = chunkMarkdown(`## S\n\n${table}\n`);
    expect(chunks[0]?.text).toBe(table);
  });

  it('reads the document title', () => {
    expect(documentTitle(doc)).toBe('Guide');
  });
});
