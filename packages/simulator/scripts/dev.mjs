// Starts the whole demo: the ResolveAI MCP server, the simulator backend and the web app.
//   npm run demo            uses Claude if a credential is set, otherwise the offline mock agent
//   npm run demo -- --mock  always the mock agent
//   npm run demo -- --live  always Claude (fails clearly if there is no credential)
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = new Set(process.argv.slice(2));
const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const mock = args.has('--mock') || (!args.has('--live') && !hasCredential);
if (args.has('--live') && !hasCredential) {
  console.error('--live needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). Set one, or run without --live to use the mock agent.');
  process.exit(1);
}

if (!existsSync(resolve(root, 'data/resolveai.db'))) {
  console.error('There is no search index yet. Run `npm run ingest` first (it downloads the embedding model on the first run).');
  process.exit(1);
}

// The support ticket card is a built view; build it once so create_support_case can show it.
if (!existsSync(resolve(root, 'packages/server/dist/ui/ticket-card.html'))) {
  console.log('Building the ticket card...');
  execSync('npm run build:ui -w @resolveai/server', { cwd: root, stdio: 'inherit' });
}

// Demo-only tokens: they exist only on this machine and unlock only the fictional demo accounts.
const TOKENS = { alex: 'demo-token-alex' };
const mcpUsers = Object.entries(TOKENS).map(([persona, token]) => `${token}:demo-${persona}`).join(',');
const personas = Object.entries(TOKENS).map(([persona, token]) => `${persona}:${token}`).join(',');

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
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolvePort();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - started > 120_000) reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });

console.log(mock ? 'Agent: offline mock (no Claude credential used)' : 'Agent: Claude');
start('mcp', 'npx', ['tsx', 'packages/server/src/index.ts'], { MCP_USER_TOKENS: mcpUsers, PORT: '3000' });
await waitForPort(3000);
start('backend', 'npx', ['tsx', 'packages/simulator/server/index.ts'], {
  SIM_PERSONAS: personas,
  SIM_MCP_URL: 'http://127.0.0.1:3000/mcp',
  SIM_PORT: '3200',
  ...(mock ? { SIM_LLM: 'mock' } : {}),
});
await waitForPort(3200);
// The sandbox for MCP App views runs on its own port, so a view is always on a different origin than the app.
start('sandbox', 'npx', ['vite', '--config', 'packages/simulator/web/sandbox.vite.config.ts'], {});
await waitForPort(5174);
start('web', 'npx', ['vite', '--config', 'packages/simulator/web/vite.config.ts'], {});
await waitForPort(5173);
console.log('\nReady: open http://localhost:5173 (or http://127.0.0.1:5173)\n');
