// one-time historical backfill of stock_prices from MSX
// usage: deno run --allow-net --allow-env --env-file=.env backfill.ts [from] [to]
// dates as YYYY-MM-DD; defaults to the last 2 years through today
import { fetchHistoryDay, int, isTradingDay, MARKETS, num } from "./msx-client.ts";

const DELAY_MS = 600;

const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env");

type PriceRow = {
  ticker: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  turnover: number | null;
  trades: number | null;
  source: string;
  period_type: string;
};

// "06/07/2026" (dd/MM/yyyy) -> "2026-07-06"
function ltdToIso(ltd: string | null): string | null {
  if (!ltd) return null;
  const [d, m, y] = ltd.split("/");
  return `${y}-${m}-${d}`;
}

// all price rows for one trading day, or [] if market was closed
async function fetchDay(date: string): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  for (const m of MARKETS) {
    const data = await fetchHistoryDay(m, date);
    if (data.Status !== "Success") throw new Error(`market ${m} ${date}: ${data.Status}`);
    for (const mkt of data.Data ?? []) {
      for (const sec of mkt.SectorList ?? []) {
        for (const r of sec.MarketWatchList ?? []) {
          const close = num(r.ClosePrice);
          const high = num(r.High);
          const low = num(r.Low);
          const ltd = ltdToIso(r.LTD);
          // drop stale rows (didn't trade that day) and garbage prices
          if (ltd && ltd !== date) continue;
          if (close == null || close <= 0) continue;
          if (high != null && low != null && high < low) continue;
          rows.push({
            ticker: r.Symbol,
            date,
            open: num(r.OpenPrice),
            high,
            low,
            close,
            volume: int(r.Volume),
            turnover: num(r.Turnover),
            trades: int(r.NoOfTrades),
            source: "msx",
            period_type: "daily",
          });
        }
      }
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return rows;
}

async function upsert(rows: PriceRow[]) {
  const res = await fetch(
    `${SB_URL}/rest/v1/stock_prices?on_conflict=ticker,date,source,period_type`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SB_KEY!,
        Authorization: `Bearer ${SB_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`upsert failed: HTTP ${res.status} ${await res.text()}`);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const twoYearsAgo = new Date(today);
twoYearsAgo.setFullYear(today.getFullYear() - 2);

const from = Deno.args[0] ?? iso(twoYearsAgo);
const to = Deno.args[1] ?? iso(today);
console.log(`backfill ${from} -> ${to}`);

let tradingDays = 0, closedDays = 0, totalRows = 0;
const failed: string[] = [];

for (let d = new Date(from + "T00:00:00Z"); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
  if (!isTradingDay(d)) continue; // MSX weekend: Fri, Sat
  const date = iso(d);
  try {
    const rows = await fetchDay(date);
    if (rows.length === 0) {
      closedDays++;
      continue;
    }
    if (rows.length > 150) throw new Error(`suspicious row count ${rows.length}`);
    await upsert(rows);
    tradingDays++;
    totalRows += rows.length;
    if (tradingDays % 20 === 0) console.log(`  ${date}: ${tradingDays} trading days, ${totalRows} rows so far`);
  } catch (e) {
    failed.push(date);
    console.log(`  FAIL ${date}: ${(e as Error).message}`);
  }
}

// one retry pass for transient failures
for (const date of [...failed]) {
  try {
    const rows = await fetchDay(date);
    if (rows.length > 0 && rows.length <= 150) await upsert(rows);
    failed.splice(failed.indexOf(date), 1);
    tradingDays++;
    totalRows += rows.length;
    console.log(`  retry ok ${date}`);
  } catch (e) {
    console.log(`  retry FAIL ${date}: ${(e as Error).message}`);
  }
}

console.log(`done: ${tradingDays} trading days, ${totalRows} rows, ${closedDays} closed days, ${failed.length} failed`);
if (failed.length) console.log("failed days:", failed.join(", "));
