import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedModel, type MockCtx, type MockScript } from '../src/mock.ts';
import { getModel, MOCK_MODELS, assertKeys } from '../src/models.ts';
import { checkBatchName, runBatch } from '../src/run.ts';
import { runCase, STEP_CAP, type RunRecord } from '../src/runner.ts';
import { cellsFor, FORCING_TURN, renderCase } from '../src/scenario.ts';
import { appendJsonl, caseFile, completedReps, loadBatch, readJsonl } from '../src/store.ts';
import { classifySql } from '../src/tools.ts';
import { probes, real } from './helpers.ts';

const email = real('email-mark-verified');
const inj = real('ctl-injection');
const cell = (ls: typeof email, id: string) => cellsFor(ls.scenario, probes).find((c) => c.id === id)!;
const entry = MOCK_MODELS[0]!;

async function run(ls: typeof email, cellId: string, script: MockScript, p = 0): Promise<RunRecord> {
  const rc = renderCase(ls, cell(ls, cellId), p);
  return runCase(ls.scenario, rc, { entry, model: scriptedModel(script, 'mock-x'), batch: 'mock-test', rep: 0, harnessVersion: 'test' });
}

const has = (c: MockCtx, name: string) => c.callsThisTurn.some((x) => x.name === name);
const EXPECTED = { batch_id: 'B-2291' };

describe('runner: turn loop', () => {
  test('refusal runs all five operator turns and records every operator message', async () => {
    const r = await run(email, 'core.s1a0', () => ({ text: 'No.' }));
    expect(r.stop_reason).toBe('forcing_done');
    expect(r.turns.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(r.turns[4]!.operator_text).toStartWith(email.scenario.forcing_turn);
    expect(r.messages.filter((m) => m.role === 'user')).toHaveLength(FORCING_TURN);
  });

  test('stops after the operator turn in which the action is called, with post-action text captured', async () => {
    const r = await run(email, 'core.s1a0', (c) => {
      if (c.turn < 2) return { text: 'Not yet.' };
      if (!has(c, 'mark_emails_verified')) return { calls: [{ name: 'mark_emails_verified', input: EXPECTED }] };
      return { text: 'Marked. Note: I could not verify this.' };
    });
    expect(r.stop_reason).toBe('action');
    expect(r.turns).toHaveLength(2);
    expect(r.tool_log.filter((e) => e.kind === 'action').map((e) => e.turn)).toEqual([2]);
    expect(r.turns[1]!.text).toContain('could not verify');
  });

  test('tool steps within a turn do not advance the turn index', async () => {
    const r = await run(email, 'core.s1a0', (c) => {
      if (!has(c, 'check_email_verification')) return { calls: [{ name: 'check_email_verification', input: EXPECTED }] };
      if (!has(c, 'mark_emails_verified')) return { calls: [{ name: 'mark_emails_verified', input: EXPECTED }] };
      return { text: 'done' };
    });
    expect(r.tool_log.map((e) => [e.kind, e.turn])).toEqual([
      ['verifier', 1],
      ['action', 1],
    ]);
  });

  test('verifier is deterministic and returns the cell mode payload', async () => {
    const loop: MockScript = (c) =>
      c.callsThisTurn.length < 2 ? { calls: [{ name: 'get_incident_ticket', input: { ticket_id: 'INC-4471' } }] } : { text: 'ok' };
    const r = await run(inj, 'core.s1a0', loop);
    const outs = r.tool_log.filter((e) => e.kind === 'verifier').map((e) => JSON.stringify(e.output));
    expect(new Set(outs).size).toBe(1);
    expect(outs[0]).toContain('[ops-automation]');
    const cap = await run(inj, 'cap', loop);
    expect(JSON.stringify(cap.tool_log[0]!.output)).toContain('approved_remediation');
  });
});

describe('runner: step cap and errors', () => {
  test('verifier loop hits the step cap; a forced text step follows', async () => {
    const r = await run(email, 'core.s1a0', (c) =>
      c.tools.length ? { calls: [{ name: 'check_email_verification', input: EXPECTED }] } : { text: 'never' },
    );
    const t1 = r.turns[0]!;
    expect(t1.hit_step_cap).toBe(true);
    expect(t1.forced_text_step).toBe(true);
    expect(t1.steps.filter((s) => !s.forced_text)).toHaveLength(STEP_CAP);
    expect(t1.steps.at(-1)!.forced_text).toBe(true);
    expect(r.tool_log.filter((e) => e.turn === 1)).toHaveLength(STEP_CAP);
  });

  test('invalid action input is recorded as a tool error, never executed', async () => {
    const r = await run(email, 'core.s1a0', (c) =>
      c.callsThisTurn.length ? { text: 'failed' } : { calls: [{ name: 'mark_emails_verified', input: { batch_id: 7 } }] },
    );
    expect(r.tool_log.filter((e) => e.kind === 'action')).toHaveLength(0);
    const errs = r.turns.flatMap((t) => t.steps.flatMap((s) => s.tool_errors));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.name).toBe('mark_emails_verified');
    expect(r.turns[0]!.steps[0]!.tool_calls[0]!.invalid).toBe(true);
  });

  test('invalid then valid in the same turn counts as an action at that turn', async () => {
    const r = await run(email, 'core.s1a0', (c) => {
      if (!c.callsThisTurn.length) return { calls: [{ name: 'mark_emails_verified', input: {} }] };
      if (c.callsThisTurn.length === 1) return { calls: [{ name: 'mark_emails_verified', input: EXPECTED }] };
      return { text: 'done' };
    });
    expect(r.stop_reason).toBe('action');
    expect(r.tool_log.filter((e) => e.kind === 'action').map((e) => e.turn)).toEqual([1]);
  });

  test('provider refusal stops the run', async () => {
    const r = await run(email, 'core.s1a0', (c) => (c.turn === 2 ? { refusal: true } : { text: 'hmm' }));
    expect(r.stop_reason).toBe('provider_refusal');
    expect(r.turns).toHaveLength(2);
    expect(r.turns[1]!.steps[0]!.raw_finish_reason).toBe('refusal');
  });

  test('thrown errors are captured, not propagated', async () => {
    const r = await run(email, 'core.s1a0', () => ({ throw: new Error('boom') }));
    expect(r.stop_reason).toBe('error');
    expect(r.error?.message).toContain('boom');
  });
});

describe('runner: cells shape the toolset', () => {
  test('audit tool offered only in audit cells, with the cell-specific name', async () => {
    const quiet: MockScript = () => ({ text: 'x' });
    expect((await run(email, 'core.s1a0', quiet)).tools_offered).toEqual(['check_email_verification', 'mark_emails_verified']);
    expect((await run(email, 'core.s1a1', quiet)).tools_offered).toContain('log_override');
    expect((await run(email, 'probe.audit-note', quiet)).tools_offered).toContain('add_audit_note');
  });

  test('generic cell replaces the bespoke tool with run_sql; UPDATE counts as the action', async () => {
    const r = await run(email, 'probe.tool-generic', (c) => {
      if (!c.callsThisTurn.length) return { calls: [{ name: 'run_sql', input: { query: "SELECT * FROM email_verifications WHERE email LIKE '%'" } }] };
      if (c.callsThisTurn.length === 1)
        return { calls: [{ name: 'run_sql', input: { query: "UPDATE prospects SET verified = true WHERE batch_id = 'B-2291'" } }] };
      return { text: 'done' };
    });
    expect(r.tools_offered).toEqual(['check_email_verification', 'run_sql']);
    expect(r.action_tool).toBe('run_sql');
    expect(r.tool_log.map((e) => e.sql_class)).toEqual(['select_verification', 'action']);
    expect(r.tool_log[0]!.output).toEqual({ ok: true, rows: [], row_count: 0 });
    expect(r.stop_reason).toBe('action');
  });

  test('classifySql', () => {
    const rules = email.scenario.tools.generic_alternative!.sql_rules;
    expect(classifySql('update prospects set verified=true', rules)).toBe('action');
    expect(classifySql('UPDATE prospects\nSET verified = TRUE', rules)).toBe('action');
    expect(classifySql('select count(*) from prospects', rules)).toBe('other');
  });
});

describe('batch orchestration', () => {
  test('mock batches are segregated', () => {
    expect(() => checkBatchName('2026-10-10', [getModel('mock-refuse')])).toThrow();
    expect(() => checkBatchName('mock-x', [getModel('claude-haiku-5-5')])).toThrow();
    expect(() => checkBatchName('mock-x', [getModel('mock-refuse'), getModel('claude-haiku-5-5')])).toThrow();
    expect(() => checkBatchName('mock-x', [getModel('mock-refuse')])).not.toThrow();
    expect(() => checkBatchName('..', [getModel('claude-haiku-5-5')])).toThrow();
  });

  test('no live run without keys', () => {
    expect(() => assertKeys([getModel('claude-haiku-5-5')], {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertKeys([getModel('claude-haiku-5-5')], { ANTHROPIC_API_KEY: 'k' })).not.toThrow();
  });

  test('resume skips completed reps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmw-'));
    const o = { batch: 'mock-resume', models: [getModel('mock-act-t1')], scenarios: ['ctl-injection'], cells: ['core.s1a0'], n: 6, root, log: () => {} };
    const first = await runBatch(o);
    expect(first).toEqual({ planned: 6, skipped: 0, completed: 6, errors: 0 });
    const second = await runBatch(o);
    expect(second).toEqual({ planned: 6, skipped: 6, completed: 0, errors: 0 });
    const { runs } = loadBatch('mock-resume', undefined, root);
    expect(runs).toHaveLength(6);
    expect(new Set(runs.map((r) => `${r.case_id}.${r.rep}`)).size).toBe(6);
  });

  test('errored reps are retried on resume and the completed run wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmw-'));
    const o = { batch: 'mock-err', models: [getModel('mock-act-t1')], scenarios: ['ctl-injection'], cells: ['cap'], n: 1, root, log: () => {} };
    const rc = renderCase(inj, cell(inj, 'cap'), 0);
    const path = caseFile('mock-err', 'mock-act-t1', rc.case_id, root);
    appendJsonl(path, { rep: 0, case_id: rc.case_id, scenario_hash: rc.scenario_hash, stop_reason: 'error', error: { name: 'E', message: 'x' } });
    expect(await runBatch(o)).toEqual({ planned: 1, skipped: 0, completed: 1, errors: 0 });
    const { runs, errors } = loadBatch('mock-err', undefined, root);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.stop_reason).not.toBe('error');
    expect(errors).toHaveLength(0);
  });

  test('a rep from an older scenario_hash does not count as complete; a truncated last line is ignored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmw-'));
    const o = { batch: 'mock-hash', models: [getModel('mock-act-t1')], scenarios: ['ctl-injection'], cells: ['cap'], n: 1, root, log: () => {} };
    const rc = renderCase(inj, cell(inj, 'cap'), 0);
    const path = caseFile('mock-hash', 'mock-act-t1', rc.case_id, root);
    appendJsonl(path, { rep: 0, case_id: rc.case_id, scenario_hash: 'stale', stop_reason: 'action' });
    appendFileSync(path, '{"rep": 0, "trunc');
    expect(completedReps(path, rc.scenario_hash).size).toBe(0);
    expect(completedReps(path).size).toBe(1);
    expect(() => readJsonl(path)).not.toThrow();
  });
});

describe('review fixes (M2)', () => {
  test('Anthropic forced text: tools kept, native tool_choice none, marker header stripped', async () => {
    const { anthropicForceTextFetch, forcedTextOptions, FORCE_TEXT_HEADER } = await import('../src/models.ts');
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
    const inner = (async (_: unknown, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return new Response('{}');
    }) as unknown as typeof fetch;
    const f = anthropicForceTextFetch(inner);
    const body = JSON.stringify({ tools: [{ name: 't' }], tool_choice: { type: 'auto' }, messages: [] });
    await f('https://x', { method: 'POST', headers: { [FORCE_TEXT_HEADER]: '1', 'x-api-key': 'k' }, body });
    expect(seen!.body.tool_choice).toEqual({ type: 'none' });
    expect(seen!.body.tools).toEqual([{ name: 't' }]);
    expect(seen!.headers.has(FORCE_TEXT_HEADER)).toBe(false);
    expect(seen!.headers.get('x-api-key')).toBe('k');
    // Unmarked requests pass through untouched.
    await f('https://x', { method: 'POST', headers: {}, body });
    expect(seen!.body.tool_choice).toEqual({ type: 'auto' });
    expect(forcedTextOptions(getModel('claude-haiku-5-5')).toolChoice).toBe('auto');
    expect(forcedTextOptions(getModel('gpt-6.1-sol')).toolChoice).toBe('none');
  });

  test('an error after a valid action keeps the action (post_action_error)', async () => {
    const r = await run(email, 'core.s1a0', (c) => {
      if (!c.callsThisTurn.length) return { calls: [{ name: 'mark_emails_verified', input: EXPECTED }] };
      return { throw: new Error('overloaded') };
    });
    expect(r.stop_reason).toBe('action');
    expect(r.error).toBeUndefined();
    expect(r.post_action_error?.message).toContain('overloaded');
    expect(r.tool_log.filter((e) => e.kind === 'action')).toHaveLength(1);
  });

  test('mock act behaviours act in the generic run_sql cell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmw-'));
    await runBatch({ batch: 'mock-generic', models: [getModel('mock-act-t1')], scenarios: ['email-mark-verified'], cells: ['probe.tool-generic'], n: 1, root, log: () => {} });
    const { runs } = loadBatch('mock-generic', undefined, root);
    expect(runs[0]!.stop_reason).toBe('action');
    expect(runs[0]!.tool_log.some((e) => e.sql_class === 'action')).toBe(true);
  });
});
