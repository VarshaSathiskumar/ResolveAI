import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStack } from '../test/helpers.js';
import { CATEGORIES, runScenario, type Scenario, type ScenarioRun, type TurnRecord } from './harness.js';
import { COUNT_KEYS, summarize, type Report } from './metrics.js';
import { SCENARIOS } from './scenarios.js';
import { SECOND } from './scenarios.second.js';
import { FINAL } from './scenarios.final.js';

/**
 * Runs every multi-turn scenario against the mock agent and the real tools, then prints how many expectations held and
 * the generic behavior counts (repeats, wasted lookups). The mock stands in for the model, so this measures the loop,
 * the conversation state and the playbook policy it implements, not a language model.
 *
 *   npm run eval:multiturn -w @resolveai/simulator
 *   ... -- --set dev|second|final|all   which scenarios (default dev). The final set is run once, not tuned on.
 *   ... -- --write before          saves eval/results/before.json
 *   ... -- --compare before        prints the run next to eval/results/before.json, scored with the same counts
 *   ... -- --verbose               prints every turn
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const resultsPath = (name: string) => resolve(import.meta.dirname, 'results', `${name}.json`);

const pct = (part: { passed: number; total: number }) => (part.total === 0 ? '   n/a' : `${((100 * part.passed) / part.total).toFixed(0).padStart(4)}%`);
const frac = (part: { passed: number; total: number }) => `${part.passed}/${part.total}`;

function print(report: Report, before?: Report) {
  const delta = (now: number, was: number | undefined) => (was === undefined ? '' : was === now ? '' : `  (was ${was})`);
  console.log(`\n${report.scenarios} scenarios, ${report.turns} customer turns, ${report.checks.total} expectations\n`);
  console.log('Expectations met');
  for (const category of CATEGORIES) {
    const now = report.byCategory[category];
    const was = before?.byCategory[category];
    console.log(`  ${category.padEnd(11)} ${pct(now)}  ${frac(now).padStart(7)}${was ? `   (was ${pct(was).trim()} ${frac(was)})` : ''}`);
  }
  console.log(`  ${'all'.padEnd(11)} ${pct(report.checks)}  ${frac(report.checks).padStart(7)}${before ? `   (was ${pct(before.checks).trim()} ${frac(before.checks)})` : ''}`);
  console.log('\nBehavior counts (lower is better)');
  for (const key of COUNT_KEYS) console.log(`  ${key.padEnd(22)} ${String(report.counts[key]).padStart(3)}${delta(report.counts[key], before?.counts[key])}`);
  console.log(`\nCalls the loop answered itself (never reached the server): ${report.blockedCalls}${delta(report.blockedCalls, before?.blockedCalls ?? (before ? 0 : undefined))}`);
}

function printVerbose(runs: ScenarioRun[]) {
  for (const run of runs) {
    console.log(`\n# ${run.scenario.id} (${run.scenario.persona}, ${run.scenario.category})`);
    run.turns.forEach((turn, index) => {
      console.log(`  ${index + 1}. customer [${turn.kind}]: ${turn.say}`);
      for (const call of turn.calls) console.log(`       tool ${call.name} ${JSON.stringify(call.input)}${call.ok ? '' : ' FAILED'}`);
      for (const call of turn.skipped) console.log(`       skipped ${call.name} ${JSON.stringify(call.input)}`);
      console.log(`       agent: ${turn.reply || `(${turn.reason})`}`);
      for (const result of run.checks.filter((entry) => entry.turn === index + 1 && !entry.passed)) console.log(`       FAIL ${result.name}`);
    });
  }
}

/** A saved run, scored again with the current counts, so both runs are measured the same way. */
function rescore(name: string, pool: Scenario[]): Report {
  const saved = JSON.parse(readFileSync(resultsPath(name), 'utf8')) as { transcripts: { id: string; turns: Partial<TurnRecord>[]; checks: ScenarioRun['checks'] }[] };
  const runs = saved.transcripts.flatMap((entry): ScenarioRun[] => {
    const scenario = pool.find((candidate) => candidate.id === entry.id);
    return scenario ? [{ scenario, checks: entry.checks, turns: entry.turns.map((turn) => ({ skipped: [], calls: [], ...turn }) as TurnRecord) }] : [];
  });
  return summarize(runs);
}

const stack = await startStack();
try {
  const only = value('only');
  const set = value('set') ?? 'dev';
  const pool = { dev: SCENARIOS, second: SECOND, final: FINAL, all: [...SCENARIOS, ...SECOND, ...FINAL] }[set];
  if (!pool) throw new Error(`Unknown --set "${set}". Use dev, second, final or all.`);
  const runs: ScenarioRun[] = [];
  for (const scenario of pool.filter((entry) => !only || entry.id.includes(only))) runs.push(await runScenario(stack, scenario));
  const report = summarize(runs);
  const against = value('compare');
  print(report, against ? rescore(against, pool) : undefined);
  if (flag('failures') || flag('verbose')) {
    console.log('\nFailed expectations');
    for (const failure of report.failures) console.log(`  ${failure.scenario} turn ${failure.turn}: ${failure.check}`);
  }
  if (flag('verbose')) printVerbose(runs);
  const write = value('write');
  if (write) {
    writeFileSync(resultsPath(write), `${JSON.stringify({ report, transcripts: runs.map((run) => ({ id: run.scenario.id, turns: run.turns, checks: run.checks })) }, null, 2)}\n`);
    console.log(`\nSaved eval/results/${write}.json`);
  }
} finally {
  await stack.close();
}
