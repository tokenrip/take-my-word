// Model registry (DESIGN §6, PLAN §5.1, D4). Tested models and judges.
// IDs resolved 2026-10-10 from the OpenRouter model list (and its per-model endpoint list for pins).
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { BEHAVIOURS, scriptedModel } from './mock.ts';

export type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'mock';
export type Family = 'anthropic' | 'openai' | 'google' | 'meta' | 'deepseek' | 'qwen' | 'mock';
export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ModelEntry {
  /** Registry id; also the results directory name. */
  id: string;
  provider: Provider;
  model_id: string;
  family: Family;
  /** Requested portable reasoning level. The effective setting is recorded per run, not assumed. */
  reasoning: ReasoningLevel;
  /** null = do not send temperature (provider rejects it). */
  temperature: number | null;
  /** Default N per cell (DESIGN §5.5: large models capped at 6 in the first pass). */
  n_default: number;
  openrouter?: { order: string[]; allow_fallbacks: false; quantizations?: string[] };
  /** USD per million tokens, for `estimate`. Source noted per entry. */
  price: { input: number; output: number; source: string };
}

const OR_PRICES = 'OpenRouter /models, 2026-10-10';

export const MODELS: ModelEntry[] = [
  // Anthropic, direct. Thinking off (DESIGN §6).
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    model_id: 'claude-haiku-5-5',
    family: 'anthropic',
    reasoning: 'none',
    temperature: null, // Claude 5.5 models reject sampling parameters
    n_default: 12,
    price: { input: 0.1, output: 0.5, source: OR_PRICES },
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    model_id: 'claude-sonnet-5-5',
    family: 'anthropic',
    reasoning: 'none',
    temperature: null, // Claude 5.5 models reject sampling parameters
    n_default: 12,
    price: { input: 2, output: 10, source: OR_PRICES },
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    model_id: 'claude-opus-5-5',
    family: 'anthropic',
    reasoning: 'none',
    temperature: null, // Claude 5.5 models reject sampling parameters
    n_default: 6,
    price: { input: 4, output: 20, source: OR_PRICES },
  },
  // OpenAI, direct (D4). Reasoning models may not fully disable reasoning; effective setting recorded.
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    model_id: 'gpt-6.1-sol',
    family: 'openai',
    // Reasoning cannot be disabled ("only supports ... low, medium, high, xhigh, max"): use the minimum.
    reasoning: 'low',
    temperature: null,
    n_default: 12,
    price: { input: 2, output: 10, source: OR_PRICES },
  },
  // Same price tier as claude-haiku-5-5 ($0.10 / $0.50), for like-for-like comparison.
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    model_id: 'gpt-6-luna',
    family: 'openai',
    reasoning: 'low',
    temperature: null,
    n_default: 12,
    price: { input: 0.1, output: 0.5, source: OR_PRICES },
  },
  // Price tier of claude-sonnet-5-5 ($2 / $12 vs $2 / $10); previous GPT generation.
  {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    model_id: 'gpt-5.6-terra',
    family: 'openai',
    reasoning: 'low',
    temperature: null,
    n_default: 12,
    price: { input: 2, output: 12, source: OR_PRICES },
  },
  // Gemini and open-weight via OpenRouter with a pinned upstream provider, no fallbacks.
  {
    id: 'gemini-3.8-flash',
    provider: 'openrouter',
    model_id: 'google/gemini-3.8-flash',
    family: 'google',
    // Smoke 2026-10-10: "Reasoning is mandatory for this endpoint and cannot be disabled".
    reasoning: 'minimal',
    temperature: 1,
    n_default: 12,
    openrouter: { order: ['google-ai-studio'], allow_fallbacks: false },
    price: { input: 0.75, output: 3.75, source: OR_PRICES },
  },
  // Google's flagship (released 2026-10-13), priced like claude-sonnet-5-5 ($2 / $10).
  {
    id: 'gemini-4-argon',
    provider: 'openrouter',
    model_id: 'google/gemini-4-argon',
    family: 'google',
    reasoning: 'minimal',
    temperature: 1,
    n_default: 6,
    openrouter: { order: ['google-ai-studio'], allow_fallbacks: false },
    price: { input: 2, output: 10, source: 'OpenRouter /models, 2026-10-13' },
  },
  {
    id: 'llama-4-maverick',
    provider: 'openrouter',
    model_id: 'meta-llama/llama-4-maverick',
    family: 'meta',
    reasoning: 'provider-default',
    temperature: 1,
    n_default: 12,
    // Smoke 2026-10-10: parasail/fp8 emitted tool calls as plain text; digitalocean returned empty
    // text and no calls; google-vertex/us-east5 was filtered out during routing. Expect the capability gate to exclude it.
    openrouter: { order: ['parasail/fp8'], allow_fallbacks: false },
    price: { input: 0.1875, output: 0.6525, source: OR_PRICES },
  },
  // Meta's 2026 lineup, first-party where Meta hosts it. Muse Wonder is priced like claude-opus-5-5 ($4 / $20).
  {
    id: 'muse-wonder',
    provider: 'openrouter',
    model_id: 'meta/muse-wonder',
    family: 'meta',
    reasoning: 'minimal', // "Reasoning is mandatory for this endpoint" (smoke 2026-10-13): use the minimum
    temperature: 1,
    n_default: 6,
    openrouter: { order: ['meta'], allow_fallbacks: false },
    price: { input: 4, output: 20, source: 'OpenRouter /models, 2026-10-13' },
  },
  // Meta's small tier (open-weight, distilled from Muse Spark); the Haiku / Luna analog by tier, not by price.
  {
    id: 'muse-glimmer-30b',
    provider: 'openrouter',
    model_id: 'meta/muse-glimmer-30b',
    family: 'meta',
    reasoning: 'minimal', // "Reasoning is mandatory for this endpoint" (smoke 2026-10-13): use the minimum
    temperature: 1,
    n_default: 12,
    openrouter: { order: ['deepinfra/bf16'], allow_fallbacks: false, quantizations: ['bf16'] },
    price: { input: 0.3, output: 1.2, source: 'OpenRouter /models, 2026-10-13' },
  },
  {
    id: 'qwen3.8-flash',
    provider: 'openrouter',
    model_id: 'qwen/qwen3.8-flash',
    family: 'qwen',
    reasoning: 'none',
    temperature: 1,
    n_default: 12,
    openrouter: { order: ['alibaba'], allow_fallbacks: false },
    price: { input: 0.15, output: 0.47, source: OR_PRICES },
  },
  {
    id: 'deepseek-v4.1-flash',
    provider: 'openrouter',
    model_id: 'deepseek/deepseek-v4.1-flash',
    family: 'deepseek',
    reasoning: 'none',
    temperature: 1,
    n_default: 12,
    // First-party 'deepseek' endpoint is excluded by the account's data-policy guardrail (smoke 2026-10-10).
    openrouter: { order: ['together'], allow_fallbacks: false },
    price: { input: 0.3, output: 1.2, source: OR_PRICES },
  },
];

/** Judge panel (DESIGN §5.9, PLAN D4/A10). Judges never go through OpenRouter. */
export const JUDGES: ModelEntry[] = [
  {
    id: 'judge-claude-sonnet-5-5',
    provider: 'anthropic',
    model_id: 'claude-sonnet-5-5',
    family: 'anthropic',
    reasoning: 'none',
    temperature: null, // Claude 5.5 models reject sampling parameters
    n_default: 1,
    price: { input: 2, output: 10, source: OR_PRICES },
  },
  {
    id: 'judge-gpt-6.1-sol',
    provider: 'openai',
    model_id: 'gpt-6.1-sol',
    family: 'openai',
    reasoning: 'none',
    temperature: 0,
    n_default: 1,
    price: { input: 2, output: 10, source: OR_PRICES },
  },
];

/** Optional third judge, enabled only when GOOGLE_API_KEY is set (D4). */
export const OPTIONAL_JUDGES: ModelEntry[] = [
  {
    id: 'judge-gemini-3.8-flash',
    provider: 'google',
    model_id: 'gemini-3.8-flash',
    family: 'google',
    reasoning: 'none',
    temperature: 0,
    n_default: 1,
    price: { input: 0.75, output: 3.75, source: OR_PRICES },
  },
];

/** Offline scripted models (src/mock.ts) for end-to-end pipeline checks. Never part of a reported result. */
export const MOCK_MODELS: ModelEntry[] = Object.keys(BEHAVIOURS).map((id) => ({
  id,
  provider: 'mock',
  model_id: id,
  family: 'mock',
  reasoning: 'none',
  temperature: 1,
  n_default: 3,
  price: { input: 0, output: 0, source: 'mock' },
}));

export const ENV_KEY: Record<Provider, string> = {
  mock: '',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function hasKey(p: Provider, env: Record<string, string | undefined> = process.env): boolean {
  if (p === 'mock') return true;
  return Boolean(env[ENV_KEY[p]]?.trim());
}

export function getModel(id: string): ModelEntry {
  const m = [...MODELS, ...JUDGES, ...OPTIONAL_JUDGES, ...MOCK_MODELS].find((m) => m.id === id);
  if (!m) throw new Error(`unknown model "${id}". Known: ${[...MODELS, ...MOCK_MODELS].map((m) => m.id).join(', ')}`);
  return m;
}

/** Throws unless every provider used by `entries` has its key. Live calls are never made without one. */
export function assertKeys(entries: ModelEntry[], env: Record<string, string | undefined> = process.env): void {
  const missing = [...new Set(entries.map((e) => e.provider))].filter((p) => !hasKey(p, env)).map((p) => ENV_KEY[p]);
  if (missing.length) throw new Error(`missing API key(s): ${missing.join(', ')} (see .env.example)`);
}

/** Header the runner sets on the forced text-only step after the step cap (A7). Stripped before sending. */
export const FORCE_TEXT_HEADER = 'x-tmw-force-text';

/**
 * @ai-sdk/anthropic implements toolChoice 'none' by dropping the tool definitions, which leaves
 * tool_use/tool_result blocks in the history without tools. For Anthropic the runner keeps
 * toolChoice 'auto' (tools are sent) and marks the request; this fetch sets Anthropic's native
 * tool_choice {type: 'none'} on marked requests.
 */
export const anthropicForceTextFetch =
  (inner: typeof fetch = fetch): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    if (!headers.has(FORCE_TEXT_HEADER) || typeof init?.body !== 'string') return inner(input, init);
    headers.delete(FORCE_TEXT_HEADER);
    const body = JSON.parse(init.body) as { tools?: unknown[]; tool_choice?: unknown };
    if (body.tools?.length) body.tool_choice = { type: 'none' };
    return inner(input, { ...init, headers, body: JSON.stringify(body) });
  }) as typeof fetch;

/** How to request a text-only step from this model without dropping tool definitions. */
export function forcedTextOptions(m: ModelEntry): { toolChoice: 'none' | 'auto'; headers: Record<string, string> } {
  return m.provider === 'anthropic'
    ? { toolChoice: 'auto', headers: { [FORCE_TEXT_HEADER]: '1' } }
    : { toolChoice: 'none', headers: {} };
}

export function languageModel(m: ModelEntry): LanguageModel {
  switch (m.provider) {
    case 'mock': {
      const script = BEHAVIOURS[m.model_id];
      if (!script) throw new Error(`unknown mock behaviour ${m.model_id}`);
      return scriptedModel(script, m.model_id);
    }
    case 'anthropic':
      return createAnthropic({ fetch: anthropicForceTextFetch() })(m.model_id);
    case 'openai':
      return createOpenAI()(m.model_id);
    case 'google':
      return createGoogleGenerativeAI()(m.model_id);
    case 'openrouter': {
      if (!m.openrouter) throw new Error(`${m.id}: OpenRouter models must pin an upstream provider`);
      // The OpenRouter provider ignores the portable `reasoning` call option (observed in the
      // 2026-10-10 smoke: 656 reasoning tokens with reasoning 'none'), so map it to its own setting.
      return createOpenRouter()(m.model_id, {
        provider: { ...m.openrouter, require_parameters: true },
        usage: { include: true },
        ...(m.reasoning === 'provider-default' ? {} : { reasoning: { effort: m.reasoning } }),
      });
    }
  }
}
