import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log(`ResolveAI MCP server listening on http://${config.host}:${config.port}/mcp`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
