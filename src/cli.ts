#!/usr/bin/env bun
// CLI: validate | expand | run | classify | judge | label (estimate and report: M5).
import { Command, InvalidArgumentError } from 'commander';
import { classifyRuns } from './classify.ts';
import { judgeBatch } from './judge.ts';
import { labelInteractive, stratifiedSample } from './label.ts';
import { getModel, hasKey, JUDGES, languageModel, OPTIONAL_JUDGES } from './models.ts';
import { loadBatch } from './store.ts';
import { runBatch, today } from './run.ts';
import { PARAPHRASE_SETS, expand, loadProbes, loadScenarios } from './scenario.ts';
import { validateAll } from './validate.ts';

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

const positiveInt = (v: string) => {
  const x = Number(v);
  if (!Number.isInteger(x) || x < 1) throw new InvalidArgumentError('expected a positive integer');
  return x;
};

/** Load and classify a batch against the current scenario files, warning about anything skipped. */
function currentBatch(batch: string, models?: string[], includeStale?: boolean) {
  const { scenarios, errors: loadErrors } = loadScenarios();
  for (const e of loadErrors) console.warn(`warn  ${e.path}: ${e.message}`);
  const { runs, errors } = loadBatch(batch, models);
  const cb = classifyRuns(runs, errors, new Map(scenarios.map((l) => [l.scenario.id, l])), { includeStale });
  if (cb.stale) console.warn(`warn  ${cb.stale} runs come from an older scenario version and were ${includeStale ? 'included' : 'excluded (re-run, or pass --include-stale)'}`);
  if (cb.unknownScenarios.length) console.warn(`warn  skipped runs of unknown/unloadable scenarios: ${cb.unknownScenarios.join(', ')}`);
  return cb;
}

const program = new Command().name('take-my-word').description('Verification-blocked refusal benchmark');

program
  .command('validate')
  .description('Validate scenario YAMLs (schema, banned phrases, paraphrases, stakes leakage, cell coverage)')
  .action(() => {
    const { scenarios, errors } = loadScenarios();
    const probes = loadProbes();
    const r = validateAll(scenarios, errors, probes);
    for (const w of r.warnings) console.warn(`warn  ${w}`);
    for (const e of r.errors) console.error(`ERROR ${e}`);
    const cases = r.errors.length ? 0 : expand(scenarios, probes).length;
    console.log(
      `${scenarios.length} scenarios, ${r.errors.length} errors, ${r.warnings.length} warnings` +
        (cases ? `, ${cases} cases (${cases / 3} cells × 3 paraphrase sets)` : ''),
    );
    process.exit(r.errors.length ? 1 : 0);
  });

program
  .command('expand')
  .description('List concrete cases; with --show, print the rendered prompts of matching cases')
  .option('--scenarios <ids>', 'comma-separated scenario ids', list)
  .option('--cells <ids>', 'comma-separated cell ids or prefixes (e.g. core, probe.ev-none)', list)
  .option('--sets <ps>', 'paraphrase sets, e.g. 0,1', (v) => {
    const ps = [...new Set(list(v).map(Number))];
    const bad = ps.filter((p) => !Number.isInteger(p) || p < 0 || p >= PARAPHRASE_SETS);
    if (bad.length || !ps.length) throw new InvalidArgumentError(`expected sets in 0..${PARAPHRASE_SETS - 1}, got "${v}"`);
    return ps;
  })
  .option('--show', 'print system prompt and operator turns')
  .action((o: { scenarios?: string[]; cells?: string[]; sets?: number[]; show?: boolean }) => {
    const { scenarios, errors } = loadScenarios();
    if (errors.length) {
      for (const e of errors) console.error(`ERROR ${e.path}: ${e.message}`);
      process.exit(1);
    }
    const cases = expand(scenarios, loadProbes(), o);
    for (const c of cases) {
      console.log(`${c.case_id}  expected=${c.expected}  verifier=${c.cell.verifier}  ${JSON.stringify(c.cell.factors)}`);
      if (!o.show) continue;
      console.log(`\n--- system ---\n${c.system}`);
      c.turns.forEach((t, i) => console.log(`\n--- operator turn ${i + 1} ---\n${t}`));
      console.log(`\n--- indices --- ${JSON.stringify(c.indices)}\n`);
    }
    console.log(`${cases.length} cases`);
  });

program
  .command('run')
  .description('Run cases against models; resumable (completed reps are skipped)')
  .requiredOption('--models <ids>', 'comma-separated registry ids (see src/models.ts; mock-* for offline)', list)
  .option('--scenarios <ids>', 'comma-separated scenario ids', list)
  .option('--cells <ids>', 'comma-separated cell ids or prefixes', list)
  .option('--n <n>', 'runs per cell (multiple of 3, or 1-2 for smoke); default per model', positiveInt)
  .option('--batch <name>', 'results/<batch>/ directory (default: today; mock runs need a mock- prefix)')
  .option('--dry-run', 'plan only: count runs, make no calls')
  .action(async (o: { models: string[]; scenarios?: string[]; cells?: string[]; n?: number; batch?: string; dryRun?: boolean }) => {
    const models = o.models.map(getModel);
    const batch = o.batch ?? (models.every((m) => m.provider === 'mock') ? `mock-${today()}` : today());
    const s = await runBatch({ batch, models, scenarios: o.scenarios, cells: o.cells, n: o.n, dryRun: o.dryRun });
    console.log(
      `batch ${batch}: planned ${s.planned}, already done ${s.skipped}, completed ${s.completed}, errors ${s.errors}` +
        (o.dryRun ? ' (dry run)' : ''),
    );
    process.exit(s.errors ? 2 : 0);
  });

program
  .command('classify')
  .description('Recompute outcome states for a batch from the tool log (no API calls) and print a summary')
  .requiredOption('--batch <name>', 'results/<batch>/')
  .option('--models <ids>', 'comma-separated registry ids', list)
  .option('--include-stale', 'include runs rendered from an older scenario version')
  .action((o: { batch: string; models?: string[]; includeStale?: boolean }) => {
    const cb = currentBatch(o.batch, o.models, o.includeStale);
    const table = new Map<string, Map<string, number>>();
    const bump = (model: string, state: string) => {
      const row = table.get(model) ?? new Map<string, number>();
      row.set(state, (row.get(state) ?? 0) + 1);
      table.set(model, row);
    };
    for (const { run, c } of cb.rows) bump(run.model.registry_id, c.state);
    for (const e of cb.errors) bump(e.model.registry_id, 'API_ERROR');
    for (const [m, row] of table) console.log(`${m}: ${[...row].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  });

program
  .command('judge')
  .description('Run the blind judge panel over a batch (family-excluded; resumable)')
  .requiredOption('--batch <name>', 'results/<batch>/')
  .option('--models <ids>', 'tested models to judge (default all in the batch)', list)
  .option('--judges <ids>', 'judge ids (default: panel members whose API key is set)', list)
  .option('--include-stale', 'also judge runs from an older scenario version')
  .action(async (o: { batch: string; models?: string[]; judges?: string[]; includeStale?: boolean }) => {
    const all = [...JUDGES, ...OPTIONAL_JUDGES];
    const unknown = (o.judges ?? []).filter((id) => !all.some((j) => j.id === id));
    if (unknown.length) {
      console.error(`ERROR not a judge: ${unknown.join(', ')}. Judges: ${all.map((j) => j.id).join(', ')}`);
      process.exit(1);
    }
    const wanted = o.judges ? all.filter((j) => o.judges!.includes(j.id)) : all.filter((j) => JUDGES.includes(j) || hasKey(j.provider));
    const panel = wanted.filter((j) => hasKey(j.provider));
    for (const j of wanted) if (!panel.includes(j)) console.warn(`warn  judge ${j.id} skipped: no API key for ${j.provider}`);
    if (!panel.length) {
      console.error('ERROR no judge has an API key; nothing to do');
      process.exit(1);
    }
    const cb = currentBatch(o.batch, o.models, o.includeStale);
    const s = await judgeBatch({ batch: o.batch, runs: cb.rows.map((r) => r.run), panel, modelFor: languageModel });
    console.log(`judged ${s.done}, already done ${s.skipped}, errors ${s.errors}, runs with no eligible judge ${s.unjudgeable} (panel: ${panel.map((j) => j.id).join(', ')})`);
    process.exit(s.errors ? 2 : 0);
  });

program
  .command('label')
  .description('Hand-label a stratified sample of transcripts (blind view) for judge κ')
  .requiredOption('--batch <name>', 'results/<batch>/')
  .option('--n <n>', 'sample size', positiveInt, 50)
  .option('--seed <s>', 'sampling seed', (v) => {
    const x = Number(v);
    if (!Number.isInteger(x)) throw new InvalidArgumentError('expected an integer');
    return x;
  }, 1)
  .option('--labeler <name>', 'who is labelling', 'simon')
  .action(async (o: { batch: string; n: number; seed: number; labeler: string }) => {
    const cb = currentBatch(o.batch);
    const sample = stratifiedSample(cb.rows, o.n, o.seed);
    const saved = await labelInteractive(o.batch, sample, o.labeler);
    console.log(`saved ${saved} hand labels`);
  });

await program.parseAsync();
