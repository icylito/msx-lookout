// Shared MSX access: the one place that knows how to talk to msx.om's hidden
// JSON API (APIPage.aspx) and RSS feeds. Every ingestion path (seed, backfill,
// ingest, refresh, the app's gap-fill) goes through this instead of hand-rolling
// its own fetch + parsing.
//
// Deployed the same way excel.ts is: each Edge Function directory that needs
// this keeps a 4-line `./msx-client.ts` stub re-exporting `../../../msx-client.ts`,
// purely so local type-checking resolves the import — see that stub for why.

export const MSX_BASE = "https://www.msx.om";
export const UA = "MSX-Lookout/0.1 (personal project)";

// Regular, Parallel, Under Monitoring (4 = Bonds, deliberately skipped everywhere)
export const MARKETS = [1, 2, 3] as const;

// company.market (MSX's own market name string) -> the numeric id MSX's API expects
export const MARKET_NUM: Record<string, number> = {
  "Regular Market": 1,
  "Parallel Market": 2,
  "Under_Monitoring Market": 3,
};

export const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
export const int = (v: string | null | undefined) => (v == null || v === "" ? null : Math.round(Number(v)));

// MSX's weekend is Friday/Saturday, not Saturday/Sunday. The one place this rule
// is allowed to exist — every caller that needs "is this a trading day" imports it.
export function isTradingDay(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow !== 5 && dow !== 6;
}

// MSX responses come double-encoded: {"d":"<json string>"}, history adds a
// "|asc|0" tail after the real JSON, hence the slice-to-last-brace. Retries with
// backoff before a transient blip (a dropped connection, MSX momentarily slow)
// counts as a real problem — only a failure that survives every attempt is thrown.
export async function msxPost(method: string, sHiddens: string, attempts = 3): Promise<any> {
  let lastErr: Error = new Error("unreachable");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${MSX_BASE}/APIPage.aspx/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": UA },
        body: JSON.stringify({ sHiddens }),
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const d: string = (await res.json()).d;
      return JSON.parse(d.slice(0, d.lastIndexOf("}") + 1));
    } catch (e) {
      lastErr = e as Error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 3 ** i)); // 500ms, then 1.5s
    }
  }
  throw new Error(`${method} failed after ${attempts} attempts: ${lastErr.message}`);
}

// today's/this month's market watch for one market segment (GetPageData)
export async function fetchMarketWatch(market: number): Promise<any> {
  const data = await msxPost("GetPageData", `${market}||false||||0`);
  if (data.Status !== "Success") throw new Error(`GetPageData market ${market}: ${data.Status}`);
  return data;
}

// one specific past day's history for one market segment (GetPageDataHistory)
export function fetchHistoryDay(market: number, date: string): Promise<any> {
  return msxPost("GetPageDataHistory", `8|${market}|${date}|${date}`);
}

// last calendar month's history for one market segment — used for sector data
export function fetchMonthHistory(market: number): Promise<any> {
  return msxPost("GetPageDataHistory", `1M|${market}||`);
}
