import { callStructured } from "../anthropic.js";
import { formatTranscript } from "../loadData.js";
import { DataIntegrityCheckSchema, type Deal, type DataIntegrityCheck } from "../types.js";

const SYSTEM_PROMPT = `You verify whether four CRM fields on a deal — arr, close_date, \
forecast_category, and stage — are contradicted by anything actually said on the call transcript. \
This is a pure verification task: you are not judging deal risk, just comparing two sources.

## Reference: stage definitions
- Discovery: meeting scheduled through meeting held.
- Evaluation: meeting held, client is evaluating the product.
- Proposal: client has received a contract with commercial terms, ready for signature.
- Negotiation: client has returned redlines on the contract or begun negotiating commercials \
(price, packaging, etc).

## Reference: forecast_category definitions
- Estimate: 3rd/lowest tier of forecast quality. Most new deals start here.
- Best Case: 2nd tier. Typical to win deals from this tier.
- Commit: 1st/top tier. Deal is assumed to close on or before close_date, treated as nearly won.

## For each of the 4 fields, decide one of:
- "not_discussed": the transcript never makes a specific, material statement about this field's \
actual value. This is the default — a vague or approximate mention ("sometime next month," "in \
that range") does NOT count as discussed. Most fields on most calls will be not_discussed.
- "consistent": the transcript makes a specific statement about this field, and it matches the \
CRM value (e.g. transcript confirms the price discussed matches arr, or describes a \
sales-process state that matches the CRM stage).
- "contradicted": the transcript makes a specific statement about this field that clearly \
conflicts with the CRM value (e.g. transcript states a deal value different from arr; transcript \
states an expected close date/timeframe different from close_date; transcript reveals a \
confidence level inconsistent with forecast_category per the definitions above; transcript \
describes a sales-process state inconsistent with the CRM stage per the definitions above).

Set evidence to the specific quote or close paraphrase that supports "consistent" or \
"contradicted". Leave evidence null for "not_discussed". Be conservative — only mark \
"contradicted" when the conflict is clear and specific, not inferred or approximate.

## Critical distinction for arr: an objection is not a stated number
Only mark arr "contradicted" when the transcript states an actual competing dollar figure — a \
number that differs from the CRM's arr. A price objection or budget pushback ("the number is \
higher than we modeled," "this is more than we expected") is a real risk signal, but it is NOT an \
arr contradiction unless a specific different figure is actually stated. If no number is given at \
all, the correct status is "not_discussed", not "contradicted" — regardless of how negative the \
sentiment about price is.
- NOT a contradiction: the prospect says the price is too high or over budget, without ever \
stating what number they expected or were quoted.
- IS a contradiction: the prospect states a specific dollar figure (or one clearly discussed on \
the call) that differs from the CRM's arr.

## Critical distinction for stage: a pending item is not a wrong stage
A deal can correctly be in a stage while a SEPARATE gating step (security review, board \
sign-off, economic buyer sign-off, an SE confirming integration scope) is still pending — that's \
normal and does not make the stage wrong. Only mark stage "contradicted" when the transcript \
shows the STAGE-DEFINING ACTION ITSELF is missing, not when some other unrelated item hasn't \
closed out yet.
- NOT a contradiction: stage is Negotiation, and the transcript or other CRM fields confirm \
redlines have already been exchanged or commercials are being negotiated — even if security \
review or board sign-off is separately still pending. The redlines being underway is what proves \
Negotiation; other pending items don't undo that.
- IS a contradiction: stage is Negotiation, but the transcript shows no contract has been sent \
and the client is still comparing vendors — that describes Evaluation, not Negotiation.
- NOT a contradiction: stage is Evaluation, and an economic buyer hasn't personally reviewed the \
proposal yet — economic buyer engagement is a MEDDPICC fact, not a stage fact. Evaluation only \
requires that a meeting has been held and the client is evaluating the product.

## Critical distinction for forecast_category: one pending step is not lost confidence
A single ordinary remaining step (an unfinished security review, a scheduled sign-off, an SE \
confirming scope) does NOT by itself contradict forecast_category, even for Commit. Only mark \
forecast_category "contradicted" when the transcript reveals genuine doubt about winning or \
hitting the timeline.
- NOT a contradiction: forecast_category is Commit, and the transcript mentions one normal \
remaining procedural step with no sign of hesitation from the buyer.
- IS a contradiction: forecast_category is Commit, but the transcript reveals the buyer is still \
comparing multiple vendors with no stated preference, or budget has not actually been approved.`;

function buildPrompt(deal: Deal): string {
  const { row, transcript } = deal;

  return `## CRM fields to verify (deal ${row.deal_id}, ${row.company_name})

arr: ${row.arr}
close_date: ${row.close_date}
forecast_category: ${row.forecast_category}
stage: ${row.stage}

## Call transcript

${formatTranscript(transcript)}

## Task

For each of the 4 fields above, determine its status against the transcript following your \
system instructions.`;
}

export async function checkDataIntegrity(deal: Deal): Promise<DataIntegrityCheck> {
  return callStructured({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(deal),
    schema: DataIntegrityCheckSchema,
    toolName: "record_data_integrity_check",
    toolDescription:
      "Records whether arr, close_date, forecast_category, and stage are each consistent with, contradicted by, or simply not discussed in the call transcript.",
  });
}
