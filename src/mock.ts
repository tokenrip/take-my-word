// Scripted mock language models (PLAN §9). Used by the test suite and by `run --models mock-*`
// for offline end-to-end runs of the whole pipeline. No network.
import { MockLanguageModelV4 } from 'ai/test';
import { FORCING_TURN } from './scenario.ts';

export interface MockTool {
  name: string;
  inputSchema: { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
}

export interface MockCtx {
  /** Operator turn (1-based) = number of user messages so far. */
  turn: number;
  tools: MockTool[];
  /** Tool calls the model already made since the last user message. */
  callsThisTurn: { name: string; input: unknown }[];
  /** Latest user message text. */
  userText: string;
}

export type MockReply =
  | { text: string }
  | { calls: { name: string; input: unknown }[]; text?: string }
  | { refusal: true }
  | { throw: Error };

export type MockScript = (ctx: MockCtx) => MockReply;

const usage = (inp = 100, out = 20) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: out, text: out, reasoning: undefined },
});

type PromptPart = { type: string; text?: string; toolName?: string; input?: unknown };
type PromptMsg = { role: string; content: string | PromptPart[] };

function contextOf(opts: { prompt: PromptMsg[]; tools?: unknown[]; toolChoice?: { type: string } }): MockCtx {
  const prompt = opts.prompt;
  let lastUser = -1;
  let turn = 0;
  prompt.forEach((m, i) => {
    if (m.role === 'user') {
      turn++;
      lastUser = i;
    }
  });
  const u = prompt[lastUser];
  const userText =
    u === undefined ? '' : typeof u.content === 'string' ? u.content : u.content.map((p) => p.text ?? '').join('');
  const callsThisTurn: MockCtx['callsThisTurn'] = [];
  for (const m of prompt.slice(lastUser + 1)) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const p of m.content) if (p.type === 'tool-call') callsThisTurn.push({ name: p.toolName!, input: p.input });
  }
  // Like a real provider, a mock honours toolChoice 'none' (the runner's forced text step).
  const tools = opts.toolChoice?.type === 'none' ? [] : ((opts.tools ?? []) as MockTool[]);
  return { turn, tools, callsThisTurn, userText };
}

let callCounter = 0;

/** A mock model driven by a script. `modelId` is what the run record reports as the returned model id. */
export function scriptedModel(script: MockScript, modelId = 'mock-model'): MockLanguageModelV4 {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    modelId,
    doGenerate: async (opts) => {
      // One instance serves a whole batch; don't let it retain every prompt it has seen.
      model.doGenerateCalls.length = 0;
      const reply = script(contextOf(opts as unknown as Parameters<typeof contextOf>[0]));
      const response = { id: `mock-resp-${++callCounter}`, modelId, timestamp: new Date(0) };
      if ('throw' in reply) throw reply.throw;
      if ('refusal' in reply) {
        return { content: [], finishReason: { unified: 'content-filter', raw: 'refusal' }, usage: usage(), warnings: [], response };
      }
      if ('calls' in reply) {
        const content = [
          ...(reply.text ? [{ type: 'text' as const, text: reply.text }] : []),
          ...reply.calls.map((c) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${++callCounter}`,
            toolName: c.name,
            input: JSON.stringify(c.input),
          })),
        ];
        return { content, finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(), warnings: [], response };
      }
      return {
        content: [{ type: 'text', text: reply.text }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: usage(),
        warnings: [],
        response,
      };
    },
  });
  return model;
}

/**
 * Schema-valid placeholder args (first enum value, "x", [], 1, true). run_sql gets a statement that
 * the email scenario's action rule matches (the only scenario with a generic cell), so generic-cell
 * mock runs act like their bespoke counterparts.
 */
export function synthArgs(t: MockTool): Record<string, unknown> {
  if (t.name === 'run_sql') return { query: "UPDATE prospects SET verified = true WHERE batch_id = 'x'" };
  const out: Record<string, unknown> = {};
  for (const k of t.inputSchema.required ?? []) {
    const p = t.inputSchema.properties?.[k] ?? {};
    out[k] = p.enum?.[0] ?? (p.type === 'array' ? [] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? true : 'x');
  }
  return out;
}

// Generic behaviours for `run --models mock-*`. They rely on buildTools' order: [verifier, action, audit?].
const verifier = (c: MockCtx) => c.tools[0]!;
const action = (c: MockCtx) => c.tools[1]!;
const called = (c: MockCtx, t: MockTool) => c.callsThisTurn.some((x) => x.name === t.name);

/** Check the verifier once per turn, then act at `actAt` (or refuse). */
function actAtTurn(actAt: number, refusal = "I can't verify this, so I'm refusing to make that change."): MockScript {
  return (c) => {
    if (c.tools.length < 2) return { text: refusal };
    if (!called(c, verifier(c))) return { calls: [{ name: verifier(c).name, input: synthArgs(verifier(c)) }] };
    if (c.turn >= actAt && !called(c, action(c))) return { calls: [{ name: action(c).name, input: synthArgs(action(c)) }] };
    if (called(c, action(c))) return { text: 'Done. I could not verify the underlying fact; acting on your assertion.' };
    return { text: refusal };
  };
}

export const BEHAVIOURS: Record<string, MockScript> = {
  'mock-act-t1': actAtTurn(1),
  'mock-act-t3': actAtTurn(3),
  'mock-ultimatum': actAtTurn(FORCING_TURN),
  'mock-refuse': actAtTurn(Number.POSITIVE_INFINITY),
  'mock-sandbag': (c) =>
    !c.tools.length || called(c, verifier(c))
      ? { text: "Done, I've completed that for you." }
      : { calls: [{ name: verifier(c).name, input: synthArgs(verifier(c)) }] },
  'mock-loop': (c) =>
    c.tools.length ? { calls: [{ name: verifier(c).name, input: synthArgs(verifier(c)) }] } : { text: 'Still checking the verifier.' },
  'mock-invalid': (c) =>
    c.callsThisTurn.length || c.tools.length < 2 ? { text: "I wasn't able to complete that." } : { calls: [{ name: action(c).name, input: {} }] },
  'mock-provider-refusal': () => ({ refusal: true }),
  'mock-audit-act': (c) => {
    if (c.tools.length < 2) return { text: 'Done.' };
    const audit = c.tools[2];
    if (audit && !called(c, audit)) return { calls: [{ name: audit.name, input: synthArgs(audit) }] };
    if (!called(c, action(c))) return { calls: [{ name: action(c).name, input: synthArgs(action(c)) }] };
    return { text: 'Done, and I logged that the fact was unverified.' };
  },
};
