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

  it('keeps a table together as one block by default', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    const chunks = chunkMarkdown(`## S\n\n${table}\n`);
    expect(chunks[0]?.text).toBe(table);
  });

  it('can split only narrow lookup tables into rows, keeping a wider table whole', () => {
    const narrow = '| Item | Value |\n|---|---|\n| Tank | 1.0 litre |\n| Power | 1450 W |';
    expect(chunkMarkdown(`## Specs\n\n${narrow}\n`, { maxRowColumns: 2 }).map((chunk) => chunk.text)).toEqual([
      'Item: Tank | Value: 1.0 litre',
      'Item: Power | Value: 1450 W',
    ]);
    const wide = '| Symptom | Cause | Go to |\n|---|---|---|\n| no water | air | Airlock |';
    expect(chunkMarkdown(`## Table\n\n${wide}\n`, { maxRowColumns: 2 })[0]?.text).toBe(wide);
  });

  it('makes each table row its own chunk, with the header beside every value', () => {
    const table = '| Symptom | Cause |\n|---|---|\n| no water | air lock |\n| slow | scale |';
    const chunks = chunkMarkdown(`## Quick table\n\n${table}\n`, { maxRowColumns: Infinity });
    expect(chunks).toEqual([
      { page: 1, section: 'Quick table', text: 'Symptom: no water | Cause: air lock' },
      { page: 1, section: 'Quick table', text: 'Symptom: slow | Cause: scale' },
    ]);
  });

  it('closes the text before a table and carries on after it', () => {
    const doc = '## S\n\nBefore.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n';
    expect(chunkMarkdown(doc, { maxRowColumns: Infinity }).map((chunk) => chunk.text)).toEqual(['Before.', 'a: 1 | b: 2', 'After.']);
  });

  it('keeps the page of a table that follows a page marker', () => {
    const doc = '<!-- page: 3 -->\n## S\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(chunkMarkdown(doc, { maxRowColumns: Infinity })[0]?.page).toBe(3);
  });

  it('leaves a pipe-separated block without a separator row alone', () => {
    const text = '| not | a table |\n| really | no |\n| separator | row |';
    expect(chunkMarkdown(`## S\n\n${text}\n`, { maxRowColumns: Infinity })[0]?.text).toBe(text);
  });

  it('skips empty cells and names a header-less column', () => {
    const table = '| A | |\n|---|---|\n| x | y |\n| z | |';
    expect(chunkMarkdown(`## S\n\n${table}\n`, { maxRowColumns: Infinity }).map((chunk) => chunk.text)).toEqual(['A: x | Column 2: y', 'A: z']);
  });

  it('reads the document title', () => {
    expect(documentTitle(doc)).toBe('Guide');
  });
});
