import { useEffect, useRef, useState } from 'react';
import type { Citation } from '../../../shared/events';
import { readResource } from '../api';
import { shortCitation } from '../format';

interface Props {
  sessionId: string;
  citation: Citation;
  onClose: () => void;
}

/** The cited page of the manual, read through the backend, so a spoken source can be checked. */
export function PageDialog({ sessionId, citation, onClose }: Props) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  // Hand focus back to whatever opened the page, so keyboard users land where they were.
  useEffect(() => () => (opener.current as HTMLElement | null)?.focus?.(), []);

  useEffect(() => {
    let cancelled = false;
    readResource(sessionId, citation.uri)
      .then((resource) => !cancelled && setText(resource.text))
      .catch(() => !cancelled && setFailed(true));
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab') return;
      // Keep Tab inside the dialog while it is open.
      const stops = [...(dialog.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? [])];
      if (stops.length === 0) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
    };
  }, [sessionId, citation.uri, onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label={citation.citation} onClick={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2>{shortCitation(citation.citation)}</h2>
          <button ref={closeButton} type="button" className="icon-button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        {failed ? <p className="muted">That page could not be loaded.</p> : text === undefined ? <p className="muted">Loading the page...</p> : <pre className="dialog__body" tabIndex={0}>{text}</pre>}
      </div>
    </div>
  );
}
