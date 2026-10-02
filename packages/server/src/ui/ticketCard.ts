import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The ui:// resource that renders the result of create_support_case (an MCP App view). */
export const TICKET_CARD_URI = 'ui://resolveai/ticket-card.html';

/**
 * The built ticket card, or undefined when it has not been built (`npm run build:ui`). Without it the tool stays a
 * plain text tool, which is exactly what a client without MCP Apps support gets anyway.
 */
export function loadTicketCardHtml(): string | undefined {
  const file = resolve(import.meta.dirname, '../../dist/ui/ticket-card.html');
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}
