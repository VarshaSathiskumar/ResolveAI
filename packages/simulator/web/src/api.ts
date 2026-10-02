import type { PersonaInfo, TraceEvent } from '../../shared/events';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as { error?: string } | undefined);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface CreatedSession {
  sessionId: string;
  persona: PersonaInfo;
  model: string;
  tools: string[];
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
  meta?: Record<string, unknown>;
}

export const listPersonas = () => request<{ personas: PersonaInfo[] }>('/api/personas').then((body) => body.personas);
export const createSession = (persona: string) => request<CreatedSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ persona }) });
export const sendMessage = (sessionId: string, text: string) => request<{ accepted: true }>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
export const cancelTurn = (sessionId: string) => request<{ cancelled: boolean }>(`/api/sessions/${sessionId}/cancel`, { method: 'POST' });
export const closeSession = (sessionId: string) => request<void>(`/api/sessions/${sessionId}`, { method: 'DELETE' });
export const readResource = (sessionId: string, uri: string) => request<ResourceContent>(`/api/sessions/${sessionId}/resource?uri=${encodeURIComponent(uri)}`);

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * Opens the session's event stream. The browser reconnects by itself and sends Last-Event-ID, so the backend resumes
 * after the last event seen. Returns a function that closes the stream.
 */
export function openEvents(sessionId: string, onEvent: (event: TraceEvent) => void, onStatus: (status: ConnectionStatus) => void): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events`);
  onStatus('connecting');
  source.onopen = () => onStatus('live');
  source.onerror = () => onStatus('reconnecting');
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as TraceEvent);
    } catch {
      // A malformed event is dropped rather than breaking the stream.
    }
  };
  return () => source.close();
}
