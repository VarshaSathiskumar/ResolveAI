import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TOKENS, type Era, type TestApp } from './testApp.js';
import { TEST_NOW } from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(() => app.close());

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const today = TEST_NOW.toISOString().slice(0, 10);

interface Warranty {
  status: string;
  purchase_date_source: string;
  purchase_date?: string;
  end_date?: string;
  term_months: number;
  days_remaining?: number;
  days_since_expiry?: number;
  covered: string[];
  not_covered: string[];
  needs: string[];
  guidance: string;
}

const warranty = async (era: Era, token: string, args: Record<string, unknown>) =>
  (await app.call(era, token, 'check_warranty', args)).structuredContent as Warranty;

describe.each(['legacy', 'modern'] as const)('check_warranty over the %s transport', (era) => {
  it("is in warranty for Alex's Brew Pro 200, from the registered purchase date", async () => {
    const out = await warranty(era, TOKENS.alex, { product_id: 'brewwell-brew-pro-200' });
    expect(out).toMatchObject({ status: 'in_warranty', purchase_date_source: 'registered', purchase_date: '2026-03-14', end_date: '2028-03-14', term_months: 24 });
    expect(out.days_remaining).toBe(daysBetween(today, '2028-03-14'));
    expect(out.covered).toContain('pump');
    expect(out.not_covered).toContain('commercial use');
  });

  it('treats the token with no user like an unregistered product', async () => {
    const out = await warranty(era, TOKENS.service, { product_id: 'brewwell-brew-pro-200' });
    expect(out.needs).toEqual(['purchase_date']);
  });
});

describe('check_warranty edge cases', () => {
  it('returns a tool error for an unknown product', async () => {
    const result = await app.call('legacy', TOKENS.alex, 'check_warranty', { product_id: 'nope' });
    expect(result.isError).toBe(true);
  });
});

interface CaseOut {
  case_id: number;
  step_id: number;
  started_new_case: boolean;
  status: string;
  product_id: string | null;
  symptom: string | null;
  steps_recorded: number;
}

interface CaseState {
  case: { case_id: number; status: string; product_id: string | null; product_model: string | null; symptom: string | null } | null;
  steps: { kind: string; content: string }[];
  steps_tried: string[];
  support_case: { ticket_ref: string } | null;
  needs: string[];
}

interface Ticket {
  ticket_ref: string;
  already_existed: boolean;
  simulated: boolean;
  case_id: number;
  symptom: string | null;
  product: { product_id: string; model: string };
  steps_tried: string[];
  warranty: { status: string; end_date?: string };
  warnings: string[];
}

const record = async (era: Era, token: string, args: Record<string, unknown>) => {
  const result = await app.call(era, token, 'record_diagnostic_step', args);
  return { result, out: result.structuredContent as CaseOut };
};
const state = async (era: Era, token: string, args: Record<string, unknown> = {}) =>
  (await app.call(era, token, 'get_case_state', args)).structuredContent as CaseState;

describe('case tools', () => {
  it('closes a case when an outcome is resolved', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'step', content: 'Descaled the machine', product_id: 'brewwell-brew-pro-200', symptom: 'slow' });
    const done = (await record('legacy', TOKENS.alex, { case_id: out.case_id, kind: 'outcome', content: 'Works again', resolved: true })).out;
    expect(done.status).toBe('resolved');
    const next = await state('legacy', TOKENS.alex);
    expect(next.case?.case_id).not.toBe(out.case_id);
  });

  it('warns when a case is escalated before any step was tried', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'answer', content: 'Machine is dead', product_id: 'brewwell-brew-pro-200', symptom: 'dead' });
    const ticket = (await app.call('legacy', TOKENS.alex, 'create_support_case', { case_id: out.case_id, summary: 'Machine will not turn on at all.' })).structuredContent as Ticket;
    expect(ticket.warnings.join(' ')).toMatch(/No troubleshooting steps/);
    expect(ticket.warranty.status).toBe('in_warranty');
  });

  it('needs a product before a ticket can be filed', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'answer', content: 'No idea which model', symptom: 'unknown machine', new_case: true });
    const ticket = await app.call('legacy', TOKENS.alex, 'create_support_case', { case_id: out.case_id, summary: 'Unknown machine will not start.' });
    expect(ticket.isError).toBe(true);
    expect((ticket.content[0] as { text: string }).text).toMatch(/no product/i);
    const current = await state('legacy', TOKENS.alex, { case_id: out.case_id });
    expect(current.needs).toEqual(['product_id']);
  });

  it('starts a separate case on request even when one is open', async () => {
    const first = (await record('legacy', TOKENS.alex, { kind: 'answer', content: 'Needle problem', product_id: 'brewwell-brew-pro-200', symptom: 'drips', new_case: true })).out;
    const forced = (await record('legacy', TOKENS.alex, { kind: 'answer', content: 'Separate leak problem', product_id: 'brewwell-brew-pro-200', symptom: 'leak', new_case: true })).out;
    expect(forced.started_new_case).toBe(true);
    expect(forced.case_id).not.toBe(first.case_id);
  });

  it('refuses an unknown product when recording', async () => {
    const { result } = await record('legacy', TOKENS.alex, { kind: 'step', content: 'x', product_id: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('keeps case tools for signed-in users only', async () => {
    const write = await record('legacy', TOKENS.service, { kind: 'step', content: 'x' });
    expect(write.result.isError).toBe(true);
    expect((write.result.content[0] as { text: string }).text).toMatch(/no account linked/);
    expect((await app.call('legacy', TOKENS.service, 'get_case_state')).isError).toBe(true);
  });
});
