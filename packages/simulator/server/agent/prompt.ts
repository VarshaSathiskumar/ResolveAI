import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The system prompt, read once from the playbook. It must stay byte-identical across every call of every session:
 * no dates, no names, nothing per-user. The agent learns who it is talking to through the tools, and that keeps the
 * start of the request (tools, then this) cacheable.
 */
export const SYSTEM_PROMPT: string = readFileSync(resolve(here, 'playbook.md'), 'utf8');
