import { loadProbes, loadScenarios, type LoadedScenario } from '../src/scenario.ts';
import type { Scenario } from '../scenarios/schema.ts';

export const probes = loadProbes();
const { scenarios: loaded } = loadScenarios();

export function real(id: string): LoadedScenario {
  const ls = loaded.find((l) => l.scenario.id === id);
  if (!ls) throw new Error(`scenario ${id} not found`);
  return ls;
}

/** Deep-cloned real scenario with a mutation applied. */
export function mutated(id: string, f: (s: Scenario) => void): LoadedScenario {
  const ls = real(id);
  const s = structuredClone(ls.scenario);
  f(s);
  return { ...ls, scenario: s };
}
