const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export interface Config {
  host: string;
  port: number;
  bearerToken: string;
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
    allowedHosts: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_HOSTS)],
    allowedOrigins: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_ORIGINS)],
  };
}
