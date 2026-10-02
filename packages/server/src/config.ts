import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export interface Config {
  host: string;
  port: number;
  /** Token with no user behind it. Optional when user tokens are set. */
  bearerToken?: string;
  /** Token to user id, from MCP_USER_TOKENS="token-a:demo-alex,token-b:demo-sam". */
  userTokens: Record<string, string>;
  /** SQLite file built by `npm run ingest`. */
  dbPath: string;
  /** Must match the embedder used at ingestion. */
  embedder: 'transformers' | 'hash';
  /**
   * Cross-encoder reranking of the best search candidates: better first results at roughly 150 ms per search and a
   * second small model to download. `off` serves the fused order with the original confidence rules.
   */
  reranker: 'cross-encoder' | 'off';
  /** Hostnames (no port) accepted in the Host header. */
  allowedHosts: string[];
  /** Hostnames (no scheme or port) accepted in the Origin header. */
  allowedOrigins: string[];
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseUserTokens(value: string | undefined): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const entry of list(value)) {
    const split = entry.indexOf(':');
    const token = entry.slice(0, split).trim();
    const userId = entry.slice(split + 1).trim();
    if (split < 1 || !userId) throw new Error(`MCP_USER_TOKENS entry "${entry}" must look like token:user-id`);
    if (token in tokens) throw new Error('MCP_USER_TOKENS contains the same token twice');
    tokens[token] = userId;
  }
  return tokens;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bearerToken = env.MCP_BEARER_TOKEN || undefined;
  const userTokens = parseUserTokens(env.MCP_USER_TOKENS);
  if (!bearerToken && Object.keys(userTokens).length === 0) {
    throw new Error('Set MCP_USER_TOKENS (token:user-id pairs) or MCP_BEARER_TOKEN');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    bearerToken,
    userTokens,
    dbPath: env.RESOLVEAI_DB ?? resolve(REPO_ROOT, 'data/resolveai.db'),
    embedder: env.RESOLVEAI_EMBEDDER === 'hash' ? 'hash' : 'transformers',
    reranker: env.RESOLVEAI_RERANKER === 'off' ? 'off' : 'cross-encoder',
    allowedHosts: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_HOSTS)],
    allowedOrigins: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_ORIGINS)],
  };
}
