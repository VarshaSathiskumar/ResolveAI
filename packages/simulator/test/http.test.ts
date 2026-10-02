import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { TraceEvent } from '../shared/events.js';
import { createSimApp, type SimApp } from '../server/http/app.js';
import { createSessionManager } from '../server/http/sessions.js';
import { loadSimConfig, type SimConfig } from '../server/config.js';
import { connectMcp } from '../server/mcp/client.js';
import { callTools, sayThenStop, scriptedLlm, startStack, TOKENS, toolUse, type ScriptedLlm, type Stack } from './helpers.js';

const WEB = 'http://localhost:5173';
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => stack.close());

interface Sim {
  base: string;
  app: SimApp;
  llm: ScriptedLlm;
  config: SimConfig;
  sessions: ReturnType<typeof createSessionManager>;
  /** Every response body seen, to scan for secrets. */
  bodies: string[];
}

const started: SimApp[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

async function startSim(llm: ScriptedLlm, options: { personas?: string; maxSessions?: number; idleMs?: number; now?: () => number } = {}): Promise<Sim> {
  const config = loadSimConfig({
    SIM_PERSONAS: options.personas ?? `alex:${TOKENS.alex}`,
    SIM_WEB_ORIGIN: `${WEB},http://127.0.0.1:5173`,
    SIM_MCP_URL: stack.app.url.toString(),
  });
  const sessions = createSessionManager({
    config,
    llm,
    connect: (token) => connectMcp({ url: config.mcpUrl, token }),
    maxSessions: options.maxSessions,
    idleMs: options.idleMs,
    now: options.now,
  });
  const app = createSimApp(config, sessions);
  started.push(app);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, app, llm, config, sessions, bodies: [] };
}

const server = (sim: Sim) => sim.app.server;
void server;

async function api(sim: Sim, path: string, init: RequestInit = {}) {
  const res = await fetch(`${sim.base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  sim.bodies.push(text);
  return { status: res.status, headers: res.headers, json: text ? (() => { try { return JSON.parse(text); } catch { return undefined; } })() : undefined, text };
}

/** Reads an SSE stream until `done` says the events so far are enough, then closes it. */
async function readEvents(sim: Sim, id: string, done: (events: { id: number; event: TraceEvent }[]) => boolean, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(`${sim.base}/api/sessions/${id}/events`, { headers, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const events: { id: number; event: TraceEvent }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    while (!done(events)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split('\n\n').slice(0, -1)) {
        const idLine = block.split('\n').find((line) => line.startsWith('id: '));
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (idLine && dataLine) events.push({ id: Number(idLine.slice(4)), event: JSON.parse(dataLine.slice(6)) as TraceEvent });
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return events;
}

const complete = (events: { event: TraceEvent }[]) => events.some((entry) => entry.event.type === 'turn_complete');

const newSession = async (sim: Sim, persona = 'alex') => {
  const created = await api(sim, '/api/sessions', { method: 'POST', body: JSON.stringify({ persona }) });
  expect(created.status).toBe(201);
  return created.json as { sessionId: string; persona: { id: string }; model: string; tools: string[] };
};

describe('sessions', () => {
  it('lists the personas and reports health', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const personas = await api(sim, '/api/personas');
    expect(personas.json.personas.map((p: { id: string }) => p.id)).toEqual(['alex']);
    expect(await api(sim, '/api/health')).toMatchObject({ status: 200, json: { ok: true, sessions: 0, model: 'claude-sonnet-5-5' } });
  });

  it('opens a session as a persona and reports the model and the tools it found', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const session = await newSession(sim, 'alex');
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session).toMatchObject({ persona: { id: 'alex' }, model: 'claude-sonnet-5-5' });
    expect(session.tools).toEqual(expect.arrayContaining(['search_troubleshooting', 'create_support_case']));
    expect(sim.sessions.count()).toBe(1);
  });

  it('refuses an unknown persona and a missing persona', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    expect((await api(sim, '/api/sessions', { method: 'POST', body: JSON.stringify({ persona: 'bob' }) })).status).toBe(400);
    expect((await api(sim, '/api/sessions', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('answers 502 when the MCP server cannot be reached or rejects the token', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]), { personas: 'alex:wrong-token' });
    const result = await api(sim, '/api/sessions', { method: 'POST', body: JSON.stringify({ persona: 'alex' }) });
    expect(result.status).toBe(502);
    expect(result.json.error).toMatch(/Could not reach the ResolveAI MCP server/);
  });

  it('caps the number of open sessions and frees one on delete', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]), { maxSessions: 2 });
    const first = await newSession(sim);
    await newSession(sim);
    expect((await api(sim, '/api/sessions', { method: 'POST', body: JSON.stringify({ persona: 'alex' }) })).status).toBe(429);
    expect((await api(sim, `/api/sessions/${first.sessionId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(sim, `/api/sessions/${first.sessionId}`, { method: 'DELETE' })).status).toBe(404);
    await newSession(sim);
  });

  it('closes sessions that have been idle too long when a new one is opened', async () => {
    let clock = 1_000;
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]), { idleMs: 60_000, now: () => clock });
    await newSession(sim);
    expect(sim.sessions.count()).toBe(1);
    clock += 61_000;
    await newSession(sim);
    expect(sim.sessions.count()).toBe(1);
  });

  it('answers 404 for an unknown or malformed session id', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    expect((await api(sim, '/api/sessions/00000000-0000-0000-0000-000000000000/messages', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(404);
    expect((await api(sim, '/api/sessions/not-a-session/messages', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await api(sim, '/api/nowhere')).status).toBe(404);
  });
});

describe('a conversation over HTTP', () => {
  it('streams the turn as it happens: model call, tool call and result, text, completion', async () => {
    const llm = scriptedLlm([callTools(toolUse('t1', 'list_owned_products', {})), sayThenStop('Is it the Brew Pro 200?')]);
    const sim = await startSim(llm);
    const { sessionId } = await newSession(sim);
    const reading = readEvents(sim, sessionId, complete);
    expect((await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'my coffee machine is not brewing' }) })).status).toBe(202);
    const events = await reading;
    const types = events.map((entry) => entry.event.type);
    expect(types[0]).toBe('turn_started');
    expect(types).toEqual(expect.arrayContaining(['model_call', 'tool_call', 'tool_result', 'text_delta']));
    expect(types.at(-1)).toBe('turn_complete');
    expect(events.map((entry) => entry.id)).toEqual(events.map((_, index) => index + 1));
    const last = events.at(-1)!.event as Extract<TraceEvent, { type: 'turn_complete' }>;
    expect(last).toMatchObject({ reason: 'end_turn', text: 'Is it the Brew Pro 200?', rounds: 2 });
  });

  it('replays what a new listener missed, and resumes after the last id a returning one saw', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('Hello there')]));
    const { sessionId } = await newSession(sim);
    const first = readEvents(sim, sessionId, complete);
    await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    const all = await first;

    const replay = await readEvents(sim, sessionId, (events) => events.length >= all.length);
    expect(replay.map((entry) => entry.id)).toEqual(all.map((entry) => entry.id));

    const resumedAfter = all[2]!.id;
    const resumed = await readEvents(sim, sessionId, (events) => events.length >= all.length - 3, { 'Last-Event-ID': String(resumedAfter) });
    expect(resumed.map((entry) => entry.id)).toEqual(all.slice(3).map((entry) => entry.id));
  });

  it('keeps the conversation across messages in one session', async () => {
    const llm = scriptedLlm([sayThenStop('first answer'), sayThenStop('second answer')]);
    const sim = await startSim(llm);
    const { sessionId } = await newSession(sim);
    for (const text of ['one', 'two']) {
      const reading = readEvents(sim, sessionId, (events) => events.filter((e) => e.event.type === 'turn_complete').length >= (text === 'one' ? 1 : 2));
      await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      await reading;
    }
    expect(llm.history[1]!.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('rejects a second message while the assistant is still answering, and cancel stops the turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const llm = scriptedLlm([async (request) => { await Promise.race([gate, new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('aborted'))))]).catch(() => {}); return sayThenStop('late'); }]);
    const sim = await startSim(llm);
    const { sessionId } = await newSession(sim);
    const reading = readEvents(sim, sessionId, complete);
    await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'slow one' }) });
    expect((await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'impatient' }) })).status).toBe(409);
    expect((await api(sim, `/api/sessions/${sessionId}/cancel`, { method: 'POST' })).json).toEqual({ cancelled: true });
    const events = await reading;
    expect(events.at(-1)!.event).toMatchObject({ type: 'turn_complete', reason: 'aborted' });
    release();
    expect((await api(sim, `/api/sessions/${sessionId}/cancel`, { method: 'POST' })).json).toEqual({ cancelled: false });
  });

  it('validates the message: empty, too long, wrong shape, bad JSON, oversized body', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const { sessionId } = await newSession(sim);
    const post = (body: string) => api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body });
    expect((await post(JSON.stringify({ text: '   ' }))).status).toBe(400);
    expect((await post(JSON.stringify({ text: 'x'.repeat(1001) }))).status).toBe(413);
    expect((await post(JSON.stringify({ message: 'x' }))).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(JSON.stringify({ text: 'x'.repeat(9000) }))).status).toBe(413);
  });
});

describe('citations and views', () => {
  it('reads a cited document page through the persona\'s own MCP connection', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const { sessionId } = await newSession(sim);
    const product = await stack.connect('alex').then((c) => c.callTool('get_product', { product_id: 'brewwell-brew-pro-200' }));
    const documentId = (product.structured as { documents: { document_id: number; type: string }[] }).documents.find((d) => d.type === 'troubleshooting')!.document_id;
    const page = await api(sim, `/api/sessions/${sessionId}/resource?uri=${encodeURIComponent(`doc://${documentId}#p2`)}`);
    expect(page.status).toBe(200);
    expect(page.json.text).toMatch(/Clogged needle/);
  });

  it('only reads doc:// and ui:// resources, and says 404 for a page that does not exist', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const { sessionId } = await newSession(sim);
    for (const uri of ['file:///etc/passwd', 'http://169.254.169.254/', 'config://app', '']) {
      expect((await api(sim, `/api/sessions/${sessionId}/resource?uri=${encodeURIComponent(uri)}`)).status, uri).toBe(400);
    }
    expect((await api(sim, `/api/sessions/${sessionId}/resource?uri=${encodeURIComponent('doc://99999#p1')}`)).status).toBe(404);
  });
});

describe('browser safety', () => {
  it('answers a preflight for the web origin only', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const ok = await fetch(`${sim.base}/api/sessions`, { method: 'OPTIONS', headers: { Origin: WEB, 'Access-Control-Request-Method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(ok.headers.get('access-control-allow-methods')).toMatch(/POST/);
    const bad = await fetch(`${sim.base}/api/sessions`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts either local spelling of the web origin', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    const loopback = await api(sim, '/api/personas', { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });

  it('refuses every route from a foreign origin, and sets the allow header only for the web origin', async () => {
    const sim = await startSim(scriptedLlm([sayThenStop('hi')]));
    expect((await api(sim, '/api/personas', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const fromWeb = await api(sim, '/api/personas', { headers: { Origin: WEB } });
    expect(fromWeb.status).toBe(200);
    expect(fromWeb.headers.get('access-control-allow-origin')).toBe(WEB);
    expect((await api(sim, '/api/personas')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never puts a credential in any response', async () => {
    const sim = await startSim(scriptedLlm([callTools(toolUse('t1', 'list_owned_products', {})), sayThenStop('done')]));
    const { sessionId } = await newSession(sim);
    const reading = readEvents(sim, sessionId, complete);
    await api(sim, `/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
    const events = await reading;
    const everything = [...sim.bodies, JSON.stringify(events)].join('\n');
    for (const secret of [TOKENS.alex, 'Bearer', 'sk-ant', 'ANTHROPIC']) expect(everything, secret).not.toContain(secret);
  });
});
