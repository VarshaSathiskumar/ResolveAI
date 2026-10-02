import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { LlmError, toLlmError } from '../server/agent/llm.js';
import { loadSimConfig } from '../server/config.js';

describe('loadSimConfig', () => {
  const env = { SIM_PERSONAS: 'alex:ta' };

  it('uses safe defaults: Sonnet 5.5, low effort, fallback on, local origins', () => {
    const config = loadSimConfig(env);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3200,
      webOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      mcpUrl: 'http://127.0.0.1:3000/mcp',
      personaTokens: { alex: 'ta' },
      agent: { model: 'claude-sonnet-5-5', effort: 'low', fallback: true, maxTokens: 8192, maxRounds: 8, maxTurnsPerSession: 40 },
    });
  });

  it('takes one or several allowed web origins', () => {
    expect(loadSimConfig({ ...env, SIM_WEB_ORIGIN: 'https://demo.example' }).webOrigins).toEqual(['https://demo.example']);
    expect(loadSimConfig({ ...env, SIM_WEB_ORIGIN: ' https://a.example , https://b.example ' }).webOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('lets the model, effort and fallback be switched', () => {
    const config = loadSimConfig({ ...env, RESOLVEAI_AGENT_MODEL: 'claude-haiku-4-5', RESOLVEAI_AGENT_EFFORT: 'high', RESOLVEAI_AGENT_FALLBACK: 'off' });
    expect(config.agent).toMatchObject({ model: 'claude-haiku-4-5', effort: 'high', fallback: false });
  });

  it('refuses missing, malformed, duplicated and unknown personas', () => {
    expect(() => loadSimConfig({})).toThrow(/SIM_PERSONAS/);
    expect(() => loadSimConfig({ SIM_PERSONAS: 'alex' })).toThrow(/persona:token/);
    expect(() => loadSimConfig({ SIM_PERSONAS: 'alex:a,alex:b' })).toThrow(/twice/);
    expect(() => loadSimConfig({ SIM_PERSONAS: 'bob:x' })).toThrow(/unknown persona/);
  });

  it('refuses a bad effort and a non-numeric limit', () => {
    expect(() => loadSimConfig({ ...env, RESOLVEAI_AGENT_EFFORT: 'turbo' })).toThrow(/EFFORT/);
    expect(() => loadSimConfig({ ...env, SIM_MAX_ROUNDS: 'many' })).toThrow(/SIM_MAX_ROUNDS/);
    expect(() => loadSimConfig({ ...env, SIM_MAX_TURNS: '0' })).toThrow(/SIM_MAX_TURNS/);
  });
});

describe('toLlmError', () => {
  const api = (status: number) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: `status ${status}` } }, `status ${status}`, new Headers());

  it('maps the SDK errors to retryable and non-retryable kinds', () => {
    expect(toLlmError(api(429))).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 });
    expect(toLlmError(api(401))).toMatchObject({ kind: 'auth', retryable: false });
    expect(toLlmError(api(400))).toMatchObject({ kind: 'bad_request', retryable: false });
    expect(toLlmError(api(529))).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(toLlmError(api(500))).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(toLlmError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: 'aborted', retryable: false });
    expect(toLlmError(new Anthropic.APIConnectionError({ message: 'down' }))).toMatchObject({ kind: 'connection', retryable: true });
  });

  it('wraps anything else and passes an LlmError through unchanged', () => {
    expect(toLlmError(new Error('weird'))).toMatchObject({ kind: 'other', message: 'weird' });
    const existing = new LlmError('rate_limit', 'x');
    expect(toLlmError(existing)).toBe(existing);
  });
});
