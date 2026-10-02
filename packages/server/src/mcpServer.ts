import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { Principal } from './auth.js';
import type { ServerDeps } from './deps.js';
import { registerDocumentResource } from './resources/documents.js';
import { registerCheckWarrantyTool } from './tools/checkWarranty.js';
import { registerCreateSupportCaseTool } from './tools/createSupportCase.js';
import { registerGetCaseStateTool } from './tools/getCaseState.js';
import { registerGetDocumentSectionTool } from './tools/getDocumentSection.js';
import { registerGetProductTool } from './tools/getProduct.js';
import { registerIdentifyProductTool } from './tools/identifyProduct.js';
import { registerListOwnedProductsTool } from './tools/listOwnedProducts.js';
import { registerRecordDiagnosticStepTool } from './tools/recordDiagnosticStep.js';
import { registerSearchTroubleshootingTool } from './tools/searchTroubleshooting.js';
import { TICKET_CARD_URI } from '../../../config.js';

/**
 * Builds a fresh server instance for one user. Both transport eras call this, so tools are
 * defined once, and the principal is fixed when the instance is created rather than read per call.
 */
export function createMcpServer(deps: ServerDeps, principal: Principal = {}): McpServer {
  const server = new McpServer({ name: 'resolveai', version: '0.0.0' });
  registerListOwnedProductsTool(server, deps, principal);
  registerIdentifyProductTool(server, deps, principal);
  registerGetProductTool(server, deps);
  registerSearchTroubleshootingTool(server, deps);
  registerGetDocumentSectionTool(server, deps);
  registerGetCaseStateTool(server, deps, principal);
  registerRecordDiagnosticStepTool(server, deps, principal);
  registerCheckWarrantyTool(server, deps, principal);
  registerCreateSupportCaseTool(server, deps, principal);
  registerDocumentResource(server, deps);
  const html = deps.ticketCardHtml;
  if (html) {
    // The view for create_support_case. It needs no network access, so it declares no CSP domains.
    registerAppResource(server, 'Support ticket card', TICKET_CARD_URI, { description: 'Shows a filed support ticket: reference, product, steps tried and warranty status.' }, async () => ({
      contents: [{ uri: TICKET_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }));
  }
  return server;
}
