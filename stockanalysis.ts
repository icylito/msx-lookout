// Best-effort dividend history from stockanalysis.com — the one third-party source that answers
// a plain server-side request (MSX's own reports page is reCAPTCHA-gated; investing.com is
// Cloudflare-walled). This is a CONVENIENCE CACHE, never load-bearing: any failure (block, ban,
// shape change) is swallowed by the caller and the UI falls back to a plain link-out. We do ONE
// GET per ticker, no headless browser, no captcha-solving — if it stops working we take the L.
//
// Deployed like msx-client.ts: each Edge Function directory that needs this keeps a 4-line
// `./stockanalysis.ts` stub re-exporting `../../../stockanalysis.ts` so local type-checking resolves.

export const SA_BASE = "https://stockanalysis.com";

// stockanalysis keys MSX companies by the exact MSX ticker (e.g. /quote/msm/BKMB/) — no mapping needed.
export const saDividendUrl = (ticker: string) => `${SA_BASE}/quote/msm/${encodeURIComponent(ticker)}/dividend/`;

export type DividendRow = {
  ex_date: string; // ISO YYYY-MM-DD
  amount: number; // cash per share (OMR)
  record_date: string | null;
  pay_date: string | null;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "Mar 18, 2026" -> "2026-03-18"; null if it isn't a date in that shape
function toIso(s: string): string | null {
  const m = s.match(/([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[2].padStart(2, "0")}`;
}

// "0.018 OMR" -> 0.018; null if there's no number
function toAmount(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function stripCell(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;|&#\d+;/g, " ").trim();
}

// Pure + unit-testable. Deliberately structural, not class-based: stockanalysis is Svelte and its
// class hashes change on every rebuild, so we key off the *shape* of a dividend row instead —
// a row whose first cell is a date and second cell is a number. A changed layout simply yields
// [] (fields go null), which the caller treats as "no cached data -> show the link".
export function parseDividendRows(html: string): DividendRow[] {
  // narrow to the dividend history table when we can find its header, else scan the whole doc
  let scope = html;
  const hIdx = html.search(/Ex-Dividend Date/i);
  if (hIdx >= 0) {
    const start = html.lastIndexOf("<table", hIdx);
    const end = html.indexOf("</table>", hIdx);
    if (start >= 0 && end > start) scope = html.slice(start, end);
  }
  const rows: DividendRow[] = [];
  const seen = new Set<string>();
  for (const tr of scope.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripCell(c[1]));
    if (cells.length < 2) continue;
    const ex = toIso(cells[0]);
    const amount = toAmount(cells[1] ?? "");
    if (!ex || amount == null || seen.has(ex)) continue; // not a dividend row / dupe
    seen.add(ex);
    rows.push({
      ex_date: ex,
      amount,
      record_date: cells[2] ? toIso(cells[2]) : null,
      pay_date: cells[3] ? toIso(cells[3]) : null,
    });
  }
  return rows;
}

// The only network call. Throws on any non-200 so the caller's try/catch can take the L for this ticker.
export async function fetchDividends(ticker: string): Promise<DividendRow[]> {
  const res = await fetch(saDividendUrl(ticker), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "text/html",
    },
  });
  if (!res.ok) throw new Error(`stockanalysis ${ticker}: HTTP ${res.status}`);
  return parseDividendRows(await res.text());
}
