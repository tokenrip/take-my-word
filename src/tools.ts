// Mocked, deterministic tools (DESIGN §5.1, §7). The toolset is closed: the verifier
// returns the cell's mode payload on every call, the action/audit tools record and
// return ok. Schema-invalid input never reaches `execute`; the SDK surfaces it as a
// tool-error part, which the classifier reads from the step record.
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { FieldSpec, Scenario, ToolSpec } from '../scenarios/schema.ts';
import type { RenderedCase } from './scenario.ts';
import { AUDIT_TOOLS } from './tool-specs.ts';

export type ToolKind = 'verifier' | 'action' | 'audit' | 'sql';
export type SqlClass = 'action' | 'select_verification' | 'other';

export interface ToolLogEntry {
  /** Operator turn (1-based) during which the call executed. */
  turn: number;
  /** Monotonic call order within the run. */
  seq: number;
  tool_call_id: string;
  tool: string;
  kind: ToolKind;
  args: Record<string, unknown>;
  /** For run_sql: how the statement was classified. A SQL "action" counts as the action call. */
  sql_class?: SqlClass;
  output: unknown;
}

/** A call that counts as the action (bespoke action tool, or run_sql classified as action). */
export const isAction = (e: ToolLogEntry): boolean => e.kind === 'action' || (e.kind === 'sql' && e.sql_class === 'action');

/** Records tool calls for one run. The runner advances `turn` before each operator turn. */
export class ToolLog {
  readonly entries: ToolLogEntry[] = [];
  turn = 0;
  record(e: Omit<ToolLogEntry, 'turn' | 'seq'>): void {
    this.entries.push({ ...e, turn: this.turn, seq: this.entries.length });
  }
  actions(): ToolLogEntry[] {
    return this.entries.filter(isAction);
  }
}

function fieldSchema(f: FieldSpec): z.ZodType {
  let s: z.ZodType;
  switch (f.type) {
    case 'string':
      s = f.enum ? z.enum(f.enum as [string, ...string[]]) : z.string();
      break;
    case 'number':
      s = z.number();
      break;
    case 'integer':
      s = z.number().int();
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'string_array':
      s = z.array(z.string());
      break;
  }
  s = s.describe(f.description);
  return f.optional ? s.optional() : s;
}

/** Flat zod object from a field map. Unknown keys are stripped, not rejected, so extra keys never count as invalid. */
export function inputSchema(spec: ToolSpec): z.ZodObject {
  return z.object(Object.fromEntries(Object.entries(spec.fields).map(([k, f]) => [k, fieldSchema(f)])));
}

export function classifySql(sql: string, rules: { action: string; select_verification: string }): SqlClass {
  if (new RegExp(rules.action, 'i').test(sql)) return 'action';
  if (new RegExp(rules.select_verification, 'i').test(sql)) return 'select_verification';
  return 'other';
}

/** Deep copy so a model-visible payload can never be mutated across runs. */
const frozen = <T>(v: T): T => structuredClone(v);

export interface BuiltTools {
  tools: ToolSet;
  /** Names of tools offered to the model in this cell. */
  offered: string[];
  /** Name the classifier treats as the action tool (`run_sql` in the generic cell). */
  actionToolName: string;
}

export function buildTools(s: Scenario, rc: RenderedCase, log: ToolLog): BuiltTools {
  const f = rc.cell.factors;
  const v = s.tools.verifier;
  const payload = v.modes[rc.cell.verifier];
  if (payload === undefined) throw new Error(`${s.id}: verifier has no "${rc.cell.verifier}" mode`);

  const tools: ToolSet = {
    [v.name]: tool({
      description: v.description,
      inputSchema: inputSchema(v),
      execute: async (args, { toolCallId }) => {
        const output = frozen(payload);
        log.record({ tool_call_id: toolCallId, tool: v.name, kind: 'verifier', args, output });
        return output;
      },
    }),
  };

  let actionToolName: string;
  if (f.tool === 'generic') {
    const g = s.tools.generic_alternative;
    if (!g) throw new Error(`${s.id}: tool=generic needs generic_alternative`);
    actionToolName = g.name;
    tools[g.name] = tool({
      description: g.description,
      inputSchema: z.object({ query: z.string().describe('SQL statement to run.') }),
      execute: async (args, { toolCallId }) => {
        const sql_class = classifySql(args.query, g.sql_rules);
        const output = frozen(g.outputs[sql_class]);
        log.record({ tool_call_id: toolCallId, tool: g.name, kind: 'sql', args, sql_class, output });
        return output;
      },
    });
  } else {
    const a = s.tools.action;
    actionToolName = a.name;
    tools[a.name] = tool({
      description: a.description,
      inputSchema: inputSchema(a),
      execute: async (args, { toolCallId }) => {
        const output = { ok: true };
        log.record({ tool_call_id: toolCallId, tool: a.name, kind: 'action', args, output });
        return output;
      },
    });
  }

  if (f.audit !== 'none') {
    const spec = AUDIT_TOOLS[f.audit];
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: inputSchema(spec),
      execute: async (args, { toolCallId }) => {
        const output = { ok: true, entry_id: `AUD-${1000 + log.entries.length}` };
        log.record({ tool_call_id: toolCallId, tool: spec.name, kind: 'audit', args, output });
        return output;
      },
    });
  }

  return { tools, offered: Object.keys(tools), actionToolName };
}
