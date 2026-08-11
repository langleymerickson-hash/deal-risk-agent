import type { DealRiskOutput } from "./types.js";

/**
 * The sample data has no real Salesforce Ids, so this assumes deal_id is synced to
 * Salesforce as an external ID field on Opportunity (a standard CRM sync pattern).
 * This payload is shaped to drop straight into:
 *   conn.sobject("Opportunity").upsert(records, externalIdField)
 * via jsforce, once pointed at a real org. For this build it's written to
 * output/salesforce_updates.json instead of calling any API.
 */

export interface SalesforceOpportunityUpdate {
  External_Deal_Id__c: string;
  Risk_Tier__c: "Red" | "Yellow" | "Green";
  Risk_Reasoning__c: string;
  Recommended_Action__c: string;
  MEDDPICC_Metrics__c: string | null;
  MEDDPICC_Economic_Buyer__c: string | null;
  MEDDPICC_Decision_Criteria__c: string | null;
  MEDDPICC_Decision_Process__c: string | null;
  MEDDPICC_Paper_Process__c: string | null;
  MEDDPICC_Identify_Pain__c: string | null;
  MEDDPICC_Champion__c: string | null;
  MEDDPICC_Competition__c: string | null;
  Missing_MEDDPICC_Fields__c: string | null;
}

export interface SalesforceWritebackPayload {
  sobject: "Opportunity";
  externalIdField: "External_Deal_Id__c";
  records: SalesforceOpportunityUpdate[];
}

export function buildSalesforceWriteback(
  results: DealRiskOutput[]
): SalesforceWritebackPayload {
  return {
    sobject: "Opportunity",
    externalIdField: "External_Deal_Id__c",
    records: results.map((r) => ({
      External_Deal_Id__c: r.deal_id,
      Risk_Tier__c: r.risk_tier,
      Risk_Reasoning__c: r.reasoning,
      Recommended_Action__c: r.recommended_action,
      MEDDPICC_Metrics__c: r.meddpicc.metrics,
      MEDDPICC_Economic_Buyer__c: r.meddpicc.economic_buyer,
      MEDDPICC_Decision_Criteria__c: r.meddpicc.decision_criteria,
      MEDDPICC_Decision_Process__c: r.meddpicc.decision_process,
      MEDDPICC_Paper_Process__c: r.meddpicc.paper_process,
      MEDDPICC_Identify_Pain__c: r.meddpicc.identify_pain,
      MEDDPICC_Champion__c: r.meddpicc.champion,
      MEDDPICC_Competition__c: r.meddpicc.competition,
      Missing_MEDDPICC_Fields__c:
        r.flags.missing_data_fields.length > 0
          ? r.flags.missing_data_fields.join(";")
          : null,
    })),
  };
}
