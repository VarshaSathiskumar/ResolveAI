import { timingSafeEqual } from 'node:crypto';

/** Returns true when the Authorization header carries the expected bearer token. */
export function isAuthorized(header: string | undefined, expectedToken: string): boolean {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
