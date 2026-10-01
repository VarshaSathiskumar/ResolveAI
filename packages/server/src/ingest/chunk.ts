export interface Chunk {
  page: number;
  /** Heading path, for example "Clogged needle (error E01)". */
  section: string;
  text: string;
}

export interface ChunkOptions {
  /** Soft cap on chunk size in characters. A single block longer than this is kept whole. */
  maxChars?: number;
}

const PAGE_MARKER = /^<!--\s*page:\s*(\d+)\s*-->$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*$/;

/**
 * Splits a Markdown document into chunks that each sit on one page and one section.
 * Pages come from `<!-- page: N -->` markers, sections from `##` and `###` headings.
 * Blocks (paragraphs, lists, tables) are never split mid-block.
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 900;
  const chunks: Chunk[] = [];

  let page = 1;
  let h2 = '';
  let h3 = '';
  let current: { page: number; section: string; blocks: string[] } | undefined;
  let block: string[] = [];

  const section = () => [h2, h3].filter(Boolean).join(' > ');

  const flush = () => {
    if (current && current.blocks.length > 0) {
      chunks.push({ page: current.page, section: current.section, text: current.blocks.join('\n\n') });
    }
    current = undefined;
  };

  const flushBlock = () => {
    if (block.length === 0) return;
    const text = block.join('\n');
    block = [];
    const sectionName = section();
    const size = current ? current.blocks.join('\n\n').length + text.length + 2 : 0;
    if (current && (current.page !== page || current.section !== sectionName || size > maxChars)) {
      flush();
    }
    current ??= { page, section: sectionName, blocks: [] };
    current.blocks.push(text);
  };

  for (const line of markdown.split('\n')) {
    const pageMatch = PAGE_MARKER.exec(line.trim());
    if (pageMatch) {
      flushBlock();
      page = Number(pageMatch[1]);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushBlock();
      const level = heading[1]!.length;
      const title = heading[2]!;
      if (level === 2) {
        h2 = title;
        h3 = '';
      } else if (level === 3) {
        h3 = title;
      }
      continue;
    }
    if (line.trim() === '') {
      flushBlock();
      continue;
    }
    block.push(line);
  }
  flushBlock();
  flush();
  return chunks;
}

/** The first level-1 heading, used as the document title. */
export function documentTitle(markdown: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(markdown)?.[1];
}
