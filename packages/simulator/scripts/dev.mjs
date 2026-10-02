// Starts the whole demo: the ResolveAI MCP server, the simulator backend and the web app.
//   npm run demo            uses Claude if a credential is set, otherwise the offline mock agent
//   npm run demo -- --mock  always the mock agent
//   npm run demo -- --live  always Claude (fails clearly if there is no credential)
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_FILE, DEFAULT_MCP_URL, DEMO_PORT_POLL_MS, DEMO_PORT_TIMEOUT_MS, DEMO_TOKENS, LOCAL_HOST, loadLlmMode, PORTS, TICKET_CARD_HTML } from '../../../config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = new Set(process.argv.slice(2));
const { hasCredential } = loadLlmMode();
const mock = args.has('--mock') || (!args.has('--live') && !hasCredential);
if (args.has('--live') && !hasCredential) {
  console.error('--live needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). Set one, or run without --live to use the mock agent.');
  process.exit(1);
}

if (!existsSync(resolve(root, DB_FILE))) {
  console.error('There is no search index yet. Run `npm run ingest` first (it downloads the embedding model on the first run).');
  process.exit(1);
}

// The support ticket card is a built view; build it once so create_support_case can show it.
if (!existsSync(resolve(root, TICKET_CARD_HTML))) {
  console.log('Building the ticket card...');
  execSync('npm run build:ui -w @resolveai/server', { cwd: root, stdio: 'inherit' });
}

const mcpUsers = Object.entries(DEMO_TOKENS).map(([persona, token]) => `${token}:demo-${persona}`).join(',');
const personas = Object.entries(DEMO_TOKENS).map(([persona, token]) => `${persona}:${token}`).join(',');

const children = [];
const start = (label, command, argv, env) => {
  const child = spawn(command, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) => String(chunk).split('\n').filter(Boolean).forEach((line) => console.log(`[${label}] ${line}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    console.log(`[${label}] exited (${code})`);
    shutdown(code ?? 1);
  });
  children.push(child);
};

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const waitForPort = (port) =>
  new Promise((resolvePort, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = createConnection({ port, host: LOCAL_HOST }, () => {
        socket.end();
        resolvePort();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - started > DEMO_PORT_TIMEOUT_MS) reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, DEMO_PORT_POLL_MS);
      });
    };
    attempt();
  });

console.log(mock ? 'Agent: offline mock (no Claude credential used)' : 'Agent: Claude');
start('mcp', 'npx', ['tsx', 'packages/server/src/index.ts'], { MCP_USER_TOKENS: mcpUsers, PORT: String(PORTS.mcp) });
await waitForPort(PORTS.mcp);
start('backend', 'npx', ['tsx', 'packages/simulator/server/index.ts'], {
  SIM_PERSONAS: personas,
  SIM_MCP_URL: DEFAULT_MCP_URL,
  SIM_PORT: String(PORTS.simulator),
  ...(mock ? { SIM_LLM: 'mock' } : {}),
});
await waitForPort(PORTS.simulator);
// The sandbox for MCP App views runs on its own port, so a view is always on a different origin than the app.
start('sandbox', 'npx', ['vite', '--config', 'packages/simulator/web/sandbox.vite.config.ts'], {});
await waitForPort(PORTS.sandbox);
start('web', 'npx', ['vite', '--config', 'packages/simulator/web/vite.config.ts'], {});
await waitForPort(PORTS.web);
console.log(`\nReady: open http://localhost:${PORTS.web} (or http://${LOCAL_HOST}:${PORTS.web})\n`);
