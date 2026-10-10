// Cost projection for a full grid from a smoke batch's measured usage (PLAN §8, M8 gate).
import type { JudgeRecord } from './judge.ts';
import { judgesFor } from './judge.ts';
import type { ModelEntry } from './models.ts';
import type { RunRecord } from './runner.ts';

export interface EstimateRow {
  model: string;
  cells: number;
  n: number;
  runs: number;
  /** Mean tokens per run, and where the figure came from. */
  per_run: { input: number; output: number; source: 'measured' | 'other models' | 'none' };
  usd_runs: number;
  judge_calls: number;
  usd_judges: number;
}

const usd = (tokIn: number, tokOut: number, m: ModelEntry) => (tokIn * m.price.input + tokOut * m.price.output) / 1e6;

export function estimate(o: {
  models: ModelEntry[];
  cellsPerModel: number;
  n?: number;
  smokeRuns: RunRecord[];
  smokeJudgements: JudgeRecord[];
  panel: ModelEntry[];
}): EstimateRow[] {
  const meanUsage = (rs: RunRecord[]) =>
    rs.length
      ? { input: rs.reduce((a, r) => a + r.usage_total.input, 0) / rs.length, output: rs.reduce((a, r) => a + r.usage_total.output, 0) / rs.length }
      : null;
  const all = meanUsage(o.smokeRuns.filter((r) => r.stop_reason !== 'error'));
  const judgeUsage = o.smokeJudgements.length
    ? {
        input: o.smokeJudgements.reduce((a, j) => a + j.usage.input, 0) / o.smokeJudgements.length,
        output: o.smokeJudgements.reduce((a, j) => a + j.usage.output, 0) / o.smokeJudgements.length,
      }
    : { input: 2500, output: 300 }; // assumption until a judge smoke exists
  return o.models.map((m) => {
    const n = o.n ?? m.n_default;
    const runs = o.cellsPerModel * n;
    const own = meanUsage(o.smokeRuns.filter((r) => r.model.registry_id === m.id && r.stop_reason !== 'error'));
    const per = own ?? all;
    const judges = judgesFor(m.family, o.panel);
    return {
      model: m.id,
      cells: o.cellsPerModel,
      n,
      runs,
      per_run: per ? { ...per, source: own ? 'measured' : 'other models' } : { input: 0, output: 0, source: 'none' },
      usd_runs: per ? runs * usd(per.input, per.output, m) : 0,
      judge_calls: runs * judges.length,
      usd_judges: judges.reduce((a, j) => a + runs * usd(judgeUsage.input, judgeUsage.output, j), 0),
    };
  });
}
