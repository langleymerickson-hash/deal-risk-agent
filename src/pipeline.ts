import { checkDataIntegrity } from "./prompts/dataIntegrityCheck.js";
import { extractMeddpicc } from "./prompts/meddpiccExtraction.js";
import { assessRisk } from "./prompts/riskAssessment.js";
import { pickByMajorityVote } from "./selfConsistency.js";
import type { Deal, DealRiskOutput } from "./types.js";

// Risk tiering (pass 2b) is a judgment call, not extraction — it's the one step prone
// to run-to-run flip-flopping on borderline deals. Since this runs daily against
// mostly-unchanged data, sample it multiple times and take the majority tier instead
// of trusting a single roll. Pass 1 and pass 2a are more objective and don't need this.
const RISK_TIER_SAMPLES = 9;

export async function runDealPipeline(deal: Deal): Promise<DealRiskOutput> {
  // Pass 1 (MEDDPICC extraction) and pass 2a (data integrity check) are independent —
  // neither needs the other's output — so they run concurrently before pass 2b tiering.
  const [extraction, integrity] = await Promise.all([
    extractMeddpicc(deal),
    checkDataIntegrity(deal),
  ]);

  // allSettled, not all: one malformed sample out of 5 shouldn't fail an otherwise-
  // healthy majority vote. Only fail the deal if every sample errors.
  const settled = await Promise.allSettled(
    Array.from({ length: RISK_TIER_SAMPLES }, () => assessRisk(deal, extraction, integrity))
  );
  const samples = settled
    .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof assessRisk>>> => s.status === "fulfilled")
    .map((s) => s.value);
  if (samples.length === 0) {
    throw settled.find((s) => s.status === "rejected")!.reason;
  }

  const { chosen: risk, voteCounts } = pickByMajorityVote(samples);
  if (samples.length < RISK_TIER_SAMPLES || voteCounts[risk.risk_tier] < samples.length) {
    console.log(
      `\n    (${deal.row.deal_id} tier votes: ${JSON.stringify(voteCounts)}` +
        (samples.length < RISK_TIER_SAMPLES
          ? `, ${RISK_TIER_SAMPLES - samples.length} sample(s) failed`
          : "") +
        `)`
    );
  }

  return {
    deal_id: deal.row.deal_id,
    company: deal.row.company_name,
    risk_tier: risk.risk_tier,
    reasoning: risk.reasoning,
    recommended_action: risk.recommended_action,
    meddpicc: extraction.meddpicc,
    flags: {
      missing_data_fields: extraction.missing_fields,
    },
  };
}
