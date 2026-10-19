// Public JSON API + Excel download. Read-only — there is no write path.
// The page itself is static (web/index.html on GitHub Pages); this serves it cross-origin.
import { generateExcel } from "./excel.ts";
import { fetchHistoryDay, isTradingDay, MARKET_NUM, num } from "./msx-client.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function msxHistoryDay(market: number, date: string) {
  const data = await fetchHistoryDay(market, date);
  const out: { ticker: string; close: number; high: number | null; low: number | null; volume: number | null; turnover: number | null; trades: number | null }[] = [];
  for (const mkt of data.Data ?? []) {
    for (const sec of mkt.SectorList ?? []) {
      for (const r of sec.MarketWatchList ?? []) {
        const close = num(r.ClosePrice);
        if (close == null || close <= 0) continue;
        out.push({
          ticker: r.Symbol, close,
          high: num(r.High), low: num(r.Low),
          volume: num(r.Volume) == null ? null : Math.round(num(r.Volume)!),
          turnover: num(r.Turnover),
          trades: num(r.NoOfTrades) == null ? null : Math.round(num(r.NoOfTrades)!),
        });
      }
    }
  }
  return out;
}

// the 7 calendar days before today (excluding MSX's Fri/Sat weekend), oldest first
function last7Weekdays(): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = 7; i >= 1; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    if (!isTradingDay(d)) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// only kicks in once a stock has gone quiet for a real stretch (>7 days, or never
// traded at all) — a 1-2 day gap is completely normal and must stay a no-op fast path.
// When it does kick in, it checks MSX's own history for the past 7 days specifically
// and fills in anything genuinely missing there. If MSX has nothing either, the stock
// just didn't trade — that's a real answer, not a failure.
async function fillGapIfStale(ticker: string, lastDate: string | null): Promise<string | null> {
  const daysSince = lastDate
    ? Math.floor((Date.now() - Date.parse(lastDate + "T00:00:00Z")) / 86400000)
    : Infinity;
  if (daysSince <= 7) return null;

  const [company] = await rest(`companies?ticker=eq.${ticker}&select=market`);
  const marketNum = company ? MARKET_NUM[company.market] : undefined;
  if (!marketNum) return null; // unknown market mapping — skip rather than guess

  const days = last7Weekdays().filter((d) => !lastDate || d > lastDate);
  const recovered: string[] = [];
  for (const date of days) {
    const rows = await msxHistoryDay(marketNum, date);
    const hit = rows.find((r) => r.ticker === ticker);
    if (!hit) continue;
    const up = await fetch(`${SB_URL}/rest/v1/stock_prices?on_conflict=ticker,date,source,period_type`, {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        ticker, date, open: null, high: hit.high, low: hit.low, close: hit.close,
        volume: hit.volume, turnover: hit.turnover, trades: hit.trades,
        source: "msx", period_type: "daily",
      }]),
    });
    if (!up.ok) throw new Error(`gap-fill upsert: HTTP ${up.status} ${await up.text()}`);
    recovered.push(date);
  }
  if (recovered.length) return `Recovered ${recovered.length} missing day(s) from MSX: ${recovered.join(", ")}`;
  return `No trades on MSX in the last 7 days, this stock just hasn't traded.`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

async function rest(path: string, init?: RequestInit) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: H });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null; // inserts/deletes come back with empty bodies
}
const rpc = (fn: string, args: Record<string, unknown>) =>
  rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// ---- Storage (exports bucket) ----
type StorageEntry = { name: string; id: string | null; metadata: { size?: number } | null; created_at: string | null };

async function storageList(prefix: string): Promise<StorageEntry[]> {
  const res = await fetch(`${SB_URL}/storage/v1/object/list/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ prefix, limit: 200, sortBy: { column: "name", order: "desc" } }),
  });
  if (!res.ok) throw new Error(`storage list: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function storageSign(path: string): Promise<string> {
  const res = await fetch(`${SB_URL}/storage/v1/object/sign/exports/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  if (!res.ok) throw new Error(`storage sign: HTTP ${res.status} ${await res.text()}`);
  const { signedURL } = await res.json();
  return `${SB_URL}/storage/v1${signedURL}`;
}

// best-effort archive: a failed upload shouldn't block the user's actual download
async function storageUpload(path: string, bytes: Uint8Array) {
  try {
    const res = await fetch(`${SB_URL}/storage/v1/object/exports/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "x-upsert": "true",
      },
      body: bytes as BodyInit,
    });
    if (!res.ok) console.error(`export archive failed: HTTP ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("export archive failed:", (e as Error).message);
  }
}

async function handleData(p: Record<string, string>) {
  switch (p.action) {
    case "home": {
      const [watchlist, state] = await Promise.all([rpc("watchlist_view", {}), rpc("fallback_state", {})]);
      // most recent dividend among watchlist holdings — feeds the calm "Latest" strip on the home screen
      const tickers = [...new Set((watchlist as { ticker: string }[]).map((r) => r.ticker))];
      let latestDividend = null;
      if (tickers.length) {
        const rows = await rest(`dividends?ticker=in.(${tickers.join(",")})&select=ticker,ex_date,amount,pay_date&order=ex_date.desc&limit=1`);
        latestDividend = rows[0] ?? null;
      }
      return { watchlist, state, latestDividend };
    }
    case "search":
      return await rpc("search_companies", { q: p.q });
    case "browse":
      return await rpc("all_stocks_view", {});
    case "detail": {
      let [latest, trend, actions, watchRows, company, dividends] = await Promise.all([
        rpc("latest_price", { p_ticker: p.ticker }),
        rpc("price_trend", { p_ticker: p.ticker, p_days: 90 }),
        rpc("ticker_actions", { p_ticker: p.ticker, p_days: 180 }),
        rest(`watchlist?ticker=eq.${p.ticker.toUpperCase()}&select=id,quantity,buy_price`),
        rest(`companies?ticker=eq.${p.ticker.toUpperCase()}&select=name_en,sector`),
        rest(`dividends?ticker=eq.${p.ticker.toUpperCase()}&select=ex_date,amount,record_date,pay_date&order=ex_date.desc&limit=8`),
      ]);
      const ticker = p.ticker.toUpperCase();
      const gapNote = await fillGapIfStale(ticker, latest[0]?.date ?? null);
      if (gapNote && gapNote.startsWith("Recovered")) {
        [latest, trend] = await Promise.all([
          rpc("latest_price", { p_ticker: ticker }),
          rpc("price_trend", { p_ticker: ticker, p_days: 90 }),
        ]);
      }
      return {
        latest: latest[0] ?? null, trend, actions, gapNote, dividends,
        watching: watchRows.length > 0,
        hasPosition: watchRows.some((r: { quantity: number | null }) => r.quantity != null),
        quantity: watchRows.find((r: { quantity: number | null }) => r.quantity != null)?.quantity ?? null,
        name: company[0]?.name_en ?? null, sector: company[0]?.sector ?? null,
      };
    }
    case "weeks": {
      const out = [];
      for (let i = 0; i < 8; i++) out.push((await rpc("trading_week", { p_offset: i }))[0]);
      return out.filter(Boolean);
    }
    case "compare":
      // p_ticker null = all stocks; a ticker = just that one (compare_periods handles both)
      return await rpc("compare_periods", { s1: p.s1, e1: p.e1, s2: p.s2, e2: p.e2, p_ticker: p.ticker || null });
    case "ohlc": {
      const rows = await rest(
        `stock_prices?ticker=eq.${p.ticker.toUpperCase()}&source=eq.msx&period_type=eq.daily` +
          `&select=date,open,high,low,close,volume&order=date.desc&limit=${Number(p.days) || 90}`,
      );
      return rows.reverse();
    }
    case "weekly": {
      const rows = await rest(
        `weekly_prices?ticker=eq.${p.ticker.toUpperCase()}` +
          `&select=week_start,close,volume&order=week_start.desc&limit=${Number(p.weeks) || 26}`,
      );
      return rows.reverse();
    }
    case "companies":
      return await rest("companies?select=ticker,name_en&active=eq.true&order=name_en");
    case "get_settings": {
      const row = (await rest("app_settings?id=eq.1"))[0] ?? null;
      if (row) row.digest_email = null; // private contact info — never served over the public read API
      return row;
    }
    case "list_exports": {
      const folders = (await storageList("")).filter((f) => f.id === null);
      const out = [];
      for (const f of folders) {
        const files = (await storageList(f.name)).filter((x) => x.id !== null);
        if (files.length) {
          out.push({
            folder: f.name,
            files: files.map((x) => ({
              name: x.name, path: `${f.name}/${x.name}`,
              size: x.metadata?.size ?? null, created_at: x.created_at,
            })),
          });
        }
      }
      out.sort((a, b) => b.folder.localeCompare(a.folder));
      return out;
    }
    case "export_url": {
      const path = p.path ?? "";
      if (!path || path.includes("..") || path.includes("\\") || path.startsWith("/")) {
        throw new Error("bad path");
      }
      return { url: await storageSign(path) };
    }
    default:
      throw new Error(`unknown action ${p.action}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);

  try {
    if (url.pathname.endsWith("/data") && req.method === "POST") {
      const body = await req.json();
      return Response.json(await handleData(body), { headers: CORS });
    }
    if (url.pathname.endsWith("/excel")) {
      const s = url.searchParams;
      const cmp = s.get("cs") ? { start: s.get("cs")!, end: s.get("ce")! } : undefined;
      const bytes = await generateExcel(s.get("start")!, s.get("end")!, cmp);
      const filename = `msx-${s.get("end")}.xlsx`;
      // archive every user-initiated download so it can be re-browsed later, grouped by
      // year-month of the export's end date; failures are swallowed inside storageUpload
      // so a storage hiccup never breaks the actual download (awaited: an Edge Function's
      // isolate isn't guaranteed to keep running an un-awaited task after the response ships)
      await storageUpload(`${(s.get("end") ?? "").slice(0, 7)}/${filename}`, bytes);
      // Uint8Array<ArrayBufferLike> vs BodyInit's ArrayBuffer-only generic is a
      // TS lib strictness mismatch, not a runtime issue — Deno accepts this directly.
      return new Response(bytes as BodyInit, {
        headers: {
          ...CORS,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }
    return Response.json({ ok: "MSX Lookout API. The app is at your GitHub Pages URL." }, { headers: CORS });
  } catch (e) {
    console.error("app error:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS });
  }
});
