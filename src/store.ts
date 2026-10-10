// Results persistence (DESIGN §6): results/<batch>/<model>/<case-id>.jsonl, one line per run.
// Append-only. A rep is complete once it has a non-error line; error lines are kept for counting.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from './runner.ts';

export const RESULTS_DIR = join(import.meta.dir, '..', 'results');

export const caseFile = (batch: string, modelId: string, caseId: string, root = RESULTS_DIR) =>
  join(root, batch, modelId, `${caseId}.jsonl`);

/** A truncated final line (process killed mid-append) is dropped; corruption anywhere else throws. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.flatMap((l, i) => {
    try {
      return [JSON.parse(l) as T];
    } catch (e) {
      if (i === lines.length - 1 && !raw.endsWith('\n')) return [];
      throw new Error(`${path}:${i + 1}: ${(e as Error).message}`);
    }
  });
}

export function appendJsonl(path: string, rec: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, `${JSON.stringify(rec)}\n`);
}

/**
 * Reps with a non-error run on disk rendered from the current scenario file and the current prompt
 * template (a YAML edit or a code-level template change invalidates older runs).
 */
export function completedReps(path: string, scenarioHash?: string, promptHash?: string): Set<number> {
  return new Set(
    readJsonl<RunRecord>(path)
      .filter(
        (r) =>
          r.stop_reason !== 'error' &&
          (scenarioHash === undefined || r.scenario_hash === scenarioHash) &&
          (promptHash === undefined || r.prompt_hash === promptHash),
      )
      .map((r) => r.rep),
  );
}

/**
 * Every run in a batch, optionally for some models. For each (model, case, rep) the latest
 * non-error run wins; error runs are returned separately for API_ERROR counts.
 */
export function loadBatch(batch: string, models?: string[], root = RESULTS_DIR): { runs: RunRecord[]; errors: RunRecord[] } {
  const dir = join(root, batch);
  if (!existsSync(dir)) throw new Error(`no such batch: ${dir}`);
  const runs: RunRecord[] = [];
  const errors: RunRecord[] = [];
  for (const m of readdirSync(dir).sort()) {
    const mdir = join(dir, m);
    if (!statSync(mdir).isDirectory() || (models && !models.includes(m))) continue;
    for (const f of readdirSync(mdir).filter((f) => f.endsWith('.jsonl')).sort()) {
      const latest = new Map<number, RunRecord>();
      const errs = new Map<number, RunRecord[]>();
      for (const r of readJsonl<RunRecord>(join(mdir, f))) {
        if (r.stop_reason === 'error') errs.set(r.rep, [...(errs.get(r.rep) ?? []), r]);
        else latest.set(r.rep, r);
      }
      runs.push(...latest.values());
      // An error only counts as API_ERROR if the rep never completed.
      for (const [rep, es] of errs) if (!latest.has(rep)) errors.push(es.at(-1)!);
    }
  }
  return { runs, errors };
}
