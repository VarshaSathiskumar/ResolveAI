import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Citation, PersonaInfo } from '../../../shared/events';
import type { AppState } from '../state';
import { shortCitation } from '../format';

const SUGGESTIONS = ["My coffee machine isn't brewing", 'The pump is noisy and no water comes out', 'Is my machine still under warranty?'];

interface Props {
  persona: PersonaInfo | undefined;
  state: AppState;
  ready: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  onOpenCitation: (citation: Citation) => void;
  /** Content rendered inside the thread, after the given turn's reply (the ticket card). */
  afterTurn?: (turnId: string) => React.ReactNode;
}

export function Conversation({ persona, state, ready, onSend, onCancel, onOpenCitation, afterTurn }: Props) {
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [state.messages, state.running]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !ready || state.running) return;
    setDraft('');
    onSend(text);
  };

  const citationsFor = (turnId: string) => state.turns.find((turn) => turn.turnId === turnId)?.citations ?? [];
  const thinking = state.running && !state.messages.some((message) => message.role === 'assistant' && message.streaming);

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="thread" aria-live="polite" aria-relevant="additions text">
        {state.messages.length === 0 && (
          <div className="empty">
            <p className="empty__lead">{persona ? `You are speaking as ${persona.name}.` : 'Choose who is calling.'}</p>
            <p className="muted">Try one of these, or say anything.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="suggestion" disabled={!ready} onClick={() => onSend(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {state.messages.map((message) => (
          <div key={message.id}>
            <div className={`bubble bubble--${message.role}${message.streaming ? ' bubble--streaming' : ''}`}>{message.text}</div>
            {message.role === 'assistant' && !message.streaming && citationsFor(message.turnId).length > 0 && (
              <div className="chips" aria-label="Sources">
                {citationsFor(message.turnId).map((citation) => (
                  <button key={citation.uri} type="button" className="chip" onClick={() => onOpenCitation(citation)} title={citation.citation}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
                      <path d="M14 3v5h5" />
                    </svg>
                    {shortCitation(citation.citation)}
                  </button>
                ))}
              </div>
            )}
            {message.role === 'assistant' && !message.streaming && afterTurn?.(message.turnId)}
          </div>
        ))}
        {thinking && (
          <div className="bubble bubble--assistant bubble--thinking" role="status" aria-label="The assistant is working on it">
            <span className="dots"><i /><i /><i /></span>
          </div>
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          className="composer__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={ready ? 'Type what you would say to the assistant' : 'Connecting...'}
          aria-label="Your message"
          maxLength={1000}
          disabled={!ready}
          autoComplete="off"
        />
        {state.running ? (
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button" disabled={!ready || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
