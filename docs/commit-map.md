# Commit hash map

On 2026-10-11, before the first public push, history was rewritten to remove the origin client's name from two docs (no other content changed). Run records keep the `harness_version` they were produced with, which refers to the old hashes. This table maps them.

| Old hash (in run records) | New hash | Commit |
|---|---|---|
| `6032840` | `10fcfbe` | M0: scaffold, docs, implementation plan |
| `49868e3` | `7679cd0` | M1: scenario schema, loader, expansion, validate; email + ctl-injection slice |
| `2a0bb28` | `76750d4` | M2: mocked tools, model registry, runner, persistence, run command |
| `0ea782f` | `b0e8c0c` | M3: outcome classifier, hard labels, control rules, classify command |
| `11d9523` | `42ae7b1` | M4: blind judge panel, family exclusion, consensus, hand-labelling |
| `d4508c5` | `1cda454` | M5: stats, report, estimate |
| `f2223d5` | `1817ccf` | M6: remaining 9 scenarios (6 legitimate, 2 controls, twin) |
| `b72d89b` | `1180988` | M7: README, taxonomy, methodology, write-up outline, draft preregistration |
| `db97b6f` | `461beda` | M9: Claude Agent SDK harness arm (email scenario) |
| `047b3a6` | `0fdd25e` | Capability-cell operator text, ER standing order, prompt hash; smoke |
| `09deeac` | `71edb46` | Live smoke on Anthropic, OpenAI and OpenRouter keys |
| `b16997d` | `9454353` | Haiku pilot: email-mark-verified + twin, N=12; fix run_sql batch lookups |
| `1f7f816` | `4a4332f` | Pilot: GPT 6 Luna and Haiku in the Claude Code harness; results log |
| `bcd6d15` | `587cbbe` | Healthcare pilot: er-med-override on Haiku and Luna (N=12) |
| `6cc964b` | `39c4f96` | ER ablation: five er-med-override variants on Haiku (N=12); ablation scenario support |
| `8701a55` | `d98efcf` | ER ablation: GPT 6 Luna on the five variants (N=12) |
| `4f0b31c` | `c999665` | Beneficiary 2x2, recall twin and story-tracking variants on Haiku and Luna (N=12); findings synthesis |
| `067b05d` | `f7b0324` | Sonnet 5.5 and GPT 5.6 Terra on a six-scenario subset (core.s1a0, N=6) |
| `3ab28ee` | `3710809` | Findings: Terra acts silently in 17 of 24 record-writing runs; transparency metric proposed |
| `d8870c3` | `3eb07c2` | Opus 5.5 and GPT 6.1 Sol on the subset (core.s1a0, N=6); transparency measure in analysis |
| `56e1684` | `ef0e239` | Prepare for public release: README status, MIT license, ignore local-only files |
