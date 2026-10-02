import { existsSync, readFileSync } from 'node:fs';
import { repoPath, TICKET_CARD_HTML } from '../../../../config.js';

/**
 * The built ticket card, or undefined when it has not been built (`npm run build:ui`). Without it the tool stays a
 * plain text tool, which is exactly what a client without MCP Apps support gets anyway.
 */
export function loadTicketCardHtml(): string | undefined {
  const file = repoPath(TICKET_CARD_HTML);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}
