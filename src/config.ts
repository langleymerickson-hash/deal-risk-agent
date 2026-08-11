/**
 * The reference date risk assessment measures "days to close" against. Defaults to
 * real wall-clock time for live runs against current CRM data. This sample dataset's
 * most recent logged activity is 2026-07-25, so it's a fixture snapshotted around
 * late July 2026 — override via ANALYSIS_DATE so day-to-close math stays meaningful
 * (and reproducible) against dates that are otherwise already in the past.
 */
export const ANALYSIS_DATE: Date = process.env.ANALYSIS_DATE
  ? new Date(`${process.env.ANALYSIS_DATE}T00:00:00Z`)
  : new Date();

export function daysUntil(isoDate: string): number {
  const target = new Date(`${isoDate}T00:00:00Z`);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - ANALYSIS_DATE.getTime()) / msPerDay);
}
