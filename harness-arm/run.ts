#!/usr/bin/env bun
// Harness arm (DESIGN §6, PLAN M9): the same email-mark-verified cases run inside the Claude Agent SDK
// (Claude Code's system prompt and agent loop) instead of the raw API, with the same mocked tools exposed
// as in-process MCP tools. Writes the same RunRecord JSONL, so classify/judge/report work unchanged.
// The origin observation was inside Claude Code; if the raw API acts but this arm refuses, the refusal
// lives in the harness (DESIGN §8 null-result plan).
//
//   bun run harness-arm/run.ts --model claude-haiku-5-5 --n 12 --batch 2026-10-12
//
// Requires ANTHROPIC_API_KEY. Built-in Claude Code tools are removed so the toolset stays closed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Command } from 'commander';
import pLimit from 'p-limit';
import type { z } from 'zod';
import type { Scenario } from '../scenarios/schema.ts';
import { assertKeys, getModel, type ModelEntry } from '../src/models.ts';
import { checkBatchName, DEFAULT_CONCURRENCY, harnessVersion } from '../src/run.ts';
import { RUN_SCHEMA_VERSION, STEP_CAP, type RunRecord, type StepRecord, type TurnRecord } from '../src/runner.ts';
import { allocate, expand, FORCING_TURN, loadProbes, loadScenarios, type RenderedCase } from '../src/scenario.ts';
import { appendJsonl, caseFile, completedReps } from '../src/store.ts';
import { buildTools, ToolLog } from '../src/tools.ts';
import { validateAll } from '../src/validate.ts';

export const SERVER = 'tmw';
export const HARNESS_SCENARIO = 'email-mark-verified';
const PREFIX = `mcp__${SERVER}__`;
export const bareName = (n: string) => (n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n);
type McpTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];
const callId = (extra: unknown) => String((extra as { toolUseId?: string } | undefined)?.toolUseId ?? '');

/**
 * The cell's mocked tools as in-process MCP tools. They wrap src/tools.ts `buildTools` (same schemas, payloads
 * and tool-log records), so the two arms cannot drift apart.
 */
export function mcpTools(s: Scenario, rc: RenderedCase, log: ToolLog) {
  const built = buildTools(s, rc, log);
  const defs: McpTool[] = Object.entries(built.tools).map(([name, t]) => {
    const shape = (t.inputSchema as z.ZodObject).shape;
    const def = tool(name, typeof t.description === 'string' ? t.description : '', shape, async (args, extra) => {
      const output = await t.execute!(args, { toolCallId: callId(extra), messages: [], context: undefined });
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
    });
    // Tool definitions are generic in their schema; collect them through one erased type.
    return def as unknown as McpTool;
  });
  return {
    server: createSdkMcpServer({ name: SERVER, version: '1.0.0', tools: defs, alwaysLoad: true }),
    offered: built.offered,
    actionTool: built.actionToolName,
    defs,
  };
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
type ResultMsg = Extract<SDKMessage, { type: 'result' }>;

function emptyStep(): StepRecord {
  return {
    finish_reason: 'stop',
    raw_finish_reason: undefined,
    text: '',
    reasoning_text: undefined,
    tool_calls: [],
    tool_results: [],
    tool_errors: [],
    usage: { input: 0, output: 0, reasoning: 0, cache_read: 0 },
    warnings: [],
    response: { id: undefined, model_id: undefined, timestamp: undefined },
    provider_metadata: undefined,
    forced_text: false,
  };
}

/**
 * Fold the SDK message stream of one operator turn into a TurnRecord. One model response is one step: the
 * CLI streams a response as one assistant message per content block (same message.id), so consecutive
 * messages with the same id are merged, and their usage is taken once (from the latest of them).
 * Tool results (in SDK user messages) are attached to the step that made the call.
 */
export function turnFromMessages(turn: number, operator_text: string, msgs: SDKMessage[]): TurnRecord {
  const steps: StepRecord[] = [];
  let result: ResultMsg | undefined;
  let prevAssistant = false;
  for (const m of msgs) {
    const isAssistant = m.type === 'assistant';
    const continues = prevAssistant;
    if (m.type !== 'system' && m.type !== 'stream_event') prevAssistant = isAssistant;
    if (m.type === 'assistant') {
      const msg = m.message as { id?: string; model?: string; stop_reason?: string | null; content?: unknown; usage?: Usage };
      const content = (msg.content ?? []) as Block[];
      const prev = steps.at(-1);
      const step = continues && prev && msg.id && prev.response.id === msg.id ? prev : (steps.push(emptyStep()), steps.at(-1)!);
      step.response = { id: msg.id, model_id: msg.model, timestamp: undefined };
      step.raw_finish_reason = msg.stop_reason ?? step.raw_finish_reason;
      step.text += content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('');
      if (thinking) step.reasoning_text = (step.reasoning_text ?? '') + thinking;
      step.tool_calls.push(...content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: bareName(b.name!), input: b.input, invalid: false })));
      step.finish_reason = step.tool_calls.length ? 'tool-calls' : 'stop';
      const u = msg.usage;
      if (u) step.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0, cache_read: u.cache_read_input_tokens ?? 0 };
    } else if (m.type === 'user' && steps.length) {
      const content = (m.message as { content?: unknown }).content;
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type !== 'tool_result') continue;
        const call = steps.flatMap((s) => s.tool_calls).find((c) => c.id === b.tool_use_id);
        const target = steps.at(-1)!;
        if (b.is_error) {
          if (call) call.invalid = true;
          target.tool_errors.push({ id: b.tool_use_id ?? '', name: call?.name ?? '', input: call?.input, error: JSON.stringify(b.content).slice(0, 500) });
        } else target.tool_results.push({ id: b.tool_use_id ?? '', name: call?.name ?? '', output: b.content });
      }
    } else if (m.type === 'result') result = m;
  }
  if (result && (result as { stop_reason?: string | null }).stop_reason === 'refusal') {
    // A refusal with no streamed content still has to reach the classifier as PROVIDER_REFUSAL.
    if (!steps.length) steps.push(emptyStep());
    steps.at(-1)!.finish_reason = 'content-filter';
    steps.at(-1)!.raw_finish_reason = 'refusal';
  }
  return {
    turn,
    operator_text,
    steps,
    text: steps.map((s) => s.text).filter(Boolean).join('\n\n'),
    hit_step_cap: result?.subtype === 'error_max_turns',
    forced_text_step: false,
  };
}

/**
 * Why a turn failed for transport reasons (API error, startup failure, aborted execution), or undefined.
 * Such a turn must become an error run (retried on resume), never a no-action outcome.
 */
export function turnError(msgs: SDKMessage[]): string | undefined {
  for (const m of msgs) {
    const e = m.type === 'assistant' ? (m as { error?: string }).error : undefined;
    if (e && e !== 'max_output_tokens') return `assistant error: ${e}`;
  }
  const r = msgs.find((m): m is ResultMsg => m.type === 'result');
  if (!r || r.subtype === 'error_max_turns') return undefined;
  if (r.subtype !== 'success') return `${r.subtype}: ${(r as { errors?: string[] }).errors?.join('; ') ?? ''}`;
  if (r.is_error) return `result is_error: ${String((r as { result?: string }).result ?? '')}`;
  return undefined;
}

const userMsg = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) as SDKUserMessage;

export async function runHarnessCase(s: Scenario, rc: RenderedCase, entry: ModelEntry, batch: string, rep: number, version: string): Promise<RunRecord> {
  const started_at = new Date().toISOString();
  const log = new ToolLog();
  const { server, offered, actionTool } = mcpTools(s, rc, log);
  const turns: TurnRecord[] = [];
  const all: SDKMessage[] = [];
  let stop_reason: RunRecord['stop_reason'] = 'forcing_done';
  let error: RunRecord['error'];
  let post_action_error: RunRecord['post_action_error'];
  let init: Record<string, unknown> = {};
  const cwd = mkdtempSync(join(tmpdir(), 'tmw-harness-'));

  // Gate: each operator message is released only after the previous turn's result arrives.
  const gates: (() => void)[] = [];
  const opened = rc.turns.map(() => new Promise<void>((r) => gates.push(r)));
  let stopAfter = Number.POSITIVE_INFINITY;
  async function* prompts(): AsyncGenerator<SDKUserMessage> {
    for (let i = 0; i < rc.turns.length; i++) {
      if (i > 0) await opened[i - 1];
      if (i >= stopAfter) return;
      log.turn = i + 1;
      yield userMsg(rc.turns[i]!);
    }
  }

  try {
    const q = query({
      prompt: prompts(),
      options: {
        model: entry.model_id,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: rc.system },
        tools: [],
        mcpServers: { [SERVER]: server },
        allowedTools: [`${PREFIX}*`],
        permissionMode: 'dontAsk',
        // Per SDK docs, in streaming-input mode maxTurns applies per queued user message (confirm in the first live smoke).
        maxTurns: STEP_CAP,
        settingSources: [],
        persistSession: false,
        cwd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
    });
    let turnMsgs: SDKMessage[] = [];
    let t = 0;
    let finished = false;
    for await (const m of q) {
      all.push(m);
      if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') init = m as unknown as Record<string, unknown>;
      turnMsgs.push(m);
      if (m.type !== 'result') continue;
      const tr = turnFromMessages(t + 1, rc.turns[t]!, turnMsgs);
      turns.push(tr);
      const failed = turnError(turnMsgs);
      turnMsgs = [];
      const acted = log.actions().some((a) => a.turn === t + 1);
      const refused = tr.steps.some((st) => st.finish_reason === 'content-filter');
      t++;
      if (failed && !acted && !refused) throw new Error(`turn ${t}: ${failed}`);
      if (acted || refused || t >= FORCING_TURN) {
        stop_reason = acted ? 'action' : refused ? 'provider_refusal' : 'forcing_done';
        finished = true;
        break;
      }
      gates[t - 1]?.();
    }
    if (!finished) throw new Error(`agent stream ended after ${t} of ${FORCING_TURN} turns`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const info = { name: err.name, message: err.message.slice(0, 2000) };
    // An executed action is the outcome; losing it to a later transport error would bias acted rates.
    if (log.actions().length) {
      stop_reason = 'action';
      post_action_error = info;
    } else {
      stop_reason = 'error';
      error = info;
    }
  } finally {
    // Release the prompt generator so it returns instead of waiting on a gate forever.
    stopAfter = 0;
    for (const g of gates) g();
    rmSync(cwd, { recursive: true, force: true });
  }

  const steps = turns.flatMap((t) => t.steps);
  const sum = (k: keyof StepRecord['usage']) => steps.reduce((a, st) => a + st.usage[k], 0);
  const thinkingSteps = steps.filter((st) => st.reasoning_text).length;
  return {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: `${rc.case_id}.r${rep}.${started_at}`,
    batch,
    case_id: rc.case_id,
    scenario_id: rc.scenario_id,
    arm: rc.arm,
    cell_id: rc.cell.id,
    cell_kind: rc.cell.kind,
    factors: rc.cell.factors,
    verifier_mode: rc.cell.verifier,
    expected: rc.expected,
    rep,
    indices: rc.indices,
    scenario_hash: rc.scenario_hash,
    model: {
      registry_id: `harness-${entry.id}`,
      provider: 'claude-agent-sdk',
      requested_model_id: entry.model_id,
      family: entry.family,
      returned_model_ids: [...new Set(steps.map((st) => st.response.model_id).filter((x): x is string => Boolean(x)))],
      upstream_providers: [],
      // The SDK does not break thinking tokens out of output tokens; record the thinking evidence here instead.
      reasoning_requested: `claude-code default; effort not reported by the SDK (${String(init.effort ?? 'unreported')}); steps with thinking: ${thinkingSteps}`,
      reasoning_tokens_observed: sum('reasoning'),
      temperature_requested: null,
      setting_warnings: [],
    },
    settings: { step_cap: STEP_CAP, max_output_tokens: 0 },
    system: `[claude_code preset] + ${rc.system}`,
    tools_offered: offered,
    action_tool: actionTool,
    turns,
    messages: all as unknown as RunRecord['messages'],
    tool_log: log.entries,
    stop_reason,
    ...(error ? { error } : {}),
    ...(post_action_error ? { post_action_error } : {}),
    usage_total: { input: sum('input'), output: sum('output'), reasoning: 0, cache_read: sum('cache_read') },
    started_at,
    ended_at: new Date().toISOString(),
    harness_version: version,
  };
}

if (import.meta.main) {
  const program = new Command()
    .name('harness-arm')
    .requiredOption('--model <id>', 'Anthropic registry id, e.g. claude-haiku-5-5')
    .requiredOption('--batch <name>', 'results/<batch>/ (written under harness-<model>/)')
    .option('--n <n>', 'runs per cell', (v) => Number(v), 12)
    .option('--cells <ids>', 'cell ids or prefixes', (v) => v.split(','), ['core', 'cap'])
    .option('--concurrency <n>', 'cases run in parallel', (v) => Number(v), DEFAULT_CONCURRENCY.anthropic)
    .parse();
  const o = program.opts<{ model: string; batch: string; n: number; cells: string[]; concurrency: number }>();
  const entry = getModel(o.model);
  if (entry.provider !== 'anthropic') throw new Error('the harness arm runs Anthropic models only');
  checkBatchName(o.batch, [entry]);
  const { scenarios, errors } = loadScenarios();
  const probes = loadProbes();
  const v = validateAll(scenarios, errors, probes);
  if (v.errors.length) throw new Error(`scenarios fail validate (${v.errors.length} errors); run \`validate\``);
  assertKeys([entry]);
  const { sets, reps } = allocate(o.n);
  const cases = expand(scenarios, probes, { scenarios: [HARNESS_SCENARIO], cells: o.cells, sets });
  const s = scenarios.find((x) => x.scenario.id === HARNESS_SCENARIO)!.scenario;
  const version = harnessVersion();
  const limit = pLimit(o.concurrency);
  // Reps of one case run sequentially so appends to its file never interleave; cases run in parallel.
  await Promise.all(
    cases.map((rc) =>
      limit(async () => {
        const path = caseFile(o.batch, `harness-${entry.id}`, rc.case_id);
        const done = completedReps(path, rc.scenario_hash);
        for (let rep = 0; rep < reps; rep++) {
          if (done.has(rep)) continue;
          const rec = await runHarnessCase(s, rc, entry, o.batch, rep, version);
          appendJsonl(path, rec);
          console.log(`harness-${entry.id} ${rc.case_id} r${rep}: ${rec.stop_reason}${rec.error ? ` ${rec.error.message.slice(0, 160)}` : ''}`);
        }
      }),
    ),
  );
}
