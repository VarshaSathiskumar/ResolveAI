import type { PersonaInfo } from '../shared/events.js';

/** The demo users from corpus/demo.json. The MCP token for each comes from configuration, never from the browser. */
export const PERSONAS: PersonaInfo[] = [
  { id: 'alex', name: 'Alex', note: 'Owns one machine: "my coffee machine" needs no question.' },
];

export function personaById(id: string): PersonaInfo | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}
