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

  it("has expired for Sam's DripMate 12", async () => {
    const out = await warranty(era, TOKENS.sam, { product_id: 'brewwell-dripmate-12' });
    expect(out).toMatchObject({ status: 'expired', end_date: '2024-11-02', term_months: 12 });
    expect(out.days_since_expiry).toBe(daysBetween('2024-11-02', today));
    expect(out.guidance).toMatch(/would not be covered/);
  });

  it("is in warranty for Sam's ES-1", async () => {
    const out = await warranty(era, TOKENS.sam, { product_id: 'brewwell-espresso-studio-es1' });
    expect(out).toMatchObject({ status: 'in_warranty', end_date: '2027-12-20' });
  });

  it('asks for the purchase date when the product is not registered', async () => {
    const out = await warranty(era, TOKENS.jo, { product_id: 'brewwell-brew-pro-200' });
    expect(out).toMatchObject({ status: 'unknown', purchase_date_source: 'unknown', needs: ['purchase_date'] });
  });

  it('uses a purchase date the user gives for an unregistered product', async () => {
    const out = await warranty(era, TOKENS.jo, { product_id: 'brewwell-brew-pro-200', purchase_date: '2026-06-01' });
    expect(out).toMatchObject({ status: 'in_warranty', purchase_date_source: 'user_provided', end_date: '2028-06-01', needs: [] });
  });

  it('treats the token with no user like an unregistered product', async () => {
    const out = await warranty(era, TOKENS.service, { product_id: 'brewwell-brew-pro-200' });
    expect(out.needs).toEqual(['purchase_date']);
  });
});

describe('check_warranty edge cases', () => {
  it('prefers the registered date over one the user states', async () => {
    const out = await warranty('legacy', TOKENS.sam, { product_id: 'brewwell-dripmate-12', purchase_date: '2026-09-01' });
    expect(out).toMatchObject({ status: 'expired', purchase_date_source: 'registered' });
  });

  it('rejects a malformed date', async () => {
    const result = await app.call('legacy', TOKENS.jo, 'check_warranty', { product_id: 'brewwell-brew-pro-200', purchase_date: 'last spring' }).catch((e: Error) => e);
    expect(result instanceof Error || (result as { isError?: boolean }).isError === true).toBe(true);
  });

  it('reports a date that does not exist as unknown rather than guessing', async () => {
    const out = await warranty('legacy', TOKENS.jo, { product_id: 'brewwell-brew-pro-200', purchase_date: '2026-02-31' });
    expect(out.status).toBe('unknown');
    expect(out.guidance).toMatch(/not a valid date/);
  });

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

describe.each(['legacy', 'modern'] as const)('a troubleshooting case over the %s transport', (era) => {
  it('runs from first symptom to a support ticket', async () => {
    const before = await state(era, TOKENS.jo);
    expect(before.case).toBeNull();
    expect(before.needs).toEqual(['case']);

    const started = (await record(era, TOKENS.jo, {
      kind: 'answer',
      content: 'It is a Brew Pro 200 and only a few drops come out',
      product_id: 'brewwell-brew-pro-200',
      symptom: 'not brewing, only drops',
    })).out;
    expect(started).toMatchObject({ started_new_case: true, status: 'open', product_id: 'brewwell-brew-pro-200', steps_recorded: 1 });

    const step = (await record(era, TOKENS.jo, { case_id: started.case_id, kind: 'step', content: 'Cleaned the piercing needle' })).out;
    expect(step).toMatchObject({ started_new_case: false, case_id: started.case_id, steps_recorded: 2 });
    await record(era, TOKENS.jo, { case_id: started.case_id, kind: 'outcome', content: 'Still blinking red', resolved: false });

    const midway = await state(era, TOKENS.jo);
    expect(midway.case).toMatchObject({ case_id: started.case_id, status: 'open', product_model: 'Brew Pro 200', symptom: 'not brewing, only drops' });
    expect(midway.steps_tried).toEqual(['Cleaned the piercing needle']);
    expect(midway.needs).toEqual([]);

    const ticket = (await app.call(era, TOKENS.jo, 'create_support_case', { summary: 'Brew Pro 200 still blinks red after cleaning the needle.' })).structuredContent as Ticket;
    expect(ticket).toMatchObject({
      already_existed: false,
      simulated: true,
      case_id: started.case_id,
      symptom: 'not brewing, only drops',
      product: { product_id: 'brewwell-brew-pro-200', model: 'Brew Pro 200' },
      steps_tried: ['Cleaned the piercing needle'],
    });
    expect(ticket.ticket_ref).toMatch(/^RAI-2026-\d{6}$/);
    // Jo has no registered purchase date, so the warranty cannot be confirmed.
    expect(ticket.warranty.status).toBe('unknown');
    expect(ticket.warnings.join(' ')).toMatch(/no purchase date/);

    const again = (await app.call(era, TOKENS.jo, 'create_support_case', { case_id: started.case_id, summary: 'Filed a second time by mistake.' })).structuredContent as Ticket;
    expect(again).toMatchObject({ already_existed: true, ticket_ref: ticket.ticket_ref });

    const after = await state(era, TOKENS.jo, { case_id: started.case_id });
    expect(after.case?.status).toBe('escalated');
    expect(after.support_case?.ticket_ref).toBe(ticket.ticket_ref);
    expect(after.steps.at(-1)?.content).toMatch(new RegExp(ticket.ticket_ref));
  });
});

describe('case tools', () => {
  it('closes a case when an outcome is resolved', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'step', content: 'Descaled the machine', product_id: 'brewwell-brew-pro-200', symptom: 'slow' });
    const done = (await record('legacy', TOKENS.alex, { case_id: out.case_id, kind: 'outcome', content: 'Works again', resolved: true })).out;
    expect(done.status).toBe('resolved');
    const next = await state('legacy', TOKENS.alex);
    expect(next.case?.case_id).not.toBe(out.case_id);
  });

  it('files a ticket with the real warranty status and a warning when the warranty has expired', async () => {
    const { out } = await record('legacy', TOKENS.sam, { kind: 'step', content: 'Descaled with vinegar', product_id: 'brewwell-dripmate-12', symptom: 'half a pot' });
    const ticket = (await app.call('legacy', TOKENS.sam, 'create_support_case', { case_id: out.case_id, summary: 'DripMate only makes half a pot even after descaling.' })).structuredContent as Ticket;
    expect(ticket.warranty).toMatchObject({ status: 'expired', end_date: '2024-11-02' });
    expect(ticket.warnings.join(' ')).toMatch(/expired/);
  });

  it('warns when a case is escalated before any step was tried', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'answer', content: 'Machine is dead', product_id: 'brewwell-brew-pro-200', symptom: 'dead' });
    const ticket = (await app.call('legacy', TOKENS.alex, 'create_support_case', { case_id: out.case_id, summary: 'Machine will not turn on at all.' })).structuredContent as Ticket;
    expect(ticket.warnings.join(' ')).toMatch(/No troubleshooting steps/);
    expect(ticket.warranty.status).toBe('in_warranty');
  });

  it("does not show one user's case to another", async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'step', content: 'Private to Alex', product_id: 'brewwell-brew-pro-200', symptom: 'private' });
    const stolen = await app.call('legacy', TOKENS.sam, 'get_case_state', { case_id: out.case_id });
    expect(stolen.isError).toBe(true);
    const write = await app.call('legacy', TOKENS.sam, 'record_diagnostic_step', { case_id: out.case_id, kind: 'step', content: 'Sam writes into it' });
    expect(write.isError).toBe(true);
    const ticket = await app.call('legacy', TOKENS.sam, 'create_support_case', { case_id: out.case_id, summary: 'Sam files a ticket for it.' });
    expect(ticket.isError).toBe(true);
    const own = await state('legacy', TOKENS.sam);
    expect(own.steps.every((entry) => entry.content !== 'Private to Alex')).toBe(true);
  });

  it('needs a product before a ticket can be filed', async () => {
    const { out } = await record('legacy', TOKENS.alex, { kind: 'answer', content: 'No idea which model', symptom: 'unknown machine', new_case: true });
    const ticket = await app.call('legacy', TOKENS.alex, 'create_support_case', { case_id: out.case_id, summary: 'Unknown machine will not start.' });
    expect(ticket.isError).toBe(true);
    expect((ticket.content[0] as { text: string }).text).toMatch(/no product/i);
    const current = await state('legacy', TOKENS.alex, { case_id: out.case_id });
    expect(current.needs).toEqual(['product_id']);
  });

  it('continues the latest open case when case_id is forgotten, instead of splitting the problem', async () => {
    const first = (await record('legacy', TOKENS.sam, { kind: 'answer', content: 'Pump buzzes, no water', product_id: 'brewwell-espresso-studio-es1', symptom: 'buzzing', new_case: true })).out;
    const second = (await record('legacy', TOKENS.sam, { kind: 'step', content: 'Refilled the tank and reseated it' })).out;
    expect(second).toMatchObject({ case_id: first.case_id, started_new_case: false, steps_recorded: 2 });
    const third = (await record('legacy', TOKENS.sam, { kind: 'step', content: 'Ran the brew and steam switches alternately', product_id: 'brewwell-espresso-studio-es1' })).out;
    expect(third).toMatchObject({ case_id: first.case_id, started_new_case: false, steps_recorded: 3 });
  });

  it('fills in a missing product or symptom on the open case without overwriting it', async () => {
    const first = (await record('legacy', TOKENS.jo, { kind: 'answer', content: 'Something is wrong', new_case: true })).out;
    expect(first).toMatchObject({ product_id: null, symptom: null });
    const filled = (await record('legacy', TOKENS.jo, { kind: 'answer', content: 'It is the ES-1', product_id: 'brewwell-espresso-studio-es1', symptom: 'no water' })).out;
    expect(filled).toMatchObject({ case_id: first.case_id, product_id: 'brewwell-espresso-studio-es1', symptom: 'no water' });
    const kept = (await record('legacy', TOKENS.jo, { kind: 'step', content: 'Primed the pump', symptom: 'a different description' })).out;
    expect(kept).toMatchObject({ case_id: first.case_id, symptom: 'no water' });
  });

  it('starts a separate case for a different product', async () => {
    const first = (await record('legacy', TOKENS.sam, { kind: 'answer', content: 'ES-1 problem', product_id: 'brewwell-espresso-studio-es1', symptom: 'buzzing', new_case: true })).out;
    const other = (await record('legacy', TOKENS.sam, { kind: 'answer', content: 'Also the drip machine is slow', product_id: 'brewwell-dripmate-12', symptom: 'slow' })).out;
    expect(other.started_new_case).toBe(true);
    expect(other.case_id).not.toBe(first.case_id);
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

  it('says there is nothing to escalate when no case is open', async () => {
    const ticket = await app.call('legacy', TOKENS.jo, 'create_support_case', { case_id: 999999, summary: 'Nothing here to escalate.' });
    expect(ticket.isError).toBe(true);
  });

  it('keeps case tools for signed-in users only', async () => {
    const write = await record('legacy', TOKENS.service, { kind: 'step', content: 'x' });
    expect(write.result.isError).toBe(true);
    expect((write.result.content[0] as { text: string }).text).toMatch(/no account linked/);
    expect((await app.call('legacy', TOKENS.service, 'get_case_state')).isError).toBe(true);
  });
});
