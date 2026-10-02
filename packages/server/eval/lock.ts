import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Freezes an eval query file. The lock records its SHA-256 and the query ids, so an edit, an addition or a
 * removal is detected on every run. The point is operational: queries written before the work they judge
 * cannot be quietly reshaped to fit it afterwards.
 */
export interface LockFile {
  file: string;
  sha256: string;
  ids: string[];
  lockedAt: string;
  /** Every deliberate override, in order. Empty unless someone passed --relock. */
  relocks: { at: string; reason: string; previousSha256: string }[];
}

export type LockStatus = { ok: true; lock: LockFile } | { ok: false; reason: string; lock?: LockFile };

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function idsOf(path: string): string[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { id: string }[]).map((query) => query.id);
}

export function verifyLock(queriesPath: string, lockPath: string): LockStatus {
  if (!existsSync(lockPath)) return { ok: false, reason: `no lock file at ${lockPath}; create one with "npm run eval:lock"` };
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
  const actual = hashFile(queriesPath);
  if (actual !== lock.sha256) {
    const now = new Set(idsOf(queriesPath));
    const was = new Set(lock.ids);
    const added = [...now].filter((id) => !was.has(id)).length;
    const removed = [...was].filter((id) => !now.has(id)).length;
    return {
      ok: false,
      lock,
      reason: `the frozen query file changed since it was locked on ${lock.lockedAt} (${added} added, ${removed} removed, others edited or reordered)`,
    };
  }
  return { ok: true, lock };
}

/** Creates the lock, or with a reason replaces it and records the override. */
export function writeLock(queriesPath: string, lockPath: string, options: { relockReason?: string; now?: Date } = {}): LockFile {
  const at = (options.now ?? new Date()).toISOString();
  const existing = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile) : undefined;
  if (existing && !options.relockReason) throw new Error('A lock already exists. Replacing it needs a reason (--relock "why").');
  if (options.relockReason !== undefined && options.relockReason.trim().length < 10) {
    throw new Error('A relock reason must say why, in at least a sentence fragment (10 characters).');
  }
  const lock: LockFile = {
    file: queriesPath.split('/').pop()!,
    sha256: hashFile(queriesPath),
    ids: idsOf(queriesPath),
    lockedAt: existing ? existing.lockedAt : at,
    relocks: existing
      ? [...existing.relocks, { at, reason: options.relockReason!.trim(), previousSha256: existing.sha256 }]
      : [],
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

const here = dirname(fileURLToPath(import.meta.url));
export const FRESH_PATH = resolve(here, 'queries.fresh.json');
export const LOCK_PATH = resolve(here, 'queries.lock.json');

// `npm run eval:lock` creates the first lock; `-- --status` prints the current state.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--status')) {
    const status = verifyLock(FRESH_PATH, LOCK_PATH);
    console.log(status.ok ? `locked, hash ok (${status.lock.ids.length} queries, ${status.lock.lockedAt}, ${status.lock.relocks.length} relocks)` : `NOT OK: ${status.reason}`);
    process.exit(status.ok ? 0 : 1);
  }
  if (existsSync(LOCK_PATH)) {
    console.error('Already locked. Use --status to check it, or run the eval with --relock "reason" to override.');
    process.exit(1);
  }
  const lock = writeLock(FRESH_PATH, LOCK_PATH);
  console.log(`Locked ${lock.ids.length} queries (${lock.sha256.slice(0, 12)}...) on ${lock.lockedAt}`);
}
