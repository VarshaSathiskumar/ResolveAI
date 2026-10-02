import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeDeps, type TestDeps } from './helpers.js';

export const TOKENS = { alex: 'token-alex', service: 'token-service' };

export type Era = 'legacy' | 'modern';

export interface TestApp {
  deps: TestDeps;
  url: URL;
  /** Calls one tool as the holder of `token`, over the chosen protocol era. */
  call(era: Era, token: string, name: string, args?: Record<string, unknown>): Promise<Awaited<ReturnType<Client['callTool']>>>;
  readResource(token: string, uri: string): Promise<Awaited<ReturnType<Client['readResource']>>>;
  close(): Promise<void>;
}

/** Starts the real server over HTTP with the demo user and one anonymous token. */
export async function startTestApp(): Promise<TestApp> {
  const deps = await makeDeps();
  const app: App = createApp(
    loadConfig({
      MCP_USER_TOKENS: `${TOKENS.alex}:demo-alex`,
      MCP_BEARER_TOKEN: TOKENS.service,
      PORT: '0',
    }),
    deps,
  );
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);

  async function withClient<T>(era: Era, token: string, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(
      { name: 'test-client', version: '0.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  return {
    deps,
    url,
    call: (era, token, name, args = {}) => withClient(era, token, (client) => client.callTool({ name, arguments: args })),
    readResource: (token, uri) => withClient('legacy', token, (client) => client.readResource({ uri })),
    async close() {
      await app.close();
      deps.db.close();
    },
  };
}
