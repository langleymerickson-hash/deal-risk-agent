import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeals } from "./loadData.js";
import { runDealPipeline } from "./pipeline.js";
import { buildSalesforceWriteback } from "./salesforceWriteback.js";
import type { DealRiskOutput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");

async function main() {
  // Optional: pass deal_ids as CLI args (e.g. `npm start -- 1047`) to spot-check
  // a subset without overwriting the full batch output files.
  const filterIds = process.argv.slice(2);
  const isSpotCheck = filterIds.length > 0;

  const allDeals = await loadDeals();
  const deals = isSpotCheck
    ? allDeals.filter((d) => filterIds.includes(d.row.deal_id))
    : allDeals;
  console.log(`Loaded ${deals.length} deal(s). Running pipeline sequentially...\n`);

  const results: DealRiskOutput[] = [];
  const errors: { deal_id: string; error: string }[] = [];

  for (const deal of deals) {
    process.stdout.write(`  deal ${deal.row.deal_id} (${deal.row.company_name})... `);
    try {
      const result = await runDealPipeline(deal);
      results.push(result);
      console.log(`${result.risk_tier}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ deal_id: deal.row.deal_id, error: message });
      console.log(`FAILED: ${message}`);
    }
  }

  if (isSpotCheck) {
    console.log(`\n${JSON.stringify(results, null, 2)}`);
    return;
  }

  if (results.length === 0) {
    console.log(`\nAll ${deals.length} deal(s) failed — leaving existing output/ files untouched.`);
    for (const e of errors) console.log(`  ${e.deal_id}: ${e.error}`);
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  await writeFile(
    path.join(OUTPUT_DIR, "deal_risk_output.json"),
    JSON.stringify(results, null, 2)
  );

  const writeback = buildSalesforceWriteback(results);
  await writeFile(
    path.join(OUTPUT_DIR, "salesforce_updates.json"),
    JSON.stringify(writeback, null, 2)
  );

  console.log(`\nDone. ${results.length}/${deals.length} deals processed successfully.`);
  const byTier = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.risk_tier] = (acc[r.risk_tier] ?? 0) + 1;
    return acc;
  }, {});
  console.log("By tier:", byTier);

  if (errors.length > 0) {
    console.log(`\n${errors.length} deal(s) failed:`);
    for (const e of errors) console.log(`  ${e.deal_id}: ${e.error}`);
  }

  console.log(`\nWrote output/deal_risk_output.json and output/salesforce_updates.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
