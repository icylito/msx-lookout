// Shared "is it time to run yet" gate for the scheduled Edge Functions. The
// cron trigger itself always fires at its finest granularity (ingest/refresh
// both run on a fixed schedule); this decides whether to actually do work each
// time it fires, based on the user-configurable cadence in app_settings.
//
// Deployed the same way excel.ts / msx-client.ts are: each Edge Function
// directory that needs this keeps a 4-line `./cadence.ts` stub re-exporting
// `../../../cadence.ts`, purely so local type-checking resolves the import.

export const FREQ_HOURS: Record<string, number> = { daily: 20, weekly: 150, monthly: 648 };

export function isCadenceDue(
  freq: string,
  lastRunIso: string | null,
  force: boolean,
): { due: boolean; hoursSince: number } {
  const parsed = lastRunIso ? Date.parse(lastRunIso) : NaN;
  // corrupt/unparseable stamps must not park the job forever (NaN >= hours is false)
  const hoursSince = Number.isFinite(parsed) ? (Date.now() - parsed) / 3_600_000 : Infinity;
  // "never" is a hard off-switch — force can still be used for an explicit manual send
  const due = force || (freq !== "never" && hoursSince >= (FREQ_HOURS[freq] ?? FREQ_HOURS.daily));
  return { due, hoursSince };
}
