import { useCallback, useEffect, useState } from 'react';
import type { Citation, PersonaInfo } from '../../shared/events';
import { listPersonas } from './api';
import { AppView } from './components/AppView';
import { Conversation } from './components/Conversation';
import { PageDialog } from './components/PageDialog';
import { PersonaPicker } from './components/PersonaPicker';
import { TracePanel } from './components/TracePanel';
import { useSession } from './useSession';

export function App() {
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [citation, setCitation] = useState<Citation>();

  useEffect(() => {
    listPersonas()
      .then((list) => {
        setPersonas(list);
        setSelected((current) => current ?? list[0]?.id);
      })
      .catch(() => setLoadError('Could not reach the simulator backend. Start it with npm run demo.'));
  }, []);

  const persona = personas.find((candidate) => candidate.id === selected);
  const { state, status, connection, error, session, send, cancel, restart } = useSession(persona);
  const closeCitation = useCallback(() => setCitation(undefined), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" data-state={state.running ? 'working' : 'idle'} aria-hidden="true" />
          <h1>ResolveAI</h1>
          <span className="brand__sub">Troubleshooting simulator</span>
        </div>
        <PersonaPicker personas={personas} selected={selected} onSelect={setSelected} disabled={state.running} />
        <button type="button" className="button button--quiet" onClick={restart} disabled={status !== 'ready' || state.running}>
          New conversation
        </button>
      </header>

      {(loadError || error || status === 'failed') && (
        <div className="banner" role="alert">
          {loadError ?? error}
        </div>
      )}
      {connection === 'reconnecting' && status === 'ready' && <div className="banner banner--soft">Reconnecting to the backend...</div>}

      <main className="layout">
        <Conversation
          persona={persona}
          state={state}
          ready={status === 'ready'}
          onSend={(text) => void send(text)}
          onCancel={cancel}
          onOpenCitation={setCitation}
          afterTurn={(turnId) =>
            session
              ? state.uiResources
                  .filter((resource) => resource.turnId === turnId)
                  .map((resource) => <AppView key={resource.toolUseId} sessionId={session.sessionId} resource={resource} title="Support ticket" />)
              : null
          }
        />
        <TracePanel state={state} model={session?.model} />
      </main>

      {citation && session && <PageDialog sessionId={session.sessionId} citation={citation} onClose={closeCitation} />}
    </div>
  );
}
