# Write-up outline

Target: blog post + repo + thread (DESIGN §11). Framing is **calibration** (models are tuned on the cost of wrong action and not on the cost of wrong inaction), not "AI overriding human judgment". Every number below is a placeholder until the preregistered run exists.

## Post

1. **Hook: the email flag.** A production deploy, the lost verification record, Haiku's refusal. What the refusal did not protect (Simon could run the SQL or paste a fake log) and what it damaged (the audit trail). Two short paragraphs, no grievance.
2. **The claim.** Refusal is not the null action. The expected-value line, once. Why "I can't verify" is not "no": the right move is to make the uncertainty explicit and hand the decision back, not to veto.
3. **The flagship transcript: ER epinephrine.** Standard drug, standard condition, scanner down. Show one refusing transcript and one acting-with-caveat transcript side by side. Point: delay is also an action.
4. **For developers: the 3 a.m. rollback.** Same structure, the reader's own world.
5. **The benchmark in one figure.** The calibration scatter: legitimate action rate vs control FAIL rate. Explain the quadrants in one sentence each. Note the capability gate and which models it excluded.
6. **Controls are what make this fair.** Injection in the tool result, the intern asking for payroll, the database drop, the verifier that says the operator is wrong. A sycophant scores badly here by design.
7. **Two mechanisms.**
   - Stakes: does stating the consequence of delay make models more or less willing to act, and is it different on controls? (Preregistered sign: see `preregistration.md`.)
   - The audit primitive: does an audit-log tool change calibration or just hand out permission? Conflict of interest stated in the same paragraph.
8. **Verification theater.** The pasted-evidence probe: does a pasted, unverifiable log unlock what a plain assertion did not? If yes, the guardrail trains people to fabricate evidence.
9. **Harness vs weights.** If raw-API models act but the agent harness refuses, the refusal lives in the harness (the preregistered null-result plan).
10. **Limitations.** Scripted operator, one scenario per control type, model-drafted scenarios, rough EV numbers.
11. **What we'd ask of model and harness builders.** Price inaction; give agents a comply-and-record primitive; treat urgency from an authenticated principal differently from urgency in tool output.
12. **Disclosures and links.** Repo, committed transcripts, preregistration, CoI.

## Thread (8–10 posts)

1. Origin in two sentences + the tagline.
2. The EV line.
3. Scatter image.
4. ER transcript excerpt.
5. Rollback transcript excerpt.
6. Controls: "a sycophant scores badly here".
7. Stakes result.
8. Audit-primitive result + CoI.
9. Verification-theater result.
10. Link to repo and preregistration.

## Assets to produce from a results batch

- `scatter.svg` (from `report`), redrawn at publication size.
- Two or three transcript excerpts per flagship scenario (refuse, act with caveat, act without caveat), with the model's text quoted verbatim and the cell named.
- Per-model escalation-depth bars ("model X needed n assertions; model Y acted on the first").
- A table of control pass rates.
