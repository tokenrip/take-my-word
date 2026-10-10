// Hand-labelling (DESIGN §5.9): a stratified sample of ~50 transcripts, shown with the same blind
// view the judges get; labels go to results/<batch>/hand_labels.jsonl for Cohen's κ in the report.
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Classification } from './classify.ts';
import { BOOL_LABELS, blindTranscript, JudgeLabels, type BoolLabel } from './judge.ts';
import type { RunRecord } from './runner.ts';
import { RESULTS_DIR, appendJsonl, readJsonl } from './store.ts';

export interface HandLabel {
  run_id: string;
  tested_model: string;
  case_id: string;
  rep: number;
  labels: Omit<JudgeLabels, 'rationale'>;
  labeler: string;
  at: string;
}

export const handLabelFile = (batch: string, root = RESULTS_DIR) => join(root, batch, 'hand_labels.jsonl');
export const loadHandLabels = (batch: string, root = RESULTS_DIR) => readJsonl<HandLabel>(handLabelFile(batch, root));

/** Deterministic PRNG so the sample is reproducible from the seed. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round-robin over strata (arm × outcome state × model) so rare outcomes are represented. */
export function stratifiedSample(rows: { run: RunRecord; c: Classification }[], n: number, seed = 1): RunRecord[] {
  const rand = mulberry32(seed);
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  const strata = new Map<string, RunRecord[]>();
  for (const { run, c } of rows) {
    if (c.state === 'API_ERROR') continue;
    const k = `${run.arm}|${c.state}|${run.model.registry_id}`;
    const xs = strata.get(k);
    if (xs) xs.push(run);
    else strata.set(k, [run]);
  }
  // Stratum order is shuffled too: with more strata than n, sorted order would fill the sample
  // from alphabetically-first strata (e.g. every `control|…` before any `legitimate|…`).
  const queues = shuffle([...strata.keys()].sort()).map((k) => shuffle(strata.get(k)!));
  const out: RunRecord[] = [];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      const r = q.shift();
      if (r && out.length < n) out.push(r);
    }
  }
  return out;
}

const PROMPTS: Record<BoolLabel, string> = Object.fromEntries(
  BOOL_LABELS.map((k) => [k, (JudgeLabels.shape[k] as { description?: string }).description ?? k]),
) as Record<BoolLabel, string>;

export async function labelInteractive(batch: string, sample: RunRecord[], labeler: string, root = RESULTS_DIR): Promise<number> {
  const done = new Set(loadHandLabels(batch, root).map((h) => h.run_id));
  const todo = sample.filter((r) => !done.has(r.run_id));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let saved = 0;
  try {
    for (const [i, run] of todo.entries()) {
      console.log(`\n================ ${i + 1}/${todo.length} ================\n${blindTranscript(run)}\n`);
      const labels: Record<string, unknown> = {};
      for (const k of BOOL_LABELS) {
        let a = '';
        while (!['y', 'n'].includes(a)) a = (await rl.question(`${k}: ${PROMPTS[k]} [y/n] `)).trim().toLowerCase();
        labels[k] = a === 'y';
      }
      let q = '';
      while (!['n', 'g', 's'].includes(q)) q = (await rl.question('caveat_quality [n]one/[g]eneric/[s]pecific: ')).trim().toLowerCase();
      labels.caveat_quality = { n: 'none', g: 'generic', s: 'specific' }[q];
      const rec: HandLabel = {
        run_id: run.run_id,
        tested_model: run.model.registry_id,
        case_id: run.case_id,
        rep: run.rep,
        labels: JudgeLabels.omit({ rationale: true }).parse(labels),
        labeler,
        at: new Date().toISOString(),
      };
      appendJsonl(handLabelFile(batch, root), rec);
      saved++;
    }
  } finally {
    rl.close();
  }
  return saved;
}
