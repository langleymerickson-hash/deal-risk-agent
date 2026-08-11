import type { RiskAssessment } from "./types.js";

const SEVERITY_ORDER: Record<RiskAssessment["risk_tier"], number> = {
  Green: 0,
  Yellow: 1,
  Red: 2,
};

export interface MajorityVoteResult {
  chosen: RiskAssessment;
  voteCounts: Record<RiskAssessment["risk_tier"], number>;
}

/**
 * Picks the modal risk_tier across N independent samples of the same call, then
 * returns one full sample (reasoning + action) that matches that tier, rather than
 * synthesizing new text — keeps the output grounded in something the model actually
 * said. Ties between tiers break toward the more severe one: for a risk-monitoring
 * tool, a false Yellow is a smaller mistake than a missed Red.
 */
export function pickByMajorityVote(samples: RiskAssessment[]): MajorityVoteResult {
  const voteCounts: MajorityVoteResult["voteCounts"] = { Red: 0, Yellow: 0, Green: 0 };
  for (const s of samples) voteCounts[s.risk_tier]++;

  const maxVotes = Math.max(...Object.values(voteCounts));
  const tiedTiers = (Object.keys(voteCounts) as RiskAssessment["risk_tier"][]).filter(
    (tier) => voteCounts[tier] === maxVotes
  );
  const winningTier = tiedTiers.sort((a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a])[0];

  const chosen = samples.find((s) => s.risk_tier === winningTier)!;
  return { chosen, voteCounts };
}
