// daily MSX ingestion: today's prices + missed-day catch-up + corporate actions
// gated on MSX daily RSS (no item = holiday/delay -> skip, alert Settings email)
import { fetchMarketWatch, fetchHistoryDay, int, isTradingDay, MARKETS, MSX_BASE, num, UA } from "./msx-client.ts";
import { isCadenceDue } from "./cadence.ts";
import { priceRowIssue, shouldFireAlert } from "./rules.ts";
import { type DividendRow, fetchDividends } from "./stockanalysis.ts";
import { C, emailShell, resolveSavedRecipient, sendEmail } from "./email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SANS = "Arial,Helvetica,sans-serif";

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

function muscatToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Muscat" });
}

type AppSettings = {
  price_update_freq: string;
  last_price_ingest_at: string | null;
  price_ingest_fail_streak: number;
  dividends_update_freq: string;
  last_dividends_update_at: string | null;
  notify_failures: boolean;
  email_master_enabled: boolean;
  digest_email: string | null;
};

async function getAppSettings(): Promise<AppSettings> {
  const res = await fetch(
    `${SB_URL}/rest/v1/app_settings?id=eq.1&select=price_update_freq,last_price_ingest_at,price_ingest_fail_streak,dividends_update_freq,last_dividends_update_at,notify_failures,email_master_enabled,digest_email`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  const [row] = await res.json();
  return row ?? {
    price_update_freq: "daily",
    last_price_ingest_at: null,
    price_ingest_fail_streak: 0,
    dividends_update_freq: "weekly",
    last_dividends_update_at: null,
    notify_failures: true,
    email_master_enabled: true,
    digest_email: null,
  };
}

async function touchLastIngest() {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ last_price_ingest_at: new Date().toISOString() }),
  });
}

async function touchLastDividends() {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ last_dividends_update_at: new Date().toISOString() }),
  });
}

// Best-effort dividend refresh for the WATCHLIST only — a handful of tickers, polite to the source
// and enough for the portfolio that matters (any other stock degrades to a link-out in the UI).
// Per-ticker outcomes are counted, not just swallowed, so the UI can be honest about a bad run:
//   ok      — returned rows (real data landed)
//   empty   — reached the source, genuinely no dividends on record (fine)
//   suspect — a ticker we ALREADY hold dividends for now returns nothing → the source layout
//             probably changed and parseDividendRows silently returned []; treat as a failure,
//             not a fresh success, so a broken parser can't masquerade as "up to date"
//   failed  — threw (unreachable / non-200 / blocked)
// The caller stamps last_dividends_update_at only on a clean reach (no failed, no suspect).
async function ingestDividends(): Promise<{ ok: number; empty: number; suspect: number; failed: number }> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const wl = await fetch(`${SB_URL}/rest/v1/watchlist?select=ticker`, { headers: hdrs });
  const tickers = [...new Set((await wl.json()).map((r: { ticker: string }) => r.ticker))] as string[];
  const cachedRes = await fetch(`${SB_URL}/rest/v1/dividends?select=ticker`, { headers: hdrs });
  const cached = new Set((await cachedRes.json()).map((r: { ticker: string }) => r.ticker));
  const rows: (DividendRow & { ticker: string; source: string; fetched_at: string })[] = [];
  const now = new Date().toISOString();
  let ok = 0, empty = 0, suspect = 0, failed = 0;
  for (const ticker of tickers) {
    try {
      const fetched = await fetchDividends(ticker);
      if (fetched.length) {
        for (const d of fetched) rows.push({ ticker, ...d, source: "stockanalysis", fetched_at: now });
        ok++;
      } else if (cached.has(ticker)) {
        suspect++; // had rows before, none now — the parser likely broke; keep the cached rows
      } else {
        empty++; // no dividends on record, and none cached — a legitimate blank
      }
    } catch (_e) {
      failed++; // take the L for this ticker; whatever we cached before stays
    }
  }
  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/dividends?on_conflict=ticker,ex_date`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hdrs, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`dividends upsert: HTTP ${res.status} ${await res.text()}`);
  }
  return { ok, empty, suspect, failed };
}

// real progress for the manual updater row — {done, total} as markets actually resolve,
// not a fabricated tick. null clears it, so a reload never shows a stale run.
async function setIngestProgress(done: number, total: number) {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ price_ingest_progress: total > 0 ? { done, total } : null }),
  });
}
async function activeCompanyCount(): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/companies?active=eq.true&select=ticker`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return (await res.json()).length;
}

// tracks how many *consecutive* runs ended with real problems, so the ops email can
// tell "one-off blip" apart from "N runs in a row have failed — likely a real outage
// or MSX has changed, not just a fluke"
async function setFailStreak(n: number) {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ price_ingest_fail_streak: n }),
  });
}

// newest "Daily Statistics DD-MM-YYYY" in the RSS = MSX's last real trading day.
// This is the ground-truth trading calendar: holidays simply mean the latest is a few
// days back, so we never mistake a holiday for a failure. null = RSS unreadable.
async function latestPublishedDate(): Promise<string | null> {
  const res = await fetch(`${MSX_BASE}/rss.aspx?t=Daily`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const m = (await res.text()).match(/Daily Statistics (\d{2})-(\d{2})-(\d{4})/); // feed is newest-first
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function haveDate(date: string): Promise<boolean> {
  const res = await fetch(
    `${SB_URL}/rest/v1/stock_prices?date=eq.${date}&source=eq.msx&period_type=eq.daily&select=ticker&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  return (await res.json()).length > 0;
}

// calendar days since our newest MSX row; null if the table is empty
async function daysSinceLatestMsx(today: string): Promise<number | null> {
  const res = await fetch(
    `${SB_URL}/rest/v1/stock_prices?source=eq.msx&period_type=eq.daily&select=date&order=date.desc&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  const [row] = await res.json();
  if (!row) return null;
  return Math.floor((Date.parse(today) - Date.parse(row.date)) / 86400000);
}

// today's EOD data with full OHLC; only rows that actually traded.
// onProgress fires after each market's batch resolves — genuine cumulative counts, not a tick per stock.
async function fetchToday(
  date: string,
  onProgress?: (done: number) => void,
): Promise<{ rows: PriceRow[]; dropped: string[] }> {
  const rows: PriceRow[] = [];
  const dropped: string[] = [];
  for (const m of MARKETS) {
    const data = await fetchMarketWatch(m);
    for (const group of data.Data ?? []) {
      for (const r of group.MarketList ?? []) {
        if (!r.Symbol || int(r.NoOfTrades) === 0) continue; // didn't trade today
        const close = num(r.ClosePrice);
        const high = num(r.High);
        const low = num(r.Low);
        const issue = priceRowIssue({ symbol: r.Symbol, close, prevClose: num(r.PrevClose), high, low });
        if (issue) { dropped.push(issue); continue; }
        rows.push({
          ticker: r.Symbol,
          date,
          open: num(r.OpenPrice),
          high,
          low,
          close: close!,
          volume: int(r.Volume),
          turnover: num(r.Turnover),
          trades: int(r.NoOfTrades),
          source: "msx",
          period_type: "daily",
        });
      }
    }
    onProgress?.(rows.length + dropped.length);
  }
  return { rows, dropped };
}

// past day via history endpoint (no open there); [] means market was closed
async function fetchPastDay(date: string): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  for (const m of MARKETS) {
    const data = await fetchHistoryDay(m, date);
    for (const mkt of data.Data ?? []) {
      for (const sec of mkt.SectorList ?? []) {
        for (const r of sec.MarketWatchList ?? []) {
          const close = num(r.ClosePrice);
          if (close == null || close <= 0) continue;
          rows.push({
            ticker: r.Symbol,
            date,
            open: num(r.OpenPrice),
            high: num(r.High),
            low: num(r.Low),
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
  }
  return rows;
}

async function upsertPrices(rows: PriceRow[]) {
  if (rows.length === 0) return;
  const res = await fetch(`${SB_URL}/rest/v1/stock_prices?on_conflict=ticker,date,source,period_type`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`price upsert: HTTP ${res.status} ${await res.text()}`);
}

// which of the last 7 weekdays (excl. today) have no rows yet
async function missingDays(today: string): Promise<string[]> {
  const from = new Date(today + "T00:00:00Z");
  from.setUTCDate(from.getUTCDate() - 7);
  const fromIso = from.toISOString().slice(0, 10);
  const res = await fetch(`${SB_URL}/rest/v1/stock_prices?date=gte.${fromIso}&source=eq.msx&select=date&limit=1000`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const have = new Set((await res.json()).map((r: { date: string }) => r.date));
  const out: string[] = [];
  for (let d = new Date(from); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso >= today) break;
    if (!isTradingDay(d)) continue; // MSX weekend
    if (!have.has(iso)) out.push(iso);
  }
  return out;
}

// corporate actions from the circulars RSS
async function ingestCirculars(): Promise<number> {
  const res = await fetch(`${MSX_BASE}/rss.aspx?t=Circulars`, { headers: { "User-Agent": UA } });
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const compRes = await fetch(`${SB_URL}/rest/v1/companies?select=ticker,name_en`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const companies: { ticker: string; name_en: string }[] = await compRes.json();
  // space-insensitive: "AL ANWAR INVESTMENTS" must match company "ALANWAR INVESTMENT"
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const types: [RegExp, string][] = [
    [/dividend/i, "dividend"],
    [/bonus/i, "bonus shares"],
    [/split/i, "split"],
    [/capital (increase|decrease|reduction)/i, "capital change"],
    [/rights issue/i, "rights issue"],
    [/(listing|delisting|transfer)/i, "listing change"],
    [/(general meeting|agm|egm)/i, "meeting"],
  ];

  // dedupe by circular PDF link — the one thing unique per circular
  const existingRes = await fetch(`${SB_URL}/rest/v1/corporate_actions?select=details->>link&limit=1000&order=date.desc`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const existing = new Set((await existingRes.json()).map((r: { link: string }) => r.link));

  const actions = [];
  for (const item of items) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = item.match(/<Link>([\s\S]*?)<\/Link>/)?.[1]?.trim();
    const pub = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    if (!title || !pub || !link || existing.has(link)) continue;
    const date = new Date(pub).toLocaleDateString("en-CA");
    const type = types.find(([re]) => re.test(title))?.[1] ?? "other";
    const nt = norm(title);
    const ticker = companies.find((c) => nt.includes(norm(c.name_en)))?.ticker ?? null;
    actions.push({ ticker, date, type, details: { title, link } });
  }
  if (actions.length === 0) return 0;
  const ins = await fetch(`${SB_URL}/rest/v1/corporate_actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(actions),
  });
  if (!ins.ok) throw new Error(`corporate_actions insert: HTTP ${ins.status} ${await ins.text()}`);
  return actions.length;
}

// end-of-day price alerts: fire once when the latest close crosses a threshold, then deactivate
async function checkAlerts(digestEmail: string | null): Promise<string[]> {
  const hdrs = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res = await fetch(`${SB_URL}/rest/v1/alerts?active=eq.true&select=id,ticker,condition,threshold_price`, { headers: hdrs });
  const alerts: { id: string; ticker: string; condition: string; threshold_price: number }[] = await res.json();
  const fired: string[] = [];

  for (const a of alerts) {
    const rowRes = await fetch(
      `${SB_URL}/rest/v1/stock_prices?ticker=eq.${a.ticker}&source=eq.msx&period_type=eq.daily&order=date.desc&limit=1&select=date,close`,
      { headers: hdrs },
    );
    const [row] = await rowRes.json();
    if (!row) continue;
    if (!shouldFireAlert(a.condition, a.threshold_price, row.close)) continue;

    const to = resolveSavedRecipient(digestEmail);
    const line = `${a.ticker} closed at ${row.close} on ${row.date} — ${a.condition} your ${a.threshold_price} alert`;
    if (to) {
      const bodyHtml =
        `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.5px;color:${C.clay};padding-bottom:18px;">PRICE ALERT</div>` +
        `<div style="font-family:${SANS};font-size:20px;line-height:28px;color:${C.ink};">${a.ticker} closed at ${row.close}</div>` +
        `<div style="font-family:${SANS};font-size:13px;line-height:22px;color:${C.body};padding-top:10px;">On ${row.date} it closed ${a.condition} your ${a.threshold_price} level.</div>` +
        `<div style="font-family:${SANS};font-size:12px;line-height:20px;color:${C.faint};padding-top:16px;">This is an end-of-day notification (prices are checked after market close), not a trade action. The alert has now switched off; set a new one in the app if you want to keep watching this level.</div>`;
      try {
        await sendEmail({ to, subject: `Price alert: ${line}`, html: emailShell({ label: "PRICE ALERT", dateText: row.date, bodyHtml }) });
      } catch (e) {
        throw new Error(`alert email failed: ${(e as Error).message}`);
      }
    } else {
      console.error("PRICE ALERT (no recipient configured):", line);
    }

    const upd = await fetch(`${SB_URL}/rest/v1/alerts?id=eq.${a.id}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ active: false, fired_at: new Date().toISOString() }),
    });
    if (!upd.ok) throw new Error(`alert deactivate failed: HTTP ${upd.status}`);
    fired.push(line);
  }
  return fired;
}

// ops alert to the Settings email; logs only if that address is blank or Resend fails.
// streak = consecutive failed runs including this one — 1-2 reads as a normal blip
// that'll retry on schedule; 3+ escalates the subject since that's no longer a fluke.
async function opsAlert(problems: string[], date: string, streak: number, digestEmail: string | null) {
  const to = resolveSavedRecipient(digestEmail);
  const overwhelmed = streak >= 3;
  const nextStep = overwhelmed
    ? `This is run #${streak} in a row with problems — likely a real outage or MSX has changed, not a one-off blip. Use "Update now" in the app to retry immediately, or check the ingest logs.`
    : `Will retry automatically on the next scheduled run. Use "Update now" in the app if you want to retry sooner.`;
  const subject = overwhelmed
    ? `MSX ingest: SYSTEM OVERWHELMED — ${streak} consecutive failures (${date})`
    : `MSX ingest: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} on ${date}`;
  if (!to) {
    console.error(`OPS ALERT ${date} (no recipient configured):`, problems.join(" | "));
    return "logged";
  }
  const label = overwhelmed ? "SYSTEM OVERWHELMED" : "UPDATE PROBLEM";
  const bodyHtml =
    `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.5px;color:${C.red};padding-bottom:18px;">${label}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody>` +
    problems.map((p) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:13px;line-height:20px;color:${C.body};">${p}</td></tr>`).join("") +
    `</tbody></table>` +
    `<div style="font-family:${SANS};font-size:12px;line-height:20px;color:${C.faint};padding-top:16px;">${nextStep}</div>`;
  try {
    await sendEmail({ to, subject, html: emailShell({ label: "OPS ALERT", dateText: date, bodyHtml }) });
  } catch (e) {
    console.error(`ops alert send failed:`, (e as Error).message, "| problems:", problems.join(" | "));
    return "resend_failed";
  }
  return "emailed";
}

Deno.serve(async (req) => {
  if (req.headers.get("x-ingest-key") !== Deno.env.get("INGEST_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const today = muscatToday();
  const problems: string[] = [];
  const summary: Record<string, unknown> = { date: today };

  const settings = await getAppSettings();

  if (body.test_alert) {
    summary.alert = await opsAlert(["test alert requested manually"], today, 1, settings.digest_email);
    return Response.json(summary);
  }

  const { due, hoursSince } = isCadenceDue(settings.price_update_freq, settings.last_price_ingest_at, !!body.force);
  if (!due) {
    summary.skipped = `not due yet (${settings.price_update_freq}, last ran ${hoursSince.toFixed(1)}h ago)`;
    return Response.json(summary);
  }

  try {
    const latest = await latestPublishedDate();
    summary.latest_published = latest;

    if (!isTradingDay(new Date(today + "T00:00:00Z"))) {
      summary.today = "weekend, skipped";
    } else if (latest !== today) {
      // MSX has not published today yet — holiday or pre-publish. Normal, not a problem.
      summary.today = `no stats for ${today} yet (latest MSX = ${latest ?? "RSS unreadable"})`;
    } else {
      const total = await activeCompanyCount();
      await setIngestProgress(0, total);
      const { rows, dropped } = await fetchToday(today, (done) => setIngestProgress(done, total));
      if (rows.length < 15) {
        problems.push(`only ${rows.length} traded rows for ${today} — suspicious, skipped the day`);
        summary.today = "skipped: too few rows";
      } else {
        await upsertPrices(rows);
        summary.today = `${rows.length} rows`;
        const total = rows.length + dropped.length;
        // a few dropped rows (suspended stocks etc.) is normal; only alarm on a big share
        if (dropped.length > total * 0.2) {
          problems.push(`dropped ${dropped.length}/${total} rows for ${today}: ${dropped.slice(0, 5).join("; ")}`);
        } else if (dropped.length) {
          summary.dropped = dropped.length;
        }
      }
    }

    const missing = await missingDays(today);
    const caught: string[] = [];
    for (const day of missing.slice(0, 5)) {
      const rows = await fetchPastDay(day);
      if (rows.length > 0) {
        await upsertPrices(rows);
        caught.push(`${day}:${rows.length}`);
      }
    }
    summary.catch_up = caught.length ? caught.join(", ") : "none needed";

    // real-gap guard: MSX published a PAST day we still lack after catch-up (no false alarm
    // on holidays — their latest published day is already in our table).
    if (latest && latest < today && !(await haveDate(latest))) {
      problems.push(`MSX published ${latest} but we still don't have it after catch-up — real ingestion gap`);
    }
    // sustained-outage backstop: no MSX data for >10 calendar days beats any normal holiday.
    const stale = await daysSinceLatestMsx(today);
    summary.days_stale = stale;
    if (stale != null && stale > 10) {
      problems.push(`no MSX data for ${stale} days — likely a real outage or source change`);
    }

    try {
      summary.circulars = await ingestCirculars();
    } catch (e) {
      problems.push(`circulars: ${(e as Error).message}`);
    }

    // dividends: bundled here but on its own cadence. Best-effort — a failure never becomes a
    // `problems` entry (no ops email over a convenience cache); staleness shows via the in-app
    // "DIVIDENDS (last <date>)" light. Only stamp last_dividends_update_at when we actually got data.
    try {
      if (isCadenceDue(settings.dividends_update_freq, settings.last_dividends_update_at, !!body.force).due) {
        const { ok, empty, suspect, failed } = await ingestDividends();
        summary.dividends = { ok, empty, suspect, failed };
        // stamp only on a clean reach — a source error or a suspected parser break keeps the old
        // timestamp so the in-app light goes clay ("kept <date>") instead of pretending it refreshed
        if (failed === 0 && suspect === 0) await touchLastDividends();
      } else {
        summary.dividends = "not due";
      }
    } catch (e) {
      console.error("dividends step failed (best-effort, ignored):", (e as Error).message);
      summary.dividends = `error: ${(e as Error).message}`;
    }

    try {
      if (settings.email_master_enabled) {
        const fired = await checkAlerts(settings.digest_email);
        summary.alerts_fired = fired.length ? fired : 0;
      } else {
        summary.alerts_fired = "email off";
      }
    } catch (e) {
      problems.push(`alerts: ${(e as Error).message}`);
    }

    // successful trading day -> send the daily digest
    if (typeof summary.today === "string" && summary.today.endsWith("rows")) {
      try {
        const dg = await fetch(`${SB_URL}/functions/v1/digest`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-ingest-key": Deno.env.get("INGEST_SECRET")! },
          body: "{}",
        });
        summary.digest = dg.status;
        if (!dg.ok) problems.push(`digest: HTTP ${dg.status} ${await dg.text()}`);
      } catch (e) {
        problems.push(`digest: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    problems.push(`fatal: ${(e as Error).message}`);
  }

  await setIngestProgress(0, 0); // clear — a reload mid-idle should never show a stale run
  await touchLastIngest();
  const newStreak = problems.length ? settings.price_ingest_fail_streak + 1 : 0;
  if (newStreak !== settings.price_ingest_fail_streak) await setFailStreak(newStreak);
  if (problems.length) {
    // ops-failure email is default-on but user-toggleable; the master switch overrides everything.
    summary.alert = (settings.notify_failures && settings.email_master_enabled)
      ? await opsAlert(problems, today, newStreak, settings.digest_email)
      : (console.error(`ops alert suppressed by settings: ${problems.join(" | ")}`), "suppressed");
  }
  summary.problems = problems;
  console.log(JSON.stringify(summary));
  return Response.json(summary);
});
