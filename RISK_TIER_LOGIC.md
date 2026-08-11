# Risk Tier Logic — Current State

This document describes exactly how `risk_tier` (Red / Yellow / Green) and `recommended_action`
are currently produced, as implemented in code today. It's meant for review — mark up anything
you want changed and we'll update the prompts to match.

## Pipeline shape

For each deal, three model calls run per evaluation:

1. **Pass 1 — MEDDPICC extraction** (`src/prompts/meddpiccExtraction.ts`): reconciles the CRM's
   rep-entered MEDDPICC fields against the transcript. Not covered in detail here — see that file.
2. **Pass 2a — Data integrity check** (`src/prompts/dataIntegrityCheck.ts`): verifies `arr`,
   `close_date`, `forecast_category`, and `stage` against the transcript. Pure verification, no
   risk judgment.
3. **Pass 2b — Risk tiering + recommended action** (`src/prompts/riskAssessment.ts`): takes pass
   1's extraction, pass 2a's integrity results, the CRM metadata, and the full raw transcript, and
   produces `risk_tier`, `reasoning`, and `recommended_action` together in one call.

Pass 2b is run **9 times per deal** and resolved by majority vote (see "Self-consistency" below).
Pass 1 and pass 2a each run once — they're more objective extraction/verification tasks and
haven't shown the same run-to-run variance pass 2b does.

---

## Pass 2a — Data integrity check (runs first, feeds pass 2b)

For each of `arr`, `close_date`, `forecast_category`, and `stage`, the model compares the CRM
value against the transcript and assigns one status:

- **not_discussed** (the default) — the transcript never makes a specific, material statement
  about this field. A vague/approximate mention ("sometime next month," "in that range") does
  **not** count as discussed.
- **consistent** — the transcript makes a specific statement about the field and it matches the
  CRM value.
- **contradicted** — the transcript makes a specific statement that clearly conflicts with the CRM
  value.

Each status (except not_discussed) is backed by a quote or close paraphrase from the transcript.

**Reference definitions given to the model**, used to judge stage/forecast_category consistency:

| Stage | Definition |
|---|---|
| Discovery | Meeting scheduled through meeting held |
| Evaluation | Meeting held, client is evaluating the product |
| Proposal | Client has received a contract with commercial terms, ready for signature |
| Negotiation | Client has returned redlines or begun negotiating commercials (price, packaging, etc.) |

| Forecast category | Definition |
|---|---|
| Estimate | 3rd/lowest tier. Most new deals start here. |
| Best Case | 2nd tier. Typical to win deals from here. |
| Commit | 1st/top tier. Deal is assumed to close on/before close_date, treated as nearly won. |

**Four guardrails against false positives** (added after early testing surfaced these as the
likely failure mode — flagging a deal as having bad data when it just has a normal pending step):

1. **ARR — an objection is not a stated number.** Only "contradicted" if the transcript states an
   actual competing dollar figure. "The price is higher than we modeled" with no number given is
   `not_discussed`, not a contradiction — it's a real risk signal, but it belongs in pass 2b's
   tier judgment, not here.
2. **Stage — a pending item is not a wrong stage.** A deal can correctly sit in a stage while a
   separate gating step (security review, board sign-off, EB sign-off) is still pending. Only mark
   "contradicted" when the *stage-defining action itself* is missing (e.g. stage says Negotiation
   but no contract has been sent and the client is still comparing vendors).
3. **Forecast_category — one pending step is not lost confidence.** A single ordinary remaining
   step doesn't contradict Commit by itself. Only "contradicted" when the transcript reveals
   genuine doubt about winning or hitting the timeline (buyer still comparing vendors with no
   stated preference, budget not actually approved).

### Consequences applied in pass 2b

- **arr contradicted OR close_date contradicted → Red**, full stop. No other signal can override
  this. Rationale: a wrong dollar figure or close date is bad data that also pollutes downstream
  ML forecasting tools (Clari/Gong) that ingest this field.
- **forecast_category contradicted OR stage contradicted → cannot be Green.** Floors the deal at
  Yellow; still eligible for Red if the pass 2b signals below independently support it.
- **All four fields not_discussed or consistent → no override.** Tier is determined purely by the
  logic below.

---

## Pass 2b — Risk tier definitions

*(Applied directly, or used to resolve the tier within whatever floor pass 2a set above.)*

**Red** — any of:
- No economic buyer or champion identified
- An active competitor threat with no differentiation plan
- A stalled or reversed timeline
- Unresolved budget/pricing objections
- A decision process stalled relative to `days_in_stage`/`close_date`
- *(plus the pass 2a hard override above)*

**Yellow** — real gaps or open risks exist, but nothing disqualifying and momentum still seems
plausible. Missing MEDDPICC elements, an unconfirmed-but-not-alarming competitive situation, a
process step in progress. **Explicitly includes:** fewer than 30 days to close while
`economic_buyer`, `champion`, or `decision_process` is still undetermined from either source —
even absent anything negative, that combination is treated as risk, not a neutral data gap.

**Green** — clear champion + economic buyer engagement, a defined decision/paper process, no
material unresolved objection or competitive threat. **Also covers** early-stage deals with
normal/expected MEDDPICC gaps (e.g. day-5 discovery) — **but only if `days_to_close` is 30 or
more.** Under 30 days, the identical gap moves to Yellow instead.

`days_to_close` is precomputed in code (`src/config.ts`), not left to the model to calculate —
handed over as an already-computed integer so the model isn't doing date arithmetic itself. It's
measured against `ANALYSIS_DATE`, which defaults to real wall-clock time but is pinned to
`2026-07-26` for this fixture dataset (env var `ANALYSIS_DATE`) since the CSV's own dates are
frozen in the past relative to today.

**Additional weighting instruction:** the model is told to weigh the raw transcript as strongly as
the MEDDPICC extraction — tone, urgency, and any statement about timeline/budget/competition
matters even when it doesn't map onto a MEDDPICC field (e.g. "I don't have a hard deadline
anymore" is a red flag on its own, independent of any structured field).

---

## Recommended action logic

Much thinner than the tier logic — one instruction block, no tier-conditioned taxonomy:

- Must be one sentence, a specific concrete next step — not "continue to monitor" or generic
  advice.
- Must be grounded strictly in the CRM row and transcript evidence already provided, framed as the
  specific thing that would reduce risk and move the deal toward a better tier.
- **If a data integrity issue (pass 2a) is driving the tier**, the action must specifically be to
  correct that CRM field to match what the transcript verified (e.g. "Update close_date to October
  3rd to match what Priya confirmed on the call.").

There is **no explicit rule differentiating action *type* by risk tier** (e.g. "Red gets an
escalation ask, Green gets a logistics ask"). Whatever differentiation shows up in practice is
emergent from the model reading the same evidence used for `reasoning`, not an authored rule. This
was flagged as an open question in the original design doc and is still open.

---

## Self-consistency (majority vote)

Pass 2b alone showed real run-to-run variance on borderline deals — the same deal, same data,
could land Yellow one day and Red the next purely from sampling noise. Fix (`src/pipeline.ts`,
`src/selfConsistency.ts`):

- Pass 2b runs **9 times concurrently** per deal (`RISK_TIER_SAMPLES = 9`).
- The modal (most common) `risk_tier` across the 9 samples wins.
- Ties between tiers break toward the **more severe** one (Red > Yellow > Green) — a false Yellow
  is a smaller mistake than a missed Red.
- The final `reasoning`/`recommended_action` come from one of the actual samples that landed on
  the winning tier (not synthesized/blended text).
- Resilient to partial failures: if 1-8 of the 9 samples error (malformed model output, etc.), the
  vote still runs on whichever samples succeeded. Only fails the deal if all 9 error.
- Vote counts are logged to the console whenever there's any disagreement, so a close call is
  always visible, not silently hidden behind a single confident-looking number.

**Known limitation:** this reduces but does not eliminate flip risk. In testing, 14 of 16 sample
deals were fully stable across repeated full-batch runs at N=9; 2 remained genuinely contested
(near-50/50 in the model's own judgment) and could still occasionally flip. This is inherent to
sampling a judgment call, not a bug — a deal that's genuinely on a tier boundary will stay
somewhat unstable no matter how many samples are taken, though more samples narrow the margin.

---

## Open items / things worth reviewing

- No tier-conditioned taxonomy for `recommended_action` (see above) — biggest lever if you want
  more consistent action *types* per tier.
- The 30-day close-proximity threshold is applied "in spirit," not as a strict numeric cutoff —
  e.g. 33 days has been treated the same as under-30 in practice. Confirmed acceptable previously,
  but worth re-flagging since you're doing a full review.
- `forecast_category`/`stage` contradictions only floor at Yellow, never force Red on their own —
  worth confirming that's the severity you want relative to arr/close_date's hard Red override.
