import { describe, expect, it } from 'vitest';
import { authenticate, principalFromAuthInfo, toAuthInfo } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const config = { bearerToken: 'service', userTokens: { 'token-a': 'demo-alex', 'token-b': 'demo-other' } };

describe('authenticate', () => {
  it('maps a user token to its user', () => {
    expect(authenticate('Bearer token-a', config)).toEqual({ userId: 'demo-alex' });
    expect(authenticate('bearer token-b', config)).toEqual({ userId: 'demo-other' });
  });

  it('accepts the service token with no user', () => {
    expect(authenticate('Bearer service', config)).toEqual({});
  });

  it('rejects unknown, missing and malformed credentials', () => {
    expect(authenticate('Bearer nope', config)).toBeUndefined();
    expect(authenticate(undefined, config)).toBeUndefined();
    expect(authenticate('Basic token-a', config)).toBeUndefined();
    expect(authenticate('Bearer ', config)).toBeUndefined();
  });

  it('works with only user tokens configured', () => {
    expect(authenticate('Bearer service', { userTokens: config.userTokens })).toBeUndefined();
  });
});

describe('auth info', () => {
  it('round-trips the user through the MCP handler', () => {
    expect(principalFromAuthInfo(toAuthInfo({ userId: 'demo-alex' }))).toEqual({ userId: 'demo-alex' });
    expect(principalFromAuthInfo(toAuthInfo({}))).toEqual({});
    expect(principalFromAuthInfo(undefined)).toEqual({});
  });
});

describe('loadConfig tokens', () => {
  it('parses MCP_USER_TOKENS', () => {
    const parsed = loadConfig({ MCP_USER_TOKENS: 'a:demo-alex, b:demo-other' });
    expect(parsed.userTokens).toEqual({ a: 'demo-alex', b: 'demo-other' });
    expect(parsed.bearerToken).toBeUndefined();
  });

  it('needs at least one kind of token', () => {
    expect(() => loadConfig({})).toThrow(/MCP_USER_TOKENS/);
  });

  it('turns the reranker on by default and off on request', () => {
    expect(loadConfig({ MCP_BEARER_TOKEN: 'x' }).reranker).toBe('cross-encoder');
    expect(loadConfig({ MCP_BEARER_TOKEN: 'x', RESOLVEAI_RERANKER: 'off' }).reranker).toBe('off');
    expect(loadConfig({ MCP_BEARER_TOKEN: 'x', RESOLVEAI_RERANKER: 'anything-else' }).reranker).toBe('cross-encoder');
  });

  it('rejects a malformed or duplicated entry', () => {
    expect(() => loadConfig({ MCP_USER_TOKENS: 'justatoken' })).toThrow(/token:user-id/);
    expect(() => loadConfig({ MCP_USER_TOKENS: 'a:x,a:y' })).toThrow(/twice/);
  });
});
