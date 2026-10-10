import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { bareName, mcpTools, turnError, turnFromMessages } from '../harness-arm/run.ts';
import { cellsFor, renderCase } from '../src/scenario.ts';
import { ToolLog } from '../src/tools.ts';
import { probes, real } from './helpers.ts';

const email = real('email-mark-verified');
const rc = (cellId: string) => renderCase(email, cellsFor(email.scenario, probes).find((c) => c.id === cellId)!, 0);

const assistant = (content: unknown[], stop_reason = 'tool_use'): SDKMessage =>
  ({ type: 'assistant', message: { id: 'm', model: 'claude-haiku-5-5', content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } } }) as unknown as SDKMessage;
const toolResult = (id: string, content: unknown, is_error = false): SDKMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } }) as unknown as SDKMessage;
const result = (extra: Record<string, unknown> = {}): SDKMessage => ({ type: 'result', subtype: 'success', stop_reason: 'end_turn', ...extra }) as unknown as SDKMessage;

describe('harness arm: message folding', () => {
  test('assistant messages become steps; MCP names are stripped; results attach', () => {
    const t = turnFromMessages(1, 'op', [
      assistant([{ type: 'tool_use', id: 'u1', name: 'mcp__tmw__check_email_verification', input: { batch_id: 'B-2291' } }]),
      toolResult('u1', [{ type: 'text', text: '{"status":503}' }]),
      assistant([{ type: 'text', text: "I can't verify this." }], 'end_turn'),
      result(),
    ]);
    expect(t.steps).toHaveLength(2);
    expect(t.steps[0]!.tool_calls[0]!.name).toBe('check_email_verification');
    expect(t.steps[0]!.tool_results).toHaveLength(1);
    expect(t.text).toBe("I can't verify this.");
    expect(t.hit_step_cap).toBe(false);
  });

  test('error tool results are tool errors; refusal and max-turns are mapped', () => {
    const t = turnFromMessages(2, 'op', [
      assistant([{ type: 'tool_use', id: 'u2', name: 'mcp__tmw__mark_emails_verified', input: {} }]),
      toolResult('u2', 'invalid input', true),
      result({ subtype: 'error_max_turns', stop_reason: 'refusal' }),
    ]);
    expect(t.steps[0]!.tool_errors[0]!.name).toBe('mark_emails_verified');
    expect(t.steps[0]!.tool_calls[0]!.invalid).toBe(true);
    expect(t.steps[0]!.finish_reason).toBe('content-filter');
    expect(t.hit_step_cap).toBe(true);
  });

  test('per-block assistant messages of one response merge into one step; usage counted once', () => {
    const t = turnFromMessages(1, 'op', [
      assistant([{ type: 'thinking', thinking: 'hmm' }], null as unknown as string),
      assistant([{ type: 'text', text: 'Marking now.' }], null as unknown as string),
      assistant([{ type: 'tool_use', id: 'u1', name: 'mcp__tmw__mark_emails_verified', input: {} }]),
      result(),
    ]);
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0]!.finish_reason).toBe('tool-calls');
    expect(t.steps[0]!.reasoning_text).toBe('hmm');
    expect(t.steps[0]!.usage.input).toBe(10);
  });

  test('a refusal with no content still yields a content-filter step', () => {
    const t = turnFromMessages(1, 'op', [result({ stop_reason: 'refusal' })]);
    expect(t.steps.map((s) => s.finish_reason)).toEqual(['content-filter']);
  });

  test('API errors and failed results are turn errors; max-turns is not', () => {
    expect(turnError([result()])).toBeUndefined();
    expect(turnError([result({ subtype: 'error_max_turns', is_error: true })])).toBeUndefined();
    expect(turnError([result({ is_error: true, result: 'API Error: 529' })])).toContain('is_error');
    expect(turnError([result({ subtype: 'error_during_execution', errors: ['boom'] })])).toContain('boom');
    expect(turnError([{ ...assistant([{ type: 'text', text: 'API Error' }]), error: 'overloaded' } as SDKMessage, result()])).toContain('overloaded');
  });

  test('bareName', () => {
    expect(bareName('mcp__tmw__x')).toBe('x');
    expect(bareName('x')).toBe('x');
  });
});

describe('harness arm: MCP tools mirror the raw-API mocks', () => {
  type Def = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }> };
  const build = (cellId: string, log = new ToolLog()) => {
    const b = mcpTools(email.scenario, rc(cellId), log);
    const def = (n: string) => (b.defs as unknown as Def[]).find((d) => d.name === n)!;
    return { ...b, def, log };
  };

  test('offered tools follow the cell (audit present / generic run_sql)', () => {
    expect(build('core.s1a0').offered).toEqual(['check_email_verification', 'mark_emails_verified']);
    expect(build('core.s1a1').offered).toContain('log_override');
    const g = build('probe.tool-generic');
    expect(g.offered).toEqual(['check_email_verification', 'run_sql']);
    expect(g.actionTool).toBe('run_sql');
  });

  test('handlers return the cell payload and record into the tool log at the current turn', async () => {
    const b = build('core.s1a0');
    b.log.turn = 3;
    const v = await b.def('check_email_verification').handler({ batch_id: 'B-2291' }, {});
    expect(JSON.parse(v.content[0]!.text)).toEqual(email.scenario.tools.verifier.modes.down);
    await b.def('mark_emails_verified').handler({ batch_id: 'B-2291' }, {});
    expect(b.log.entries.map((e) => [e.kind, e.turn])).toEqual([
      ['verifier', 3],
      ['action', 3],
    ]);
    expect(b.log.actions()).toHaveLength(1);
  });

  test('run_sql classification matches the raw-API mock', async () => {
    const b = build('probe.tool-generic');
    await b.def('run_sql').handler({ query: "UPDATE prospects SET verified = true WHERE batch_id = 'B-2291'" }, {});
    expect(b.log.entries[0]!.sql_class).toBe('action');
    expect(b.log.actions()).toHaveLength(1);
  });
});
