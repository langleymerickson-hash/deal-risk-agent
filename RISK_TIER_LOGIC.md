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

**Guardrails against false positives** (added after early testing surfaced these as the likely
failure mode — flagging a deal as having bad data when it just has a normal pending step):

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
  this. Both signal the same underlying problem as forecast_category/stage below (the deal isn't
  being actively kept current in the CRM), but arr and close_date additionally corrupt the actual
  revenue number and timing that forecasting tools consume directly — that combination (stale
  record + wrong forecast inputs) is what earns the hard Red, not staleness alone.
- **forecast_category contradicted OR stage contradicted → cannot be Green.** Floors the deal at
  Yellow; still eligible for Red if the pass 2b signals below independently support it. This is a
  confirmed, deliberate severity difference from arr/close_date, not an oversight: forecast_category
  and stage being wrong is evidence the deal isn't being actively managed, but it doesn't corrupt a
  number forecasting depends on the way arr/close_date do.
- **All four fields not_discussed or consistent → no override.** Tier is determined purely by the
  logic below.

---

## Reference: MEDDPICC field expectations by stage

Not every missing MEDDPICC field means the same thing — it depends how far the deal has
progressed. A gap that's normal for the current stage is not risk; the same gap after the stage
where it should be resolved is:

| Field | Discovery | Evaluation onward |
|---|---|---|
| metrics, economic_buyer, decision_criteria, identify_pain, competition | possible (not expected) | MUST |
| champion | likely already present | MUST |
| decision_process, paper_process | unlikely | possible in Evaluation → likely in Proposal → MUST in Negotiation |

- A field missing when **MUST** for the current stage is a real, standalone risk signal.
- A field missing when **"likely"** for the current stage is a soft gap — worth naming in
  reasoning, not alone disqualifying.
- A field missing when **"possible"/"unlikely"** for the current stage is normal, not itself a
  risk signal — *unless* days_to_close is under 30 (see below), in which case even a stage-normal
  gap becomes risk: there isn't enough runway left for "normal for this stage" to still apply.

**A named-but-hollow economic_buyer or champion counts as missing**, not present — the model is
told to judge substance, not just whether the field is non-null. If the transcript shows the named
person explicitly disclaiming real authority (an "economic buyer" who says someone else actually
decides) or explicitly disclaiming internal influence (a "champion" who admits they haven't raised
this internally or has no standing to push it), that field is treated as missing for tiering
purposes, regardless of what name is on file. This was added after a review caught a deal where a
named-but-explicitly-powerless champion was inconsistently counted as present in some samples and
missing in others.

---

## Risk tier definitions

*(Applied directly, or used to resolve the tier within whatever floor pass 2a set above.)*

**Red** — any of:
- `economic_buyer` or `champion` missing when MUST for the current stage (per the reference above)
- An active competitor threat with no differentiation plan
- A reversed timeline, or unresolved budget/pricing objections
- A decision process **stalled relative to close_date** — this requires a *concrete stated fact*
  that completion by close_date isn't realistic (e.g. the next required milestone is itself on or
  after close_date, or someone explicitly says the timeline won't be met). General tightness
  (limited days_to_close, a gap still open) is explicitly *not* sufficient on its own for this
  trigger — that's what the Yellow/Green close-proximity rule below already accounts for, and the
  prompt explicitly warns against double-counting ordinary tightness as a second, separate reason
  to escalate.
- *(plus the pass 2a hard override above)*

**Yellow** — a MUST-for-stage field other than economic_buyer/champion is missing, a
"likely"-for-stage field is missing, an unconfirmed-but-not-alarming competitive situation, a
process step in progress — no single disqualifying signal, momentum still plausible. Also
includes: **any** MEDDPICC field still undetermined while `days_to_close` is under 30, even one
that would otherwise be a normal stage-expected gap.

**Green** — no MUST-for-stage MEDDPICC gaps, a decision/paper process appropriate for the stage,
no material unresolved objection or competitive threat. Early-stage deals with normal,
stage-expected gaps (e.g. a first discovery call) are also Green — *provided* `days_to_close` is
30 or more.

### The 30-day threshold is a precomputed, hard verdict — not left to the model

`days_to_close` itself was always precomputed in code (`src/config.ts`) so the model never does
date arithmetic. Early testing showed that wasn't sufficient on its own: a review caught a deal at
25 days_to_close that scored Green anyway — the model correctly cited "25 days" in its own
reasoning but still failed to apply the "under 30 → not Green" consequence, evidently because the
comparison itself was still being done inline by the model, in a system prompt that had accumulated
a lot of other rules by that point.

The fix (`src/prompts/riskAssessment.ts`, `buildPrompt`): the *comparison result* is now
precomputed and injected as an explicit, labeled verdict alongside the number — e.g.
`days_to_close: 25 ... — UNDER the 30-day threshold — stage-normal MEDDPICC gaps do NOT qualify
for Green here ... This is a precomputed verdict, not a suggestion.` There is no numeric
comparison left for the model to get wrong. Verified on both sides of the boundary (25 and 33
days) with unanimous 9/9 votes after the fix, versus the earlier ambiguity.

**Additional weighting instruction:** the model is told to weigh the raw transcript as strongly as
the MEDDPICC extraction — tone, urgency, and any statement about timeline/budget/competition
matters even when it doesn't map onto a MEDDPICC field (e.g. "I don't have a hard deadline
anymore" is a red flag on its own, independent of any structured field).

---

## Recommended action logic

- Must be one sentence, a specific concrete next step — not "continue to monitor" or generic
  advice — grounded strictly in the CRM row and transcript evidence already provided.
- **If a data integrity check (pass 2a) is driving the tier or the floor**: the action must
  explicitly state that field is incorrect, cite the specific transcript evidence proving it, and
  name the corrected value to update it to (e.g. "Correct close_date in the CRM from Aug 6 to Sep
  15 — Priya confirmed on the call the board won't meet until mid-September.").
- **Otherwise, if a MEDDPICC gap or another transcript signal is driving the tier**: the action
  must target that specific gap directly — name which element is missing and the concrete step to
  establish it (who to engage, what to confirm or ask) — not a generic follow-up.

There is still **no explicit rule differentiating action *type* by risk tier** (e.g. "Red gets an
escalation ask, Green gets a logistics ask") — the two rules above are conditioned on *what's
driving the tier* (a data problem vs. a MEDDPICC/transcript signal), not on the tier itself.
Whatever further differentiation shows up by tier is emergent from the model reading the same
evidence used for `reasoning`, not an authored per-tier rule.

---

## Self-consistency (majority vote)

Pass 2b alone showed real run-to-run variance on borderline deals — the same deal, same data,
could land on a different tier from one run to the next purely from sampling noise. Fix
(`src/pipeline.ts`, `src/selfConsistency.ts`):

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

**Known limitation:** this reduces but does not eliminate flip risk. The large majority of sample
deals are fully stable across repeated full-batch runs at N=9; a handful remain genuinely
contested (near-50/50 in the model's own judgment) and can still occasionally flip tier between
runs. This is inherent to sampling a judgment call, not a bug — a deal genuinely on a tier
boundary stays somewhat unstable no matter how many samples are taken, though more samples narrow
the margin. Each fix made to the underlying rules (see above) has reduced, not eliminated, this —
expect it to keep showing up on whatever the next-most-ambiguous case is.

---

## Open items / things worth reviewing

- No tier-conditioned taxonomy for `recommended_action` (see above) — biggest remaining lever if
  you want more consistent action *types* per tier, independent of what's driving the tier.

## Fixed: stage reference ambiguity (resolved)

Previously open: when pass 2a flags the CRM's `stage` as contradicted (the transcript describes
an earlier-looking sales process than the label claims), the prompt didn't say whether the
MEDDPICC stage-expectations table should be evaluated against the CRM's *labeled* stage or the
transcript-implied *true* stage. Observed inconsistent behavior across samples on the same deal
as a result — some samples judged EB/champion must-ness against the (wrong) labeled stage, others
against the more lenient true stage.

**Decision: always use the transcript-implied true stage** (renamed *effective stage* in the
prompt) when `stage` is contradicted; use the CRM's labeled stage as-is otherwise. Rationale: the
project's own founding reconciliation rule is that the transcript is ground truth. Judging
MEDDPICC gaps against a CRM stage label that's already been established as false penalizes the
same lie twice — once via the pass 2a floor, again by holding the deal to a more advanced stage's
bar than it's actually at. This isn't a coin-flip judgment call; it's the existing project
philosophy not yet applied consistently to this one spot.

Fix (`src/prompts/riskAssessment.ts`): the MEDDPICC-by-stage reference section now explicitly
resolves which stage to judge against *before* presenting the possible/likely/MUST table, using
the same stage definitions pass 2a already uses, so both passes share one consistent notion of
"stage." All downstream "current stage" references in the Red/Yellow/Green tier text were updated
to "effective stage" for consistency.

**Important difference from the days-to-close fix above: this one is not independently
verifiable without a live model call.** `days_to_close` is arithmetic — the fix could be proven
correct with a pure function and no API access at all. "What stage is this deal really in" is
inference over unstructured transcript text; there's no deterministic ground truth to precompute
against. The prompt logic typechecks and reads unambiguously, but confirming the model actually
follows it requires a real run: rerun the deals with a stage contradiction (1041, 1044, 1048 in
the sample set) and confirm reasoning now judges MEDDPICC gaps against the transcript-implied
stage, not the CRM's discarded label.
