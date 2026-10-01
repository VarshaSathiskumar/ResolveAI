import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export interface Config {
  host: string;
  port: number;
  bearerToken: string;
  /** SQLite file built by `npm run ingest`. */
  dbPath: string;
  /** Must match the embedder used at ingestion. */
  embedder: 'transformers' | 'hash';
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bearerToken = env.MCP_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error('MCP_BEARER_TOKEN must be set');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    bearerToken,
    dbPath: env.RESOLVEAI_DB ?? resolve(REPO_ROOT, 'data/resolveai.db'),
    embedder: env.RESOLVEAI_EMBEDDER === 'hash' ? 'hash' : 'transformers',
    allowedHosts: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_HOSTS)],
    allowedOrigins: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_ORIGINS)],
  };
}
