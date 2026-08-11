import { z } from "zod";

// --- Raw input shapes (data/deals.csv, data/transcript_deal_*.json) ---

export interface DealRow {
  deal_id: string;
  company_name: string;
  segment: string;
  arr: string;
  stage: string;
  days_in_stage: string;
  last_activity_date: string;
  close_date: string;
  owner: string;
  lead_source: string;
  deal_type: string;
  forecast_category: string;
  probability_pct: string;
  next_steps: string;
  rep_metrics: string;
  rep_economic_buyer: string;
  rep_decision_criteria: string;
  rep_decision_process: string;
  rep_paper_process: string;
  rep_identify_pain: string;
  rep_champion: string;
  rep_competition: string;
}

export interface TranscriptParty {
  speakerId: string;
  name: string;
  emailAddress: string;
  affiliation: "Internal" | "External";
  title: string;
}

export interface TranscriptSentence {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptTurn {
  speakerId: string;
  topic: string;
  sentences: TranscriptSentence[];
}

export interface Transcript {
  callId: string;
  callStartTime: string;
  durationSeconds: number;
  parties: TranscriptParty[];
  transcript: TranscriptTurn[];
}

export interface Deal {
  row: DealRow;
  transcript: Transcript;
}

// --- MEDDPICC ---

export const MEDDPICC_KEYS = [
  "metrics",
  "economic_buyer",
  "decision_criteria",
  "decision_process",
  "paper_process",
  "identify_pain",
  "champion",
  "competition",
] as const;

export type MeddpiccKey = (typeof MEDDPICC_KEYS)[number];

export const MeddpiccSchema = z.object({
  metrics: z.string().nullable(),
  economic_buyer: z.string().nullable(),
  decision_criteria: z.string().nullable(),
  decision_process: z.string().nullable(),
  paper_process: z.string().nullable(),
  identify_pain: z.string().nullable(),
  champion: z.string().nullable(),
  competition: z.string().nullable(),
});

export type Meddpicc = z.infer<typeof MeddpiccSchema>;

// --- Pass 1: MEDDPICC extraction ---

export const Pass1ExtractionSchema = z.object({
  meddpicc: MeddpiccSchema,
  missing_fields: z
    .array(z.enum(MEDDPICC_KEYS))
    .describe(
      "MEDDPICC keys that could not be determined from either the CRM row or the transcript."
    ),
  discrepancy_notes: z
    .array(z.string())
    .describe(
      "Notable conflicts between the CRM field and the transcript (e.g. a rep who didn't log a competitor the prospect named). Empty array if none."
    ),
});

export type Pass1Extraction = z.infer<typeof Pass1ExtractionSchema>;

// --- Pass 2a: data integrity check (CRM forecast fields vs transcript) ---

const FieldCheckSchema = z.object({
  status: z.enum(["not_discussed", "consistent", "contradicted"]),
  evidence: z
    .string()
    .nullable()
    .describe(
      "Quote or close paraphrase from the transcript supporting this status. Null only when status is not_discussed."
    ),
});

export const DataIntegrityCheckSchema = z.object({
  arr: FieldCheckSchema,
  close_date: FieldCheckSchema,
  forecast_category: FieldCheckSchema,
  stage: FieldCheckSchema,
});

export type DataIntegrityCheck = z.infer<typeof DataIntegrityCheckSchema>;

// --- Pass 2b: risk tiering + recommended action ---

export const RiskAssessmentSchema = z.object({
  risk_tier: z.enum(["Red", "Yellow", "Green"]),
  reasoning: z
    .string()
    .describe(
      "1-2 sentences, must cite specific evidence from the data provided, not a generic statement."
    ),
  recommended_action: z
    .string()
    .describe("1 sentence, a specific next step for the rep to take."),
});

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

// --- Final per-deal output (matches output_schema.json exactly) ---

export const DealRiskOutputSchema = z.object({
  deal_id: z.string(),
  company: z.string(),
  risk_tier: z.enum(["Red", "Yellow", "Green"]),
  reasoning: z.string(),
  recommended_action: z.string(),
  meddpicc: MeddpiccSchema,
  flags: z.object({
    missing_data_fields: z.array(z.enum(MEDDPICC_KEYS)),
  }),
});

export type DealRiskOutput = z.infer<typeof DealRiskOutputSchema>;
