#!/usr/bin/env bun
// CLI: validate | expand (M1). run | estimate | classify | judge | label | report are added in later milestones.
import { Command, InvalidArgumentError } from 'commander';
import { getModel } from './models.ts';
import { runBatch, today } from './run.ts';
import { PARAPHRASE_SETS, expand, loadProbes, loadScenarios } from './scenario.ts';
import { validateAll } from './validate.ts';

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

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
  .option('--n <n>', 'runs per cell (multiple of 3, or 1-2 for smoke); default per model', (v) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1) throw new InvalidArgumentError('expected a positive integer');
    return x;
  })
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

await program.parseAsync();
