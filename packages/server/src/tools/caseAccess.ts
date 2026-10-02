import type { Principal } from '../auth.js';
import type { CaseRecord } from '../cases/store.js';
import type { ServerDeps } from '../deps.js';
import { NO_ACCOUNT } from '../../../../config.js';

export function errorResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

/** Finds a case the principal may use: the one asked for, else their most recent open one. */
export function findCase(
  deps: ServerDeps,
  principal: Principal,
  caseId: number | undefined,
): { case?: CaseRecord; error?: ReturnType<typeof errorResult> } {
  if (!principal.userId) return { error: errorResult(NO_ACCOUNT) };
  if (caseId === undefined) return { case: deps.cases.latestOpen(principal.userId) };
  const found = deps.cases.get(caseId, principal.userId);
  return found
    ? { case: found }
    : { error: errorResult(`Unknown case_id ${caseId}. Call get_case_state with no case_id to find the current case.`) };
}
