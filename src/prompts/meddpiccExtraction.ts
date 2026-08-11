import { callStructured } from "../anthropic.js";
import { formatTranscript } from "../loadData.js";
import { Pass1ExtractionSchema, type Deal, type Pass1Extraction } from "../types.js";

const SYSTEM_PROMPT = `You extract MEDDPICC fields for a B2B sales deal from two sources: a CRM row \
(fields entered by the rep) and a call transcript (Gong-style export, ground truth for what was \
actually said on calls).

The 8 MEDDPICC fields are:
- metrics: quantifiable business impact/value the deal is expected to deliver
- economic_buyer: the person with budget authority to approve the purchase
- decision_criteria: the formal/informal criteria the buying committee will judge options on
- decision_process: the steps/stages the buyer's organization will go through to decide
- paper_process: procurement/legal/security steps needed to get a contract signed
- identify_pain: the core business pain driving the evaluation
- champion: an internal advocate at the prospect who is selling on your behalf
- competition: any competing vendor(s) or alternatives (including "do nothing") under consideration

Reconciliation rule (this is the most important instruction):
- If the CRM field and the transcript conflict, OR the CRM field is blank and the transcript \
reveals something relevant to THAT SPECIFIC field's topic, the transcript wins — use the \
transcript's information and discard the CRM value.
- If the CRM field has a value and the transcript simply never touches that exact field's topic, \
the CRM value stands as-is — carry it over verbatim or near-verbatim. Do not replace it with \
transcript content that belongs to a different MEDDPICC field just because it seems related or \
salient. For example, if the transcript states a metric/number, that content belongs in \
metrics only — it must never be substituted into decision_criteria, identify_pain, or any other \
field even if no other content is available for that field. Each of the 8 fields is a separate \
bucket; never move content across buckets.
- Whenever the transcript overrides or reveals something the CRM value didn't have, add a short \
note to discrepancy_notes explaining the conflict (e.g. "rep logged no competitor but prospect \
named Meadowlight as a competing vendor"). Only include notes that are materially interesting — \
not every filled-in blank needs a note, only ones that reveal risk (e.g. an undisclosed \
competitor, a stated budget objection, a walked-back timeline).
- A field only belongs in missing_fields if it cannot be determined from the CRM row OR the \
transcript. If either source has a real value, it is not missing.
- Every string value should be concise (a phrase or short sentence), grounded in what the CRM row \
or transcript actually said — do not invent specifics neither source supports, and do not \
cross-contaminate one field's content into another.`;

function buildPrompt(deal: Deal): string {
  const { row, transcript } = deal;

  const crmMeddpicc = `metrics: ${row.rep_metrics || "(blank)"}
economic_buyer: ${row.rep_economic_buyer || "(blank)"}
decision_criteria: ${row.rep_decision_criteria || "(blank)"}
decision_process: ${row.rep_decision_process || "(blank)"}
paper_process: ${row.rep_paper_process || "(blank)"}
identify_pain: ${row.rep_identify_pain || "(blank)"}
champion: ${row.rep_champion || "(blank)"}
competition: ${row.rep_competition || "(blank)"}`;

  return `## CRM row (deal ${row.deal_id}, ${row.company_name})

${crmMeddpicc}

## Call transcript

${formatTranscript(transcript)}

## Task

Produce the reconciled MEDDPICC extraction for this deal following the reconciliation rule in \
your system instructions.`;
}

export async function extractMeddpicc(deal: Deal): Promise<Pass1Extraction> {
  return callStructured({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(deal),
    schema: Pass1ExtractionSchema,
    toolName: "record_meddpicc_extraction",
    toolDescription:
      "Records the reconciled MEDDPICC extraction for a deal, plus which fields remain undetermined and any CRM/transcript discrepancies worth flagging.",
  });
}
