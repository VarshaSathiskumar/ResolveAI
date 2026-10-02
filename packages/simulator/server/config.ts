import { PERSONAS } from './personas.js';

export interface SimConfig {
  host: string;
  port: number;
  /** Origins of the web app, the only ones allowed to call this backend from a browser. */
  webOrigins: string[];
  mcpUrl: string;
  /** Persona id to the bearer token that persona uses against the MCP server. */
  personaTokens: Record<string, string>;
  agent: {
    model: string;
    /** Thinking depth. Low keeps spoken replies quick. */
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Ask the API to retry on another model if a safety classifier declines. */
    fallback: boolean;
    maxTokens: number;
    /** Most model calls in one turn before giving up. */
    maxRounds: number;
    /** Most user turns in one session, a guard on spend. */
    maxTurnsPerSession: number;
  };
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function parsePersonaTokens(value: string | undefined): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const entry of (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const split = entry.indexOf(':');
    const id = entry.slice(0, split).trim();
    const token = entry.slice(split + 1).trim();
    if (split < 1 || !token) throw new Error(`SIM_PERSONAS entry "${entry}" must look like persona:token`);
    if (!PERSONAS.some((persona) => persona.id === id)) throw new Error(`SIM_PERSONAS names unknown persona "${id}"`);
    if (id in tokens) throw new Error(`SIM_PERSONAS lists "${id}" twice`);
    tokens[id] = token;
  }
  return tokens;
}

const number = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive whole number`);
  return parsed;
};

export function loadSimConfig(env: NodeJS.ProcessEnv = process.env): SimConfig {
  const personaTokens = parsePersonaTokens(env.SIM_PERSONAS);
  if (Object.keys(personaTokens).length === 0) {
    throw new Error('Set SIM_PERSONAS, for example alex:token-alex (the MCP_USER_TOKENS of the server)');
  }
  const effort = (env.RESOLVEAI_AGENT_EFFORT ?? 'low') as SimConfig['agent']['effort'];
  if (!EFFORTS.includes(effort)) throw new Error(`RESOLVEAI_AGENT_EFFORT must be one of ${EFFORTS.join(', ')}`);

  return {
    host: env.SIM_HOST ?? '127.0.0.1',
    port: number(env.SIM_PORT, 3200, 'SIM_PORT'),
    // Both spellings of the local address, since a browser treats them as different origins.
    webOrigins: (env.SIM_WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
    mcpUrl: env.SIM_MCP_URL ?? 'http://127.0.0.1:3000/mcp',
    personaTokens,
    agent: {
      model: env.RESOLVEAI_AGENT_MODEL ?? 'claude-sonnet-5-5',
      effort,
      fallback: env.RESOLVEAI_AGENT_FALLBACK !== 'off',
      maxTokens: number(env.SIM_MAX_TOKENS, 8192, 'SIM_MAX_TOKENS'),
      maxRounds: number(env.SIM_MAX_ROUNDS, 8, 'SIM_MAX_ROUNDS'),
      maxTurnsPerSession: number(env.SIM_MAX_TURNS, 40, 'SIM_MAX_TURNS'),
    },
  };
}
