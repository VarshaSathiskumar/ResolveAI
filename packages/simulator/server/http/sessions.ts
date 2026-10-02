import { randomUUID } from 'node:crypto';
import type { PersonaInfo, TraceEvent } from '../../shared/events.js';
import { createConversation, runTurn, type Conversation, type TurnResult } from '../agent/loop.js';
import type { LlmClient } from '../agent/llm.js';
import type { SimConfig } from '../../../../config.js';
import type { McpConnection } from '../mcp/client.js';
import { personaById } from '../personas.js';
import { MAX_MESSAGE_CHARS, SIM_EVENT_LOG_LIMIT, SIM_IDLE_MS, SIM_MAX_SESSIONS } from '../../../../config.js';

export interface LoggedEvent {
  /** Increases by one per event within a session, so a client can resume with Last-Event-ID. */
  id: number;
  event: TraceEvent;
}

export interface Session {
  id: string;
  persona: PersonaInfo;
  mcp: McpConnection;
  conversation: Conversation;
  log: LoggedEvent[];
  listeners: Set<(entry: LoggedEvent) => void>;
  running?: { turn: Promise<TurnResult>; abort: AbortController };
  lastActive: number;
}

export class SessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionManagerOptions {
  config: SimConfig;
  llm: LlmClient;
  connect: (token: string) => Promise<McpConnection>;
  now?: () => number;
  /** Most sessions open at once, a guard on memory and spend. */
  maxSessions?: number;
  idleMs?: number;
  /** Events kept per session for replay. */
  logLimit?: number;
}

export function createSessionManager(options: SessionManagerOptions) {
  const { config, llm, connect, now = Date.now, maxSessions = SIM_MAX_SESSIONS, idleMs = SIM_IDLE_MS, logLimit = SIM_EVENT_LOG_LIMIT } = options;
  const sessions = new Map<string, Session>();

  const closeSession = async (session: Session) => {
    sessions.delete(session.id);
    session.running?.abort.abort();
    session.listeners.clear();
    await session.mcp.close().catch(() => {});
  };

  const sweep = async () => {
    const cutoff = now() - idleMs;
    await Promise.all([...sessions.values()].filter((s) => !s.running && s.lastActive < cutoff).map(closeSession));
  };

  const publish = (session: Session, event: TraceEvent) => {
    const entry: LoggedEvent = { id: (session.log.at(-1)?.id ?? 0) + 1, event };
    session.log.push(entry);
    if (session.log.length > logLimit) session.log.splice(0, session.log.length - logLimit);
    for (const listener of session.listeners) listener(entry);
  };

  return {
    count: () => sessions.size,

    async create(personaId: string): Promise<Session> {
      const persona = personaById(personaId);
      if (!persona) throw new SessionError(400, `Unknown persona "${personaId}"`);
      const token = config.personaTokens[persona.id];
      if (!token) throw new SessionError(400, `No MCP token is configured for ${persona.name}`);
      await sweep();
      if (sessions.size >= maxSessions) throw new SessionError(429, 'Too many open sessions. Close one and try again.');

      const mcp = await connect(token).catch((error: unknown) => {
        throw new SessionError(502, `Could not reach the ResolveAI MCP server: ${error instanceof Error ? error.message : String(error)}`);
      });
      const session: Session = {
        id: randomUUID(),
        persona,
        mcp,
        conversation: createConversation(await mcp.tools()),
        log: [],
        listeners: new Set(),
        lastActive: now(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(id: string): Session {
      const session = sessions.get(id);
      if (!session) throw new SessionError(404, 'Unknown session');
      session.lastActive = now();
      return session;
    },

    /** Starts a turn in the background; its events arrive through the session's listeners. */
    send(id: string, text: string): void {
      const session = this.get(id);
      const trimmed = text.trim();
      if (!trimmed) throw new SessionError(400, 'The message is empty');
      if (trimmed.length > MAX_MESSAGE_CHARS) throw new SessionError(413, `Messages are limited to ${MAX_MESSAGE_CHARS} characters`);
      if (session.running) throw new SessionError(409, 'The assistant is still answering the last message');

      const abort = new AbortController();
      const turn = runTurn({
        conversation: session.conversation,
        userText: trimmed,
        llm,
        mcp: session.mcp,
        config: config.agent,
        emit: (event) => publish(session, event),
        signal: abort.signal,
      }).finally(() => {
        session.running = undefined;
        session.lastActive = now();
      });
      session.running = { turn, abort };
    },

    cancel(id: string): boolean {
      const session = this.get(id);
      if (!session.running) return false;
      session.running.abort.abort();
      return true;
    },

    async close(id: string): Promise<void> {
      await closeSession(this.get(id));
    },

    async closeAll(): Promise<void> {
      await Promise.all([...sessions.values()].map(closeSession));
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
