import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { PersonaInfo } from '../../shared/events';
import { ApiError, cancelTurn, closeSession, createSession, openEvents, sendMessage, type ConnectionStatus, type CreatedSession } from './api';
import { initialState, reduce } from './state';

export type SessionStatus = 'idle' | 'starting' | 'ready' | 'failed';

/** One conversation: opens a backend session for the persona, follows its events, and sends messages. */
export function useSession(persona: PersonaInfo | undefined) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<CreatedSession>();
  const [generation, setGeneration] = useState(0);
  const active = useRef<CreatedSession | undefined>(undefined);

  useEffect(() => {
    if (!persona) return;
    let closed = false;
    let stop: (() => void) | undefined;
    setStatus('starting');
    setError(undefined);
    setSession(undefined);
    dispatch({ type: 'reset' });
    createSession(persona.id)
      .then((created) => {
        if (closed) {
          void closeSession(created.sessionId).catch(() => {});
          return;
        }
        active.current = created;
        setSession(created);
        setStatus('ready');
        stop = openEvents(created.sessionId, dispatch, setConnection);
      })
      .catch((failure: unknown) => {
        if (closed) return;
        setStatus('failed');
        setError(failure instanceof ApiError ? failure.message : 'Could not reach the simulator backend. Is it running?');
      });
    return () => {
      closed = true;
      stop?.();
      const current = active.current;
      active.current = undefined;
      if (current) void closeSession(current.sessionId).catch(() => {});
    };
  }, [persona?.id, generation]);

  const send = useCallback(async (text: string) => {
    const current = active.current;
    if (!current) return;
    try {
      await sendMessage(current.sessionId, text);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not send that message.');
    }
  }, []);

  const cancel = useCallback(() => {
    const current = active.current;
    if (current) void cancelTurn(current.sessionId).catch(() => {});
  }, []);

  /** Starts over: closes this session and opens a fresh one for the same persona. */
  const restart = useCallback(() => setGeneration((value) => value + 1), []);

  return { state, status, connection, error, session, send, cancel, restart };
}
