import { PERSONAS } from '../../../config.js';
import type { PersonaInfo } from '../shared/events.js';

export function personaById(id: string): PersonaInfo | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}
