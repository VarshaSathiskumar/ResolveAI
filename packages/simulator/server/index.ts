import { createAnthropicLlm } from './agent/llm.js';
import { createMockLlm } from './agent/mock.js';
import { loadLlmMode, loadSimConfig, MOCK_MODEL } from '../../../config.js';
import { createSimApp } from './http/app.js';
import { createSessionManager } from './http/sessions.js';
import { connectMcp } from './mcp/client.js';

const config = loadSimConfig();
const { mock, hasCredential } = loadLlmMode();

if (mock) {
  config.agent.model = MOCK_MODEL;
  console.warn('SIM_LLM=mock: using the rule-based mock agent, not Claude. Unset it to use the real model.');
} else if (!hasCredential) {
  console.warn('No ANTHROPIC_API_KEY set. Set one, or sign in with `ant auth login`; without a credential every turn will fail. (Or try SIM_LLM=mock.)');
}

const sessions = createSessionManager({
  config,
  llm: mock ? createMockLlm() : createAnthropicLlm(),
  connect: (token) => connectMcp({ url: config.mcpUrl, token }),
});
const app = createSimApp(config, sessions);

app.server.listen(config.port, config.host, () => {
  console.log(`ResolveAI simulator backend on http://${config.host}:${config.port} (agent: ${config.agent.model}, effort ${config.agent.effort}), MCP at ${config.mcpUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
