import type { KeyboardEvent } from 'react';
import type { PersonaInfo } from '../../../shared/events';

interface Props {
  personas: PersonaInfo[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function PersonaPicker({ personas, selected, onSelect, disabled }: Props) {
  // A radio group is one tab stop; the arrow keys move the choice, as people expect from the pattern.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled || personas.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, personas.findIndex((persona) => persona.id === selected));
    const next = personas[(current + step + personas.length) % personas.length]!;
    onSelect(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-persona="${next.id}"]`)?.focus();
  };

  return (
    <div className="personas" role="radiogroup" aria-label="Who is calling" onKeyDown={onKeyDown}>
      {personas.map((persona, index) => (
        <button
          key={persona.id}
          type="button"
          role="radio"
          aria-checked={persona.id === selected}
          data-persona={persona.id}
          tabIndex={persona.id === selected || (selected === undefined && index === 0) ? 0 : -1}
          className={`persona${persona.id === selected ? ' persona--selected' : ''}`}
          title={persona.note}
          disabled={disabled}
          onClick={() => onSelect(persona.id)}
        >
          <span className="persona__name">{persona.name}</span>
          <span className="persona__note">{persona.note}</span>
        </button>
      ))}
    </div>
  );
}
