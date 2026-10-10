// One run = one rep of one rendered case against one model (DESIGN §5.1, PLAN §5).
import { generateText, isStepCount, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import type { Factors, Scenario } from '../scenarios/schema.ts';
import { forcedTextOptions, type ModelEntry } from './models.ts';
import { FORCING_TURN, type ParaphraseIndices, type RenderedCase } from './scenario.ts';
import { buildTools, ToolLog, type ToolLogEntry } from './tools.ts';

export const RUN_SCHEMA_VERSION = 1;
export const STEP_CAP = 4;
export const MAX_OUTPUT_TOKENS = 2048;
export const MAX_RETRIES = 6;

export interface ToolCallPart {
  id: string;
  name: string;
  input: unknown;
  invalid: boolean;
}
export interface ToolErrorPart {
  id: string;
  name: string;
  input: unknown;
  error: string;
}

export interface StepRecord {
  finish_reason: string;
  raw_finish_reason: string | undefined;
  text: string;
  reasoning_text: string | undefined;
  tool_calls: ToolCallPart[];
  tool_results: { id: string; name: string; output: unknown }[];
  tool_errors: ToolErrorPart[];
  usage: { input: number; output: number; reasoning: number; cache_read: number };
  warnings: unknown[];
  response: { id: string | undefined; model_id: string | undefined; timestamp: string | undefined };
  provider_metadata: unknown;
  /** True for the extra text-only step forced after the step cap (A7). */
  forced_text: boolean;
}

export interface TurnRecord {
  turn: number;
  operator_text: string;
  steps: StepRecord[];
  /** Model text for this turn (all steps joined). */
  text: string;
  /** Step cap reached with the last step still calling tools. */
  hit_step_cap: boolean;
  forced_text_step: boolean;
}

export interface RunRecord {
  schema_version: number;
  run_id: string;
  batch: string;
  case_id: string;
  scenario_id: string;
  arm: Scenario['arm'];
  cell_id: string;
  cell_kind: RenderedCase['cell']['kind'];
  factors: Factors;
  verifier_mode: string;
  expected: RenderedCase['expected'];
  rep: number;
  indices: ParaphraseIndices;
  scenario_hash: string;
  model: {
    registry_id: string;
    provider: string;
    requested_model_id: string;
    family: string;
    returned_model_ids: string[];
    /** OpenRouter: upstream provider(s) that served the calls. */
    upstream_providers: string[];
    reasoning_requested: string;
    reasoning_tokens_observed: number;
    temperature_requested: number | null;
    /** Warnings the SDK raised about unsupported settings (the effective-setting evidence). */
    setting_warnings: unknown[];
  };
  settings: { step_cap: number; max_output_tokens: number };
  system: string;
  tools_offered: string[];
  action_tool: string;
  turns: TurnRecord[];
  messages: ModelMessage[];
  tool_log: ToolLogEntry[];
  stop_reason: 'action' | 'forcing_done' | 'provider_refusal' | 'error';
  /** Set when the run aborted before any valid action (the rep is retried on resume). */
  error?: { message: string; name: string };
  /** Set when a call failed after a valid action had already executed; the action stands (tool log is primary). */
  post_action_error?: { message: string; name: string };
  usage_total: { input: number; output: number; reasoning: number; cache_read: number };
  started_at: string;
  ended_at: string;
  harness_version: string;
}

export interface RunContext {
  entry: ModelEntry;
  model: LanguageModel;
  batch: string;
  rep: number;
  harnessVersion: string;
  stepCap?: number;
  /** Overridable for tests. */
  now?: () => Date;
}

const n = (x: number | undefined) => x ?? 0;

function stepRecord(s: StepResult<ToolSet>, forced: boolean): StepRecord {
  const tool_calls: ToolCallPart[] = [];
  const tool_results: StepRecord['tool_results'] = [];
  const tool_errors: ToolErrorPart[] = [];
  for (const p of s.content) {
    if (p.type === 'tool-call') {
      tool_calls.push({ id: p.toolCallId, name: p.toolName, input: p.input, invalid: Boolean((p as { invalid?: boolean }).invalid) });
    } else if (p.type === 'tool-result') {
      tool_results.push({ id: p.toolCallId, name: p.toolName, output: p.output });
    } else if (p.type === 'tool-error') {
      tool_errors.push({ id: p.toolCallId, name: p.toolName, input: p.input, error: String(p.error) });
    }
  }
  return {
    finish_reason: s.finishReason,
    raw_finish_reason: s.rawFinishReason,
    text: s.text,
    reasoning_text: s.reasoningText,
    tool_calls,
    tool_results,
    tool_errors,
    usage: {
      input: n(s.usage.inputTokens),
      output: n(s.usage.outputTokens),
      reasoning: n(s.usage.outputTokenDetails?.reasoningTokens),
      cache_read: n(s.usage.inputTokenDetails?.cacheReadTokens),
    },
    warnings: s.warnings ?? [],
    response: {
      id: s.response?.id,
      model_id: s.response?.modelId,
      timestamp: s.response?.timestamp ? new Date(s.response.timestamp).toISOString() : undefined,
    },
    provider_metadata: s.providerMetadata,
    forced_text: forced,
  };
}

/** Errors are serialized by name + message only; never persist request headers (they carry API keys). */
function errorInfo(e: unknown): { message: string; name: string } {
  const err = e instanceof Error ? e : new Error(String(e));
  return { name: err.name, message: err.message.slice(0, 2000) };
}

export async function runCase(s: Scenario, rc: RenderedCase, ctx: RunContext): Promise<RunRecord> {
  const now = ctx.now ?? (() => new Date());
  const stepCap = ctx.stepCap ?? STEP_CAP;
  const started_at = now().toISOString();
  const log = new ToolLog();
  const built = buildTools(s, rc, log);
  const messages: ModelMessage[] = [];
  const turns: TurnRecord[] = [];
  let stop_reason: RunRecord['stop_reason'] = 'forcing_done';
  let error: RunRecord['error'];
  let post_action_error: RunRecord['post_action_error'];

  const common = {
    model: ctx.model,
    instructions: rc.system,
    tools: built.tools,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: MAX_RETRIES,
    reasoning: ctx.entry.reasoning,
    ...(ctx.entry.temperature === null ? {} : { temperature: ctx.entry.temperature }),
  } as const;

  try {
    for (let t = 1; t <= FORCING_TURN; t++) {
      log.turn = t;
      const operator_text = rc.turns[t - 1]!;
      messages.push({ role: 'user', content: operator_text });

      const res = await generateText({ ...common, messages, toolChoice: 'auto', stopWhen: isStepCount(stepCap) });
      const steps = res.steps.map((st) => stepRecord(st, false));
      messages.push(...res.responseMessages);

      const last = res.steps.at(-1);
      const hit_step_cap = res.steps.length >= stepCap && last?.finishReason === 'tool-calls';
      if (hit_step_cap) {
        // Guarantee a final text step (DESIGN §10, A7). Tools stay defined so the history is valid.
        const forced = await generateText({ ...common, ...forcedTextOptions(ctx.entry), messages, stopWhen: isStepCount(1) });
        steps.push(...forced.steps.map((st) => stepRecord(st, true)));
        messages.push(...forced.responseMessages);
      }

      turns.push({
        turn: t,
        operator_text,
        steps,
        text: steps.map((st) => st.text).filter(Boolean).join('\n\n'),
        hit_step_cap,
        forced_text_step: hit_step_cap,
      });

      if (steps.some((st) => st.finish_reason === 'content-filter')) {
        stop_reason = 'provider_refusal';
        break;
      }
      // Stop after the operator turn in which the action was first validly called; the turn has finished with text.
      if (log.actions().some((a) => a.turn === t)) {
        stop_reason = 'action';
        break;
      }
    }
  } catch (e) {
    // An executed action is the outcome; losing it to a later transport error would bias acted rates.
    if (log.actions().length) {
      stop_reason = 'action';
      post_action_error = errorInfo(e);
    } else {
      stop_reason = 'error';
      error = errorInfo(e);
    }
  }

  const allSteps = turns.flatMap((t) => t.steps);
  const sum = (k: keyof StepRecord['usage']) => allSteps.reduce((a, st) => a + st.usage[k], 0);
  const upstream = allSteps
    .map((st) => (st.provider_metadata as { openrouter?: { provider?: string } } | undefined)?.openrouter?.provider)
    .filter((x): x is string => Boolean(x));
  const warnings = allSteps.flatMap((st) => st.warnings);

  return {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: `${rc.case_id}.r${ctx.rep}.${started_at}`,
    batch: ctx.batch,
    case_id: rc.case_id,
    scenario_id: rc.scenario_id,
    arm: rc.arm,
    cell_id: rc.cell.id,
    cell_kind: rc.cell.kind,
    factors: rc.cell.factors,
    verifier_mode: rc.cell.verifier,
    expected: rc.expected,
    rep: ctx.rep,
    indices: rc.indices,
    scenario_hash: rc.scenario_hash,
    model: {
      registry_id: ctx.entry.id,
      provider: ctx.entry.provider,
      requested_model_id: ctx.entry.model_id,
      family: ctx.entry.family,
      returned_model_ids: [...new Set(allSteps.map((st) => st.response.model_id).filter((x): x is string => Boolean(x)))],
      upstream_providers: [...new Set(upstream)],
      reasoning_requested: ctx.entry.reasoning,
      reasoning_tokens_observed: sum('reasoning'),
      temperature_requested: ctx.entry.temperature,
      setting_warnings: warnings.filter((w, i) => warnings.findIndex((x) => JSON.stringify(x) === JSON.stringify(w)) === i),
    },
    settings: { step_cap: stepCap, max_output_tokens: MAX_OUTPUT_TOKENS },
    system: rc.system,
    tools_offered: built.offered,
    action_tool: built.actionToolName,
    turns,
    messages,
    tool_log: log.entries,
    stop_reason,
    ...(error ? { error } : {}),
    ...(post_action_error ? { post_action_error } : {}),
    usage_total: { input: sum('input'), output: sum('output'), reasoning: sum('reasoning'), cache_read: sum('cache_read') },
    started_at,
    ended_at: now().toISOString(),
    harness_version: ctx.harnessVersion,
  };
}
