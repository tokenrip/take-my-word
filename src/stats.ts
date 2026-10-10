// Statistics (DESIGN §5.8, PLAN §7): Wilson intervals, a seeded two-stage cluster bootstrap
// (scenarios, then runs within scenario), and Cohen's κ.

/** Deterministic PRNG (mulberry32) so every interval is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Prop {
  k: number;
  n: number;
  p: number | null;
  lo: number | null;
  hi: number | null;
}

export function wilson(k: number, n: number, z = 1.96): Prop {
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Proportion of `true` among non-null flags (null = excluded from the denominator). */
export function propOf(flags: (boolean | null)[]): Prop {
  const xs = flags.filter((f): f is boolean => f !== null);
  return wilson(xs.filter(Boolean).length, xs.length);
}

export interface Interval {
  est: number | null;
  lo: number | null;
  hi: number | null;
  /** Bootstrap replicates that produced a value (a replicate can lack a cell entirely). */
  reps: number;
  /** Replicates attempted. */
  iters: number;
}

function percentile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/**
 * Two-stage cluster bootstrap. `strata` are independent groups of clusters (e.g. legitimate
 * scenarios and control scenarios, resampled separately so each replicate keeps both arms);
 * each cluster is a scenario's rows. Clusters are drawn with replacement within their stratum,
 * then rows with replacement within each drawn cluster. Percentile 95% interval. All `stats`
 * are evaluated on the same resamples. `reps` reports how many replicates produced a value.
 */
export function clusterBootstrapMany<T, K extends string>(
  strata: T[][][],
  stats: Record<K, (rows: T[]) => number | null>,
  o: { iters?: number; seed?: number } = {},
): Record<K, Interval> {
  const iters = o.iters ?? 10_000;
  const rand = mulberry32(o.seed ?? 20261010);
  const keys = Object.keys(stats) as K[];
  const all = strata.flat(2);
  const draws = Object.fromEntries(keys.map((k) => [k, [] as number[]])) as Record<K, number[]>;
  const pick = <U>(xs: U[]) => xs[Math.floor(rand() * xs.length)]!;
  for (let b = 0; b < iters; b++) {
    const rows: T[] = [];
    for (const clusters of strata) {
      for (let c = 0; c < clusters.length; c++) {
        const cluster = pick(clusters);
        for (let r = 0; r < cluster.length; r++) rows.push(pick(cluster));
      }
    }
    for (const k of keys) {
      const v = stats[k](rows);
      if (v !== null && Number.isFinite(v)) draws[k].push(v);
    }
  }
  return Object.fromEntries(
    keys.map((k) => {
      const d = draws[k].sort((a, b) => a - b);
      const est = stats[k](all);
      return [k, d.length ? { est, lo: percentile(d, 0.025), hi: percentile(d, 0.975), reps: d.length, iters } : { est, lo: null, hi: null, reps: 0, iters }];
    }),
  ) as Record<K, Interval>;
}

export function clusterBootstrap<T>(strata: T[][][], stat: (rows: T[]) => number | null, o: { iters?: number; seed?: number } = {}): Interval {
  return clusterBootstrapMany(strata, { v: stat }, o).v;
}

/** Cohen's κ for two binary raters; null when undefined (no pairs, or chance agreement = 1). */
export function cohenKappa(pairs: [boolean, boolean][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n;
  const pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe === 1) return null;
  return (agree - pe) / (1 - pe);
}
