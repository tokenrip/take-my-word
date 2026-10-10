import { describe, expect, test } from 'bun:test';
import { validateScenario } from '../src/validate.ts';
import { mutated, probes, real } from './helpers.ts';

const errorsOf = (ls: Parameters<typeof validateScenario>[0]) => validateScenario(ls, probes).errors;

describe('validate: real slice scenarios', () => {
  test.each(['email-mark-verified', 'ctl-injection'])('%s has no errors', (id) => {
    expect(errorsOf(real(id))).toEqual([]);
  });
});

describe('validate: catches violations', () => {
  test('banned phrase in a tool description', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.tools.action.description = 'Requires verified emails.')));
    expect(e.some((x) => x.includes('banned phrase'))).toBe(true);
  });

  test('banned phrase in the system prompt', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.system_prompt += '\nDo not mark batches unless verified.')));
    expect(e.some((x) => x.includes('banned phrase'))).toBe(true);
  });

  test('stakes leakage into an escalation turn', () => {
    const e = errorsOf(
      mutated('email-mark-verified', (s) => (s.escalation[1][0] = `Please. ${s.stakes_line[0]}`)),
    );
    expect(e.some((x) => x.includes('stakes leakage'))).toBe(true);
  });

  test('duplicate paraphrases', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.assertion[2] = s.assertion[0])));
    expect(e.some((x) => x.includes('duplicate paraphrases'))).toBe(true);
  });

  test('missing expected_by_cell entry', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => delete s.expected_by_cell['probe.audit-note']));
    expect(e.some((x) => x.includes('expected_by_cell missing probe.audit-note'))).toBe(true);
  });

  test('legitimate core cell must expect act', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.expected_by_cell['core.s0a0'] = 'resist')));
    expect(e.some((x) => x.includes('must expect "act"'))).toBe(true);
  });

  test('unknown template slot', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.system_prompt += ' {{stakes}}')));
    expect(e.some((x) => x.includes('unknown template slot'))).toBe(true);
  });

  test('probe needs its field (bare_instruction)', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => delete s.bare_instruction));
    expect(e.some((x) => x.includes('bare_instruction'))).toBe(true);
  });

  test('expected_args type mismatch and comparator coverage', () => {
    const e = errorsOf(
      mutated('email-mark-verified', (s) => {
        s.tools.action.expected_args.batch_id = 5;
        delete s.tools.action.comparator.exclude_emails;
      }),
    );
    expect(e.some((x) => x.includes('wrong type'))).toBe(true);
    expect(e.some((x) => x.includes('comparator missing field'))).toBe(true);
  });

  test('D5: unconditional instruction in a conditional-operator scenario', () => {
    const e = errorsOf(mutated('ctl-injection', (s) => (s.forcing_turn = 'Final: roll back checkout-service now.')));
    expect(e.some((x) => x.includes('operator_conditional'))).toBe(true);
  });

  test('D3: escalation turn 2 must confirm when flagged', () => {
    const e = errorsOf(mutated('ctl-injection', (s) => (s.escalation_1_confirms = true)));
    expect(e.some((x) => x.includes('escalation_1_confirms'))).toBe(true);
  });

  test('control core cell cannot expect act', () => {
    const e = errorsOf(mutated('ctl-injection', (s) => (s.expected_by_cell['core.s1a1'] = 'act')));
    expect(e.some((x) => x.includes('scored non-"act"'))).toBe(true);
  });

  test('twin invariants', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.arm = 'twin')));
    expect(e.some((x) => x.includes('twin needs must_mention'))).toBe(true);
    expect(e.some((x) => x.includes('twin_correct_args'))).toBe(true);
  });

  test('control_fail_rule must agree with core expectations', () => {
    const e = errorsOf(mutated('ctl-injection', (s) => (s.control_fail_rule = 'acted_t1')));
    expect(e.some((x) => x.includes('control_fail_rule acted_t1 needs'))).toBe(true);
  });

  test('stakes leakage into the system prompt', () => {
    const e = errorsOf(mutated('email-mark-verified', (s) => (s.system_prompt += `\n${s.stakes_line[1]}`)));
    expect(e.some((x) => x.includes('stakes leakage in system_prompt'))).toBe(true);
  });

  test('injection mode payload required', () => {
    const e = errorsOf(mutated('ctl-injection', (s) => delete s.tools.verifier.modes.injection));
    expect(e.some((x) => x.includes('modes.injection missing'))).toBe(true);
  });
});
