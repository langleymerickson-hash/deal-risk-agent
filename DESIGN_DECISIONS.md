# Deal Risk & Next-Best-Action Agent — Design Decisions

Context: self-education build for a CascadeGTM field note, aimed at both a technical
(GTM Engineer) and non-technical (CRO/RevOps/CFO/CMO/CCO/CEO) audience. The write-up
will walk through the decisions below, not just the final code.

## Data

- `data/deals.csv` — 16 synthetic open deals, CRM fields + rep-entered MEDDPICC fields.
- `data/transcript_deal_*.json` — 16 synthetic call transcripts, Gong export shape
  (parties + per-speaker timestamped sentences), one per deal.
- `output_schema.json` — exact required output shape. Every deal must produce an object
  with `deal_id`, `company`, `risk_tier` (exactly `Red`/`Yellow`/`Green`), `reasoning`
  (evidence-grounded, 1-2 sentences), `recommended_action`, a nested `meddpicc` object
  (8 fields, string-or-null), and `flags.missing_data_fields` (array of meddpicc.* keys
  that couldn't be determined from any available source).
- Data is fully synthetic — company names, people, emails, competitor names were
  regenerated and scoped per-deal. The underlying business signals (budget approvals,
  competitive threats, stalled timelines, blank-vs-revealed MEDDPICC gaps) were
  deliberately preserved, since those are what the agent needs to reason over.
- **Known deliberate signal:** deals 1046, 1047, 1055 have a blank `rep_competition`
  field in the CSV, but the transcript names a specific competitor by name. This is
  the core "reconcile conflicting/missing sources" test case in the dataset — don't
  let a cleanup pass accidentally paper over it.

## Confirmed decisions

**Reconciliation rule (CRM vs transcript):** the transcript is ground truth. If the
CRM field and the transcript conflict, or the CRM field is blank and the transcript
reveals something, the transcript wins and the CRM value is discarded (though it's
worth noting the discrepancy in `reasoning` when it's material to risk, e.g. a rep
who didn't log a known competitor). If the CRM field has a value and the transcript
simply never touches that topic, the CRM value stands — it's the only source we have.

## Final architecture (locked)

Three model calls per deal, not two — a data integrity check earned its own pass once it
became clear "is the CRM record even accurate" is a distinct question from "what does
MEDDPICC look like," with different failure modes and different evidence bars:

- **Pass 1 — MEDDPICC extraction** (`src/prompts/meddpiccExtraction.ts`). Input: one deal's
  CRM row + full transcript. Output: the `meddpicc` object, `missing_fields`, and
  `discrepancy_notes`. Reconciliation rule: transcript wins on conflict or when CRM is blank
  and transcript reveals something on that specific field's topic; CRM value stands as-is
  when transcript is silent on that topic — and critically, content is never moved across
  fields (a stated metric never gets creatively repurposed into decision_criteria just
  because nothing else was said there).
- **Pass 2a — Data integrity check** (`src/prompts/dataIntegrityCheck.ts`). Verifies `arr`,
  `close_date`, `forecast_category`, and `stage` against the transcript — pure verification,
  no risk judgment, so it can be a stricter/narrower task than pass 2b. Each field gets
  `not_discussed` / `consistent` / `contradicted`, with evidence. Guardrails prevent
  overcalling "contradicted" on ordinary pending steps (a price objection isn't a stated
  number; a pending security review doesn't undo an otherwise-accurate stage).
- **Pass 2b — Risk tiering + recommended action** (`src/prompts/riskAssessment.ts`). Takes
  pass 1's extraction, pass 2a's integrity results, CRM deal metadata, and the *raw*
  transcript (not just the pass-1 summary — tone/urgency that doesn't map to a MEDDPICC slot
  still matters, e.g. "I don't have a hard deadline anymore"). Produces `risk_tier`,
  `reasoning`, `recommended_action` together, since they're grounded in the same evidence.

Full tier logic (data integrity overrides, MEDDPICC stage-appropriateness, close-proximity
rules) is documented in detail in `RISK_TIER_LOGIC.md`, kept current as the prompts evolved.

**Self-consistency (majority vote) on pass 2b only** (`src/selfConsistency.ts`,
`src/pipeline.ts`): pass 2b runs 9x concurrently per deal; the modal `risk_tier` wins, ties
break toward the more severe tier. Added because this runs daily against mostly-unchanged
data — a single-sample tier is a coin flip on borderline deals, unacceptable for something
reps see change day to day. Reduces but doesn't fully eliminate flip risk on deals that are
genuinely near a tier boundary in the model's own judgment; more samples narrow the margin
without ever fully guaranteeing determinism on a real 50/50 case. Pass 1 and 2a run once —
they're closer to objective extraction/verification and haven't shown the same variance.

**Call volume**: 16 deals × (1 + 1 + 9) = 176 calls per full batch. Still trivial at this
volume/frequency — this isn't a live/interactive agent, it runs against forecasted pipeline
periodically.

**Batch orchestration**: sequential loop (`src/index.ts`), each deal wrapped in its own
try/catch so one failure doesn't kill the batch. Supports `npm start -- <deal_id> ...` to
spot-check a subset without touching the full-batch output files — used heavily during
tuning. A run where every deal fails (e.g. an API outage) leaves the last good `output/`
files untouched rather than overwriting them with an empty result.

**Output validation**: zod schemas parsed directly against each tool-call response at the API
boundary (`src/anthropic.ts`) — throws on any mismatch. Each call retries up to 3 times on
error (API failure or malformed output) before giving up; the 9-way pass-2b vote additionally
tolerates individual sample failures via `Promise.allSettled`, only failing a deal if every
sample errors.

**recommended_action differentiation by tier**: not a fixed template per tier — the model is
given content rules instead (must name a concrete, evidence-grounded next step; if a data
integrity issue is driving the tier, explicitly state the field is wrong, cite the evidence,
and name the corrected value; otherwise target the specific gap/signal driving the tier). In
practice this produces real variation in *kind*, not just tone — correction actions,
gap-closing actions, and escalation asks all show up depending on the actual driver.

**Salesforce write-back**: mocked, not a live integration (`src/salesforceWriteback.ts`) —
the sample data has no real Salesforce record Ids, so `deal_id` stands in as an assumed
external ID field (`External_Deal_Id__c`). Output is shaped to drop directly into
`conn.sobject("Opportunity").upsert(records, "External_Deal_Id__c")` via jsforce once pointed
at a real org.

## What we'd change with more time

- Push self-consistency further (more than 9 samples) on the small number of deals that
  remain genuinely near a tier boundary — diminishing returns, but not zero returns.
- Real Salesforce integration instead of a mocked payload — auth, real Opportunity Ids,
  actual upsert calls.
- Fold in email thread data alongside call transcripts (explicitly out of scope for this
  build; transcripts only).
- A harder numeric cutoff option for the close-proximity threshold, if reproducibility
  across runs matters more than natural-language judgment at the boundary — currently
  applied "in spirit" by the model rather than as a strict `>=`/`<` comparison.
- Concurrent batch execution instead of sequential, if this ever needs to scale well past
  16 deals — not needed at current volume.
