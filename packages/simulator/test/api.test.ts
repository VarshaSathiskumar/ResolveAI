// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, cancelTurn, createSession, listPersonas, openEvents, readResource, sendMessage } from '../web/src/api';

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body?: unknown) => vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));

describe('api client', () => {
  it('lists personas and creates a session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ personas: [{ id: 'alex', name: 'Alex', note: '' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 's1', persona: { id: 'alex' }, model: 'm', tools: [] }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listPersonas()).toEqual([{ id: 'alex', name: 'Alex', note: '' }]);
    expect((await createSession('alex')).sessionId).toBe('s1');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/sessions');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ persona: 'alex' });
  });

  it('turns a failed request into an ApiError carrying the backend message and status', async () => {
    vi.stubGlobal('fetch', respond(409, { error: 'The assistant is still answering the last message' }));
    const failure = await sendMessage('s1', 'hi').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409, message: 'The assistant is still answering the last message' });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(cancelTurn('s1')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });

  it('encodes the resource uri', async () => {
    const fetchMock = respond(200, { uri: 'doc://3#p2', text: 'page' });
    vi.stubGlobal('fetch', fetchMock);
    await readResource('s1', 'doc://3#p2');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s1/resource?uri=doc%3A%2F%2F3%23p2');
  });
});

describe('openEvents', () => {
  class FakeEventSource {
    static last: FakeEventSource;
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (message: { data: string }) => void;
    closed = false;
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    close() {
      this.closed = true;
    }
  }

  it('parses events, reports connection status, ignores garbage, and can be closed', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const events: unknown[] = [];
    const statuses: string[] = [];
    const close = openEvents('s1', (event) => events.push(event), (status) => statuses.push(status));
    const source = FakeEventSource.last;
    expect(source.url).toBe('/api/sessions/s1/events');
    source.onopen?.();
    source.onmessage?.({ data: JSON.stringify({ type: 'turn_started', turnId: 't' }) });
    source.onmessage?.({ data: '{not json' });
    source.onerror?.();
    expect(events).toEqual([{ type: 'turn_started', turnId: 't' }]);
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting']);
    close();
    expect(source.closed).toBe(true);
  });
});
