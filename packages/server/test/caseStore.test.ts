import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeAll(async () => {
  deps = await makeDeps();
});

afterAll(() => deps.db.close());

describe('case store', () => {
  it('opens a case for a user and reads it back', () => {
    const created = deps.cases.open({ userId: 'demo-alex', productId: 'brewwell-brew-pro-200', symptom: 'not brewing' });
    expect(created).toMatchObject({ userId: 'demo-alex', productId: 'brewwell-brew-pro-200', symptom: 'not brewing', status: 'open' });
    expect(deps.cases.get(created.id, 'demo-alex')).toEqual(created);
  });

  it("hides one user's case from another", () => {
    const created = deps.cases.open({ userId: 'demo-alex' });
    expect(deps.cases.get(created.id, 'demo-other')).toBeUndefined();
    expect(deps.cases.get(999_999, 'demo-alex')).toBeUndefined();
  });

  it('finds the latest open case, skipping resolved ones', () => {
    const first = deps.cases.open({ userId: 'demo-other-2' });
    const second = deps.cases.open({ userId: 'demo-other-2' });
    expect(deps.cases.latestOpen('demo-other-2')?.id).toBe(second.id);
    deps.cases.update(second.id, { status: 'resolved' });
    expect(deps.cases.latestOpen('demo-other-2')?.id).toBe(first.id);
    expect(deps.cases.latestOpen('nobody')).toBeUndefined();
  });

  it('keeps steps in the order they were added', () => {
    const created = deps.cases.open({ userId: 'demo-alex' });
    deps.cases.addStep(created.id, 'question', 'Which light is on?');
    deps.cases.addStep(created.id, 'answer', 'Red, blinking');
    deps.cases.addStep(created.id, 'step', 'Cleaned the needle');
    expect(deps.cases.steps(created.id).map((step) => [step.kind, step.content])).toEqual([
      ['question', 'Which light is on?'],
      ['answer', 'Red, blinking'],
      ['step', 'Cleaned the needle'],
    ]);
  });

  it('updates the product and symptom', () => {
    const created = deps.cases.open({ userId: 'demo-alex' });
    deps.cases.update(created.id, { productId: 'brewwell-dripmate-12', symptom: 'slow' });
    expect(deps.cases.get(created.id, 'demo-alex')).toMatchObject({ productId: 'brewwell-dripmate-12', symptom: 'slow' });
  });

  it('files a support case with a ticket reference and marks the case escalated', () => {
    const created = deps.cases.open({ userId: 'demo-alex', productId: 'brewwell-brew-pro-200' });
    const support = deps.cases.createSupportCase({
      caseId: created.id,
      summary: 'Still not brewing',
      stepsTried: ['Cleaned the needle'],
      warrantyStatus: 'in_warranty',
    });
    expect(support.ticketRef).toMatch(/^RAI-2026-\d{6}$/);
    expect(support.stepsTried).toEqual(['Cleaned the needle']);
    expect(deps.cases.supportCaseFor(created.id)).toEqual(support);
    expect(deps.cases.get(created.id, 'demo-alex')?.status).toBe('escalated');
  });

  it('gives each support case its own reference', () => {
    const a = deps.cases.open({ userId: 'demo-alex' });
    const b = deps.cases.open({ userId: 'demo-alex' });
    const refA = deps.cases.createSupportCase({ caseId: a.id, summary: 'a', stepsTried: [], warrantyStatus: 'unknown' }).ticketRef;
    const refB = deps.cases.createSupportCase({ caseId: b.id, summary: 'b', stepsTried: [], warrantyStatus: 'unknown' }).ticketRef;
    expect(refA).not.toBe(refB);
  });
});
