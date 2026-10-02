import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFile, verifyLock, writeLock } from '../eval/lock.js';

let dir: string;
let queries: string;
let lock: string;

const sample = (extra: object[] = []) =>
  JSON.stringify([{ id: 'f001', query: 'a', expect: 'abstain' }, { id: 'f002', query: 'b', expect: 'abstain' }, ...extra], null, 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evallock-'));
  queries = join(dir, 'queries.fresh.json');
  lock = join(dir, 'queries.lock.json');
  writeFileSync(queries, sample());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('eval lock', () => {
  it('reports a missing lock and says how to create one', () => {
    const status = verifyLock(queries, lock);
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.reason).toMatch(/eval:lock/);
  });

  it('records the hash and ids, and then verifies the unchanged file', () => {
    const written = writeLock(queries, lock, { now: new Date('2026-10-01T00:00:00Z') });
    expect(written).toMatchObject({ file: 'queries.fresh.json', ids: ['f001', 'f002'], lockedAt: '2026-10-01T00:00:00.000Z', relocks: [] });
    expect(written.sha256).toBe(hashFile(queries));
    expect(verifyLock(queries, lock).ok).toBe(true);
  });

  it('detects an edited query', () => {
    writeLock(queries, lock);
    writeFileSync(queries, sample().replace('"query": "a"', '"query": "edited"'));
    const status = verifyLock(queries, lock);
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.reason).toMatch(/changed since it was locked/);
  });

  it('detects an added and a removed query', () => {
    writeLock(queries, lock);
    writeFileSync(queries, sample([{ id: 'f003', query: 'c', expect: 'abstain' }]));
    expect(verifyLock(queries, lock)).toMatchObject({ ok: false, reason: expect.stringMatching(/1 added, 0 removed/) });
    writeFileSync(queries, JSON.stringify([{ id: 'f001', query: 'a', expect: 'abstain' }]));
    expect(verifyLock(queries, lock)).toMatchObject({ ok: false, reason: expect.stringMatching(/0 added, 1 removed/) });
  });

  it('detects even a whitespace-only change', () => {
    writeLock(queries, lock);
    writeFileSync(queries, readFileSync(queries, 'utf8') + '\n');
    expect(verifyLock(queries, lock).ok).toBe(false);
  });

  it('refuses to replace an existing lock without a reason', () => {
    writeLock(queries, lock);
    expect(() => writeLock(queries, lock)).toThrow(/needs a reason/);
  });

  it('refuses an empty or token reason', () => {
    writeLock(queries, lock);
    expect(() => writeLock(queries, lock, { relockReason: 'fix' })).toThrow(/why/);
  });

  it('relocking records the reason and the previous hash, and keeps the original lock date', () => {
    const first = writeLock(queries, lock, { now: new Date('2026-10-01T00:00:00Z') });
    writeFileSync(queries, sample([{ id: 'f003', query: 'c', expect: 'abstain' }]));
    const second = writeLock(queries, lock, { relockReason: 'added a query the user supplied', now: new Date('2026-10-02T00:00:00Z') });
    expect(second.lockedAt).toBe(first.lockedAt);
    expect(second.relocks).toEqual([{ at: '2026-10-02T00:00:00.000Z', reason: 'added a query the user supplied', previousSha256: first.sha256 }]);
    expect(verifyLock(queries, lock).ok).toBe(true);
  });
});
