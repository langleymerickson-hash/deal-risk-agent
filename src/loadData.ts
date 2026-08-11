import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import type { Deal, DealRow, Transcript } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

export async function loadDeals(): Promise<Deal[]> {
  const csvRaw = await readFile(path.join(DATA_DIR, "deals.csv"), "utf-8");
  const rows: DealRow[] = parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
  });

  return Promise.all(
    rows.map(async (row) => {
      const transcriptPath = path.join(
        DATA_DIR,
        `transcript_deal_${row.deal_id}.json`
      );
      const transcriptRaw = await readFile(transcriptPath, "utf-8");
      const transcript: Transcript = JSON.parse(transcriptRaw);
      return { row, transcript };
    })
  );
}

export function formatTranscript(transcript: Transcript): string {
  const speakerLabel = new Map(
    transcript.parties.map((p) => [p.speakerId, `${p.name} (${p.affiliation}, ${p.title})`])
  );

  const lines: string[] = [];
  for (const turn of transcript.transcript) {
    const label = speakerLabel.get(turn.speakerId) ?? turn.speakerId;
    const text = turn.sentences.map((s) => s.text).join(" ");
    lines.push(`${label}: ${text}`);
  }
  return lines.join("\n");
}
