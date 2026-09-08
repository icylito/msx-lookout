import { assertEquals } from "jsr:@std/assert@1";
import { FREQ_HOURS, isCadenceDue } from "./cadence.ts";

Deno.test("isCadenceDue: never run before -> always due", () => {
  assertEquals(isCadenceDue("daily", null, false).due, true);
});

Deno.test("isCadenceDue: force bypasses the gate even right after a run", () => {
  const justNow = new Date().toISOString();
  assertEquals(isCadenceDue("daily", justNow, true).due, true);
});

Deno.test("isCadenceDue: not due yet inside the daily window", () => {
  const oneHourAgo = new Date(Date.now() - 1 * 3_600_000).toISOString();
  const { due, hoursSince } = isCadenceDue("daily", oneHourAgo, false);
  assertEquals(due, false);
  assertEquals(Math.round(hoursSince), 1);
});

Deno.test("isCadenceDue: due once past the configured frequency", () => {
  const past = new Date(Date.now() - (FREQ_HOURS.daily + 1) * 3_600_000).toISOString();
  assertEquals(isCadenceDue("daily", past, false).due, true);
});

Deno.test("isCadenceDue: unknown frequency falls back to the daily threshold", () => {
  const past = new Date(Date.now() - (FREQ_HOURS.daily + 1) * 3_600_000).toISOString();
  assertEquals(isCadenceDue("bogus", past, false).due, true);
  const recent = new Date(Date.now() - 1 * 3_600_000).toISOString();
  assertEquals(isCadenceDue("bogus", recent, false).due, false);
});

Deno.test("isCadenceDue: 'never' is a hard off-switch, even with no prior run", () => {
  assertEquals(isCadenceDue("never", null, false).due, false);
  const longAgo = new Date(Date.now() - (FREQ_HOURS.monthly * 12 + 1) * 3_600_000).toISOString();
  assertEquals(isCadenceDue("never", longAgo, false).due, false);
});

Deno.test("isCadenceDue: 'never' can still be bypassed by an explicit force", () => {
  assertEquals(isCadenceDue("never", null, true).due, true);
});

Deno.test("isCadenceDue: unparseable last-run stamp is treated as never-ran, not a silent stall", () => {
  // Date.parse("nope") is NaN; NaN >= daily hours is false, so a corrupt stamp
  // would park ingest forever unless we treat it as "no last run".
  const r = isCadenceDue("daily", "not-a-date", false);
  assertEquals(r.due, true);
  assertEquals(r.hoursSince, Infinity);
});
