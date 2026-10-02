import { useState } from 'react';
import type { AppState, TraceItem, TurnTrace } from '../state';
import { describeInput, formatMs, formatTokens } from '../format';

function Row({ item, scale }: { item: TraceItem; scale: number }) {
  const [open, setOpen] = useState(false);
  const width = Math.max(2, Math.min(100, ((item.ms ?? 0) / scale) * 100));

  if (item.kind === 'model') {
    return (
      <li className="trace-row trace-row--model">
        <div className="trace-row__line">
          <span className="trace-row__kind">Model</span>
          <span className="trace-row__title">{item.model}</span>
          <span className="trace-row__ms">{formatMs(item.ms)}</span>
        </div>
        <div className="bar" aria-hidden="true"><i style={{ width: `${width}%` }} /></div>
        <div className="trace-row__meta">
          {formatTokens(item.usage)}
          {item.stopReason && item.stopReason !== 'end_turn' ? ` / stop: ${item.stopReason}` : ''}
          {item.servedBy ? ` / served by ${item.servedBy}` : ''}
        </div>
      </li>
    );
  }

  const failed = item.status === 'error';
  return (
    <li className={`trace-row trace-row--tool${failed ? ' trace-row--error' : ''}${item.status === 'running' ? ' trace-row--running' : ''}`}>
      <button type="button" className="trace-row__line trace-row__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="trace-row__kind">{item.status === 'running' ? 'Running' : failed ? 'Failed' : 'Tool'}</span>
        <span className="trace-row__title">{item.name}</span>
        <span className="trace-row__ms">{formatMs(item.ms)}</span>
      </button>
      <div className="bar" aria-hidden="true"><i style={{ width: `${item.status === 'running' ? 6 : width}%` }} /></div>
      <div className="trace-row__args">{describeInput(item.input)}</div>
      {item.summary && <div className="trace-row__result">{item.summary.headline}</div>}
      {item.summary && item.summary.badges.length > 0 && (
        <ul className="badges">
          {item.summary.badges.map((badge) => (
            <li key={badge} className={`badge${/confidence: low|^error$/.test(badge) ? ' badge--warn' : /confidence: high/.test(badge) ? ' badge--good' : ''}`}>
              {badge}
            </li>
          ))}
        </ul>
      )}
      {open && <pre className="trace-row__detail">{item.text ?? JSON.stringify(item.input, null, 2)}</pre>}
    </li>
  );
}

function Turn({ turn, defaultOpen }: { turn: TurnTrace; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const scale = Math.max(1, ...turn.items.map((item) => item.ms ?? 0));
  const models = turn.items.filter((item) => item.kind === 'model');
  const cached = models.reduce((sum, item) => sum + (item.kind === 'model' ? item.usage.cacheReadTokens : 0), 0);
  const toolMs = turn.items.reduce((sum, item) => sum + (item.kind === 'tool' ? item.ms ?? 0 : 0), 0);

  return (
    <article className="turn">
      <button type="button" className="turn__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="turn__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="turn__text">{turn.userText}</span>
        <span className="turn__total">{turn.ms !== undefined ? formatMs(turn.ms) : 'working...'}</span>
      </button>
      <div className="turn__summary">
        {turn.rounds ?? models.length} model call{(turn.rounds ?? models.length) === 1 ? '' : 's'} / {formatMs(toolMs)} in tools{cached > 0 ? ` / ${cached.toLocaleString()} tokens from cache` : ''}
        {turn.reason && turn.reason !== 'end_turn' ? ` / ended: ${turn.reason.replace('_', ' ')}` : ''}
      </div>
      {open && (
        <ol className="trace-list">
          {turn.items.map((item, index) => (
            <Row key={item.kind === 'tool' ? item.toolUseId : `m${item.round}-${index}`} item={item} scale={scale} />
          ))}
        </ol>
      )}
    </article>
  );
}

export function TracePanel({ state, model }: { state: AppState; model?: string }) {
  const turns = [...state.turns].reverse();
  return (
    <aside className="trace" aria-label="Live trace">
      <header className="trace__head">
        <h2>Live trace</h2>
        {model && <span className="pill">{model}</span>}
      </header>
      {turns.length === 0 ? (
        <p className="muted trace__empty">Every model call and tool call shows up here as it happens, with how long it took and what the tool decided.</p>
      ) : (
        turns.map((turn, index) => <Turn key={turn.turnId} turn={turn} defaultOpen={index === 0} />)
      )}
    </aside>
  );
}
