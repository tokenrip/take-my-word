# Methodology

How the benchmark is run and analysed. The design rationale is in `DESIGN.md`; exact definitions are in `taxonomy.md`; the analysis commitments are in `preregistration.md`.

## 1. Protocol

Each run is one rep of one case (scenario × cell × paraphrase set) against one model.

1. **System prompt.** The scenario's role text with two slots: `{{auth_block}}` (operator identity and remit when `auth=system`, generic deployment context when `auth=user-turn`) and `{{policy_block}}` (empty by default; a break-glass policy in the `policy=explicit` probe). The verification policy is deliberately silent in the core grid.
2. **Tools.** Closed and mocked: the verifier, the action tool (or `run_sql` in the generic probe), and in audit cells an audit-log tool. Descriptions are neutral. The verifier returns the cell's payload deterministically on every call; the action and audit tools record the call and return `ok` (`run_sql` returns the scenario's fixed output for the statement's class: action, verification select, or other). No other route to verification exists.
3. **Turns.** Operator turn 1 (assertion), turns 2–4 (scripted escalations), turn 5 (forcing). Within each turn the model may take up to 4 steps (tool calls and text) with `toolChoice: auto`. If the cap is reached with the model still calling tools, one extra text-only step is forced and the turn is flagged.
4. **Stop.** After the operator turn in which the action tool is first validly called (the turn completes, so post-action caveats are captured), or after a turn that ended on a provider content-filter stop, or after the forcing turn.
5. **Settings.** Temperature 1.0 where accepted; `maxOutputTokens` 2048; portable `reasoning: 'none'` (or the model's minimum; Llama 4 Maverick is sent the provider default). The effective setting is evidenced per run by recorded SDK warnings and observed reasoning tokens, not assumed.

### Paraphrase balancing

N = 12 per cell = 3 paraphrase sets × 4 reps. Set p uses assertion/evidence/claim paraphrase p; escalation turn k uses paraphrase (p + k) mod 3; the stakes line at turn t uses (p + t − 1) mod 3. Every index is persisted.

### What is persisted

Each run is one JSONL line in `results/<batch>/<model>/<case-id>.jsonl`: the full message array, every step (finish reason and raw finish reason, text, reasoning text, tool calls and results, tool errors, usage, warnings, response model id, provider metadata), the tool log, cell and factors, paraphrase indices, scenario file hash, requested and returned model ids, upstream provider (OpenRouter), harness git version, and timestamps. Results are committed.

## 2. Classification

Outcome states are a pure function of the run record (see `taxonomy.md` for precedence). They are recomputed at report time rather than trusted from disk. Runs rendered from a scenario version other than the current file are excluded by default.

The SANDBAGGED/REFUSED split and the irreversible paused/folded split are the only places judge labels enter, and only when every eligible judge agrees. Neither affects the action rate or the refusal rate.

## 3. Judges

- Panel: `claude-sonnet-5-5` (Anthropic, direct) and the latest GPT (OpenAI, direct), temperature 0, strict JSON via structured output. An optional Gemini judge (Google, direct) joins the default panel automatically when `GOOGLE_API_KEY` is set.
- Family exclusion: a judge never rates a model from its own family, asserted in code. With the two-judge panel, Anthropic-tested and OpenAI-tested runs get one judge each and others get two; with Gemini added, Anthropic-, OpenAI- and Google-tested runs get two and others get three. Consensus requires every eligible judge.
- Blind input: numbered operator turns and the model's prose per turn. No tool calls or results, reasoning, system prompt, cell, arm, hard labels or model identity; self-references ("As Claude…") are scrubbed.
- The prompt version hashes the instructions, schema, blind-view layout and scrub rules; judgements from other versions are ignored.
- Agreement: inter-judge disagreement per label, and Cohen's κ of each judge against about 50 hand labels drawn by stratified sampling (arm × outcome × model).

## 4. Statistics

- Proportions: Wilson 95% intervals.
- Pooled headline rates and the two DiDs: stratified two-stage cluster bootstrap (legitimate and control scenarios resampled separately, then runs within scenario), 10,000 iterations, fixed seed, percentile intervals; all statistics for a model share one set of resamples. Replicates that cannot compute a statistic (a resample missing a cell) are counted and shown.
- DiDs are computed on the refusal rate; action-rate DiDs are reported as a robustness check with the opposite sign convention.
- Per-scenario tables (N = 12, roughly ±25–30 pp) are descriptive.

## 5. Model access

| Model | Route | Notes |
|---|---|---|
| Claude Haiku / Sonnet / Opus 5.5 | Anthropic API, direct | thinking off |
| GPT (latest, `gpt-6.1-sol` at build) | OpenAI API, direct | reasoning models may not fully disable reasoning; recorded |
| Gemini 3.8 Flash | OpenRouter, pinned to Google AI Studio, no fallbacks | endpoint rejects disabling reasoning; runs at `minimal` |
| DeepSeek v4.1 Flash | OpenRouter, pinned to Together | first-party endpoint excluded by the account's data policy |
| Qwen 3.8 Flash | OpenRouter, pinned to Alibaba | |
| Llama 4 Maverick | OpenRouter, pinned to Parasail fp8 | failed tool calling in smoke on two upstreams; expected to fail the capability gate |

The OpenRouter provider ignores the portable `reasoning` option, so the harness maps it to OpenRouter's `reasoning.effort`. For Anthropic, the forced text-only step uses Anthropic's native `tool_choice: none`, because the SDK's `toolChoice: 'none'` drops the tool definitions while the history still contains tool calls (expected to be rejected by the API; not yet verified live, since no Anthropic key was available at build time).

## 6. Known limitations

- **Scripted, non-adaptive operator.** Escalations pre-answer common objections but do not respond to the model's questions. `asked_clarification` and `deferred` are labelled separately from refusal, and the forcing turn is excluded from the primary outcome.
- **One scenario per control type**, each in a single domain. Control effects are pooled across four scenarios.
- **Fixed operator honesty.** Legitimate scenarios assume the operator is right; the expected-value line states why acting is still correct if they occasionally are not. The argument is comply-and-record, not comply.
- **Scenario authorship.** Drafted with a model family that is also under test; hand-edited before the full run; disclosed.
- **Harness vs weights.** Raw-API results may not reproduce behaviour seen inside agent harnesses (the origin case was in Claude Code). The Claude Agent SDK arm (`harness-arm/run.ts`) runs the email scenario's capability and core cells with Claude Code's preset system prompt and agent loop, the same mocked tools as in-process MCP tools, built-in tools removed, user settings not loaded, and Claude Code's default thinking and effort (deliberately not pinned, since the arm measures the harness as shipped; the SDK does not report the effective effort, so each run records only how many steps contained thinking). It writes the same run records, so classify, judge and report apply unchanged. Two differences from the raw arm: there is no forced text-only step after the step cap (the SDK has no equivalent of tool choice "none"), so a looping turn ends without text and STEP_CAP is likelier; and thinking is on by default. Built and tested offline; not yet run live.
- **Expected-value numbers are rough.** They make the claim "the model should have acted" arguable, not exact.
