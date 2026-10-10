// Batch orchestration: models × cases × reps, per-provider concurrency, resumable (PLAN §5).
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { assertKeys, languageModel, type ModelEntry, type Provider } from './models.ts';
import { runCase, type RunRecord } from './runner.ts';
import { allocate, expand, loadProbes, loadScenarios } from './scenario.ts';
import { appendJsonl, caseFile, completedReps, RESULTS_DIR } from './store.ts';
import { isAction } from './tools.ts';
import { validateAll } from './validate.ts';

const REPO_DIR = join(import.meta.dir, '..');

export const DEFAULT_CONCURRENCY: Record<Provider, number> = { anthropic: 4, openai: 4, google: 2, openrouter: 2, mock: 8 };

export interface BatchOptions {
  batch: string;
  models: ModelEntry[];
  scenarios?: string[];
  cells?: string[];
  /** Runs per cell; defaults to each model's n_default. */
  n?: number;
  concurrency?: Partial<Record<Provider, number>>;
  root?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface BatchSummary {
  planned: number;
  skipped: number;
  completed: number;
  errors: number;
}

export function harnessVersion(): string {
  try {
    const opts = { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    const sha = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const dirty = execSync("git status --porcelain -- . ':!results'", opts).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Mock runs never land in a batch that could be mistaken for real results. */
export function checkBatchName(batch: string, models: ModelEntry[]): void {
  const mock = models.some((m) => m.provider === 'mock');
  const real = models.some((m) => m.provider !== 'mock');
  if (mock && real) throw new Error('do not mix mock and real models in one batch');
  if (mock && !batch.startsWith('mock-')) throw new Error(`mock runs need a batch name starting with "mock-" (got "${batch}")`);
  if (!mock && batch.startsWith('mock-')) throw new Error('"mock-" batches are reserved for mock models');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batch)) throw new Error(`invalid batch name "${batch}"`);
}

export async function runBatch(o: BatchOptions): Promise<BatchSummary> {
  const log = o.log ?? console.log;
  const root = o.root ?? RESULTS_DIR;
  checkBatchName(o.batch, o.models);

  const { scenarios, errors } = loadScenarios();
  const probes = loadProbes();
  const v = validateAll(scenarios, errors, probes);
  if (v.errors.length) throw new Error(`scenarios fail validate (${v.errors.length} errors); run \`validate\``);
  if (!o.dryRun) assertKeys(o.models);

  const byId = new Map(scenarios.map((s) => [s.scenario.id, s.scenario]));
  const version = harnessVersion();
  const limits = new Map<Provider, ReturnType<typeof pLimit>>();
  const limitFor = (p: Provider) => {
    if (!limits.has(p)) limits.set(p, pLimit(o.concurrency?.[p] ?? DEFAULT_CONCURRENCY[p]));
    return limits.get(p)!;
  };

  const summary: BatchSummary = { planned: 0, skipped: 0, completed: 0, errors: 0 };
  const tasks: Promise<void>[] = [];

  for (const entry of o.models) {
    const { sets, reps } = allocate(o.n ?? entry.n_default);
    const cases = expand(scenarios, probes, { scenarios: o.scenarios, cells: o.cells, sets });
    const model = o.dryRun ? null : languageModel(entry);
    for (const rc of cases) {
      const path = caseFile(o.batch, entry.id, rc.case_id, root);
      const done = completedReps(path, rc.scenario_hash, rc.prompt_hash);
      const todo = Array.from({ length: reps }, (_, r) => r).filter((r) => !done.has(r));
      summary.planned += reps;
      summary.skipped += reps - todo.length;
      if (o.dryRun || !todo.length) continue;
      // Reps of one case run sequentially so appends to its file never interleave.
      tasks.push(
        limitFor(entry.provider)(async () => {
          for (const rep of todo) {
            const rec: RunRecord = await runCase(byId.get(rc.scenario_id)!, rc, {
              entry,
              model: model!,
              batch: o.batch,
              rep,
              harnessVersion: version,
            });
            appendJsonl(path, rec);
            const acted = rec.tool_log.find(isAction);
            if (rec.stop_reason === 'error') summary.errors++;
            else summary.completed++;
            log(
              `${entry.id} ${rc.case_id} r${rep}: ${rec.stop_reason}${acted ? ` (action at turn ${acted.turn})` : ''}` +
                (rec.error ? ` ${rec.error.name}: ${rec.error.message.slice(0, 160)}` : ''),
            );
          }
        }),
      );
    }
  }

  if (!o.dryRun) {
    appendJsonl(join(root, o.batch, 'manifest.jsonl'), {
      at: new Date().toISOString(),
      harness_version: version,
      models: o.models.map((m) => m.id),
      scenarios: o.scenarios ?? 'all',
      cells: o.cells ?? 'all',
      n: o.n ?? 'n_default',
      planned: summary.planned,
      skipped: summary.skipped,
    });
  }
  await Promise.all(tasks);
  return summary;
}
