// Pure ingest decision rules — no fetch, no env vars, so these are unit-tested
// directly (see rules_test.ts) instead of only ever being exercised by a live run.

// why one today's-market-watch row should be dropped, or null if it's fine
export function priceRowIssue(
  r: { symbol: string; close: number | null; prevClose: number | null; high: number | null; low: number | null },
): string | null {
  if (r.close == null || r.close <= 0) return `${r.symbol}: close=${r.close}`;
  if (r.high != null && r.low != null && r.high < r.low) return `${r.symbol}: high<low`;
  if (r.prevClose && Math.abs(r.close / r.prevClose - 1) > 0.25) return `${r.symbol}: ${r.prevClose}->${r.close} moved >25%`;
  return null;
}

export function shouldFireAlert(condition: string, threshold: number, close: number): boolean {
  if (condition === "below") return close <= threshold;
  if (condition === "above") return close >= threshold;
  return false;
}
