import { asksWhichProduct, overlap, SAME } from './metrics.js';
import type { Check, TurnRecord } from './harness.js';

export const BP200 = 'brewwell-brew-pro-200';
export const BP300 = 'brewwell-brew-pro-300';
export const DRIPMATE = 'brewwell-dripmate-12';
export const ES1 = 'brewwell-espresso-studio-es1';

const LOOKUPS = ['search_troubleshooting', 'identify_product', 'list_owned_products'];
export const check = (name: string, test: Check['test']): Check => ({ name, test });
const called = (turn: TurnRecord, name: string) => turn.calls.filter((call) => call.name === name);

// Expectations. Each one describes what a good agent does on that line, whatever the wording.
export const noTools = check('uses no tools', (turn) => turn.calls.length === 0);
export const noLookups = check('runs no search or product lookup', (turn) => !turn.calls.some((call) => LOOKUPS.includes(call.name)));
export const noProductQuestion = check('does not ask which machine', (turn) => !asksWhichProduct(turn.reply));
export const asksProduct = check('asks which machine', (turn) => asksWhichProduct(turn.reply));
export const noTroubleshooting = check('does not restart troubleshooting', (turn) => !/couldn't find that|error code|light pattern|did that help/i.test(turn.reply));
export const replies = check('replies', (turn) => turn.reply.trim().length > 0 && turn.reason === 'end_turn');
export const never = (...names: string[]) => check(`never calls ${names.join(', ')}`, (turn) => !turn.calls.some((call) => names.includes(call.name)));
export const calls = (name: string, where?: (input: Record<string, unknown>) => boolean, label = '') =>
  check(`calls ${name}${label}`, (turn) => called(turn, name).some((call) => !where || where(call.input)));
export const searches = (productId: string) => calls('search_troubleshooting', (input) => input.product_id === productId, ` for ${productId}`);
/** The warranty of a machine, from a check or, when that was already done, from what the conversation already knows. */
export const warrantyFor = (productId: string) =>
  check(`gets the warranty for ${productId}`, (turn, history) => {
    const checked = turn.calls.some((call) => call.name === 'check_warranty' && call.input.product_id === productId);
    const knew = history.some((earlier) => earlier.calls.some((call) => call.name === 'check_warranty' && call.input.product_id === productId));
    return checked || (knew && /covered|warranty/i.test(turn.reply));
  });
export const queryMentions = (pattern: RegExp) => calls('search_troubleshooting', (input) => pattern.test(String(input.query)), ` with ${pattern}`);
export const says = (pattern: RegExp) => check(`reply matches ${pattern}`, (turn) => pattern.test(turn.reply));
export const doesNotSay = (pattern: RegExp) => check(`reply does not match ${pattern}`, (turn) => !pattern.test(turn.reply));
export const noRepeat = (back = 1) =>
  check(`does not repeat its previous ${back === 1 ? 'reply' : `${back} replies`}`, (turn, history) =>
    history.slice(-back).every((earlier) => overlap(earlier.reply, turn.reply) < SAME),
  );
export const restatesPrevious = check('restates what it said before', (turn, history) => overlap(history.at(-1)?.reply ?? '', turn.reply) >= 0.3);
export const recordsOutcome = (resolved?: boolean) =>
  calls('record_diagnostic_step', (input) => input.kind === 'outcome' && (resolved === undefined || (input.resolved === true) === resolved), resolved === undefined ? ' (outcome)' : ` (outcome, resolved ${resolved})`);
export const opensTicket = [calls('create_support_case'), says(/RAI-\d{4}-\d{6}/)];
export const noTicket = [never('create_support_case'), doesNotSay(/RAI-\d{4}-\d{6}/)];
export const offersSupport = says(/support|warranty|case/i);

