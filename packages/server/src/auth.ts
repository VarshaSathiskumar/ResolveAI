import { timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';

/** Who made a request. `userId` is set when the token belongs to a registered user. */
export interface Principal {
  userId?: string;
}

export interface TokenConfig {
  /** Accepts a request with no user behind it (service or smoke-test access). */
  bearerToken?: string;
  /** Token to user id. Each demo user has their own token, like a linked account. */
  userTokens: Record<string, string>;
}

function sameToken(given: Buffer, expected: string): boolean {
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Resolves the Authorization header to a principal, or undefined when the token is not accepted. */
export function authenticate(header: string | undefined, config: TokenConfig): Principal | undefined {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  if (!match?.[1]) return undefined;
  const given = Buffer.from(match[1]);

  // Check every token before answering so the time taken does not reveal which one matched.
  let found: Principal | undefined;
  for (const [token, userId] of Object.entries(config.userTokens)) {
    if (sameToken(given, token)) found ??= { userId };
  }
  if (config.bearerToken && sameToken(given, config.bearerToken)) found ??= {};
  return found;
}

const USER_PREFIX = 'user:';

/** The auth info handed to the MCP handler. The principal travels in `clientId`. */
export function toAuthInfo(principal: Principal): AuthInfo {
  return { token: '', clientId: principal.userId ? `${USER_PREFIX}${principal.userId}` : 'anonymous', scopes: [] };
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal {
  const id = authInfo?.clientId;
  return id?.startsWith(USER_PREFIX) ? { userId: id.slice(USER_PREFIX.length) } : {};
}
