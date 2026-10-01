import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDeps } from './deps.js';

const config = loadConfig();
const deps = await createDeps(config);
const app = createApp(config, deps);

app.server.listen(config.port, config.host, () => {
  console.log(`ResolveAI MCP server listening on http://${config.host}:${config.port}/mcp`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => {
      deps.close();
      process.exit(0);
    });
  });
}
