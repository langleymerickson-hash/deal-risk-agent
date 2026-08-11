# Deal Risk & Next-Best-Action Agent

An agent that reads a CRM pipeline export and the sales call transcripts behind it, then
produces a per-deal risk tier (Red/Yellow/Green), an evidence-grounded explanation, and a
concrete next step for the deal owner — reconciling what the rep logged in the CRM against
what was actually said on the call.

Built as a self-education project and field-note companion piece for
[CascadeGTM](https://cascadegtm.com) — the write-up walks through the decisions below, not
just the final code. This repo is that code.

**The data is fully synthetic** — 16 fabricated deals, companies, people, and call
transcripts. No real customer, prospect, or company data is used anywhere.

## Why this exists

Deal risk assessment in most CRMs is either manual (a rep's gut-check field, updated
inconsistently) or missing entirely. Meanwhile the actual signal — a prospect saying "I don't
have a hard deadline anymore," a rep never logging a competitor the buyer named out loud, an
economic buyer who's never actually seen the proposal — is sitting in call transcripts nobody
re-reads once the deal moves forward.

This agent treats the transcript as ground truth, reconciles it against the CRM record, and
surfaces the gap as a structured, forecast-ready signal — one that's also meant to feed back
into the CRM record itself (see `src/salesforceWriteback.ts`), improving the data quality that
downstream ML forecasting tools (Clari, Gong, etc.) depend on.

## How it works

Three model calls per deal:

1. **MEDDPICC extraction** — reconciles the CRM's rep-entered MEDDPICC fields against the
   transcript, sentence by sentence.
2. **Data integrity check** — verifies the CRM's `arr`, `close_date`, `forecast_category`, and
   `stage` against anything the transcript actually says about them.
3. **Risk tiering + recommended action** — combines both of the above with the raw transcript
   to assign Red/Yellow/Green, an evidence-cited reason, and a specific next step. Run 9x per
   deal with majority-vote resolution, since this is meant to run daily and a single-sample
   tier can flip on borderline deals from run to run alone.

Full architecture rationale: [`DESIGN_DECISIONS.md`](DESIGN_DECISIONS.md).
Full risk-tier rule set, as actually implemented: [`RISK_TIER_LOGIC.md`](RISK_TIER_LOGIC.md).

## Quickstart

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com) (API Console
credits — a separate product from a Claude.ai/Pro subscription).

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `ANTHROPIC_API_KEY` to your key. Then:

```bash
npm start
```

This runs all 16 sample deals sequentially and writes `output/deal_risk_output.json` (matching
[`output_schema.json`](output_schema.json) exactly) and `output/salesforce_updates.json` (a
mocked, upsert-ready Salesforce write-back payload).

To spot-check a subset instead of the full batch:

```bash
npm start -- 1046 1047
```

Sample output from a real run is already committed at `output/deal_risk_output.json` if you
just want to see results without running it yourself.

## Project structure

```
data/                        16 synthetic CRM rows + matching call transcripts
output_schema.json            Exact required output shape
src/
  types.ts                    Zod schemas for every model I/O boundary
  loadData.ts                 CSV + transcript loading
  anthropic.ts                Structured tool-call wrapper (retries, zod validation)
  config.ts                   ANALYSIS_DATE handling for days-to-close calibration
  prompts/
    meddpiccExtraction.ts     Pass 1
    dataIntegrityCheck.ts     Pass 2a
    riskAssessment.ts         Pass 2b
  selfConsistency.ts          Majority-vote resolution across pass 2b samples
  pipeline.ts                 Per-deal orchestration
  salesforceWriteback.ts      Mocked Opportunity upsert payload builder
  index.ts                    Batch entrypoint
output/                       Generated per run (two sample files committed, rest gitignored)
```

## Known limitations

- Self-consistency reduces but doesn't eliminate tier-flip risk on deals genuinely near a
  boundary in the model's own judgment (verified via repeated full-batch A/B runs during
  development).
- Salesforce write-back is a mocked payload, not a live integration.
- Transcript data only — no email thread data yet (see `DESIGN_DECISIONS.md`).
- `ANALYSIS_DATE` must be pinned for this fixed/historical sample dataset; a live production
  run against current CRM data would default to real wall-clock time instead.

See `DESIGN_DECISIONS.md` → "What we'd change with more time" for the fuller list.
