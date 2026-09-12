// daily digest email: market summary + top gainers/losers + Excel snapshot attachment
// sent after each successful ingestion (chained from the ingest function)

import { encodeBase64 } from "jsr:@std/encoding/base64";
import { generateExcel } from "./excel.ts";
import { isCadenceDue } from "./cadence.ts";
import { C, emailShell, resolveSavedRecipient, sendEmail } from "./email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GREEN = C.green;
const RED = C.red;
const SANS = "Arial,Helvetica,sans-serif";

async function rest(path: string, init?: RequestInit) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

type Mover = { ticker: string; name: string; close: number; change: number; pct: number };

function moverRows(movers: Mover[], color: string) {
  return movers.map((m) =>
    `<tr>` +
    `<td width="60" style="width:60px;padding:12px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1px;color:${C.clay}">${m.ticker}</td>` +
    `<td style="padding:12px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:13px;color:${C.body}">${m.name}</td>` +
    `<td align="right" width="70" style="width:70px;padding:12px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:13px;color:${C.ink}">${m.close.toFixed(3)}</td>` +
    `<td align="right" width="96" style="width:96px;padding:12px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:12.5px;color:${color}">${m.change > 0 ? "+" : ""}${m.change.toFixed(3)} (${m.pct.toFixed(2)}%)</td>` +
    `</tr>`
  ).join("");
}

function moverSection(title: string, color: string, rows: string): string {
  return `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.5px;color:${color};padding-bottom:6px;">${title}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody>${rows}</tbody></table>`;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-ingest-key") !== Deno.env.get("INGEST_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  // digest.ts is chained off ingest.ts, which may run more often than the user wants this
  // email — so it needs its own cadence check independent of the price-update schedule.
  const reqBody = await req.json().catch(() => ({}));
  const settings = (await rest("app_settings?id=eq.1&select=digest_freq,last_digest_sent_at,email_master_enabled,digest_email"))[0] ?? {};
  // master email switch overrides the digest cadence entirely (user opted out of all email)
  if (settings.email_master_enabled === false) return Response.json({ skipped: true, reason: "email disabled" });
  const { due } = isCadenceDue(settings.digest_freq ?? "daily", settings.last_digest_sent_at ?? null, reqBody.force === true);
  if (!due) return Response.json({ skipped: true, reason: "not due yet", freq: settings.digest_freq ?? "daily" });

  // digest is user-facing: no saved address means skip, not "fall back to env"
  const to = resolveSavedRecipient(settings.digest_email);
  if (!to) return Response.json({ skipped: true, reason: "no saved recipient" });

  // latest two trading days in the fact table
  const dates = await rest("stock_prices?source=eq.msx&period_type=eq.daily&select=date&order=date.desc&limit=200");
  const uniq = [...new Set(dates.map((r: { date: string }) => r.date))] as string[];
  const [today, prev] = uniq;
  if (!today || !prev) return Response.json({ error: "not enough data" }, { status: 500 });

  const names = new Map<string, string>(
    (await rest("companies?select=ticker,name_en")).map((c: { ticker: string; name_en: string }) => [c.ticker, c.name_en]),
  );
  const tRows = await rest(`stock_prices?source=eq.msx&date=eq.${today}&select=ticker,close,volume,turnover&limit=200`);
  const pRows = await rest(`stock_prices?source=eq.msx&date=eq.${prev}&select=ticker,close&limit=200`);
  const prevClose = new Map<string, number>(pRows.map((r: { ticker: string; close: number }) => [r.ticker, r.close]));

  const movers: Mover[] = [];
  let up = 0, down = 0, flat = 0, volume = 0, turnover = 0;
  for (const r of tRows) {
    volume += r.volume ?? 0;
    turnover += Number(r.turnover ?? 0);
    const pc = prevClose.get(r.ticker);
    if (!pc) continue;
    const change = r.close - pc;
    if (change > 0) up++; else if (change < 0) down++; else flat++;
    movers.push({ ticker: r.ticker, name: names.get(r.ticker) ?? r.ticker, close: r.close, change, pct: (change / pc) * 100 });
  }
  movers.sort((a, b) => b.pct - a.pct);
  const gainers = movers.filter((m) => m.change > 0).slice(0, 5);
  const losers = movers.filter((m) => m.change < 0).slice(-5).reverse(); // worst first

  const summaryHtml =
    `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.5px;color:${C.clay};padding-bottom:18px;">MARKET SUMMARY</div>` +
    `<div style="font-family:${SANS};font-size:13px;line-height:22px;color:${C.body};">` +
    `<span style="color:${GREEN};">▲ ${up} advancers</span> &nbsp; <span style="color:${RED};">▼ ${down} decliners</span> &nbsp; ${flat} unchanged<br>` +
    `Traded volume <b style="color:${C.ink};">${volume.toLocaleString()}</b> &nbsp; Turnover <b style="color:${C.ink};">${Math.round(turnover).toLocaleString()} OMR</b>` +
    `</div>`;
  const rule = `<div style="height:1px;background-color:${C.rule};font-size:1px;line-height:1px;margin:28px 0;">&nbsp;</div>`;
  const bodyHtml = summaryHtml + rule +
    moverSection("TOP GAINERS", GREEN, moverRows(gainers, GREEN)) +
    `<div style="height:28px;line-height:28px;">&nbsp;</div>` +
    moverSection("TOP LOSERS", RED, moverRows(losers, RED));

  const html = emailShell({
    label: "DAILY DIGEST",
    dateText: today,
    bodyHtml,
    footerNote: `Full snapshot attached (Excel). Prices vs previous trading day (${prev}).`,
  });

  const excel = await generateExcel(prev, today);

  let emailId: string;
  try {
    emailId = await sendEmail({
      to,
      subject: `MSX Digest ${today}: ▲${up} ▼${down}`,
      html,
      attachments: [{ filename: `msx-${today}.xlsx`, content: encodeBase64(excel) }],
    });
  } catch (e) {
    console.error("digest send failed:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
  await rest("app_settings?id=eq.1", { method: "PATCH", body: JSON.stringify({ last_digest_sent_at: new Date().toISOString() }) });
  const summary = { date: today, vs: prev, advancers: up, decliners: down, unchanged: flat, email_id: emailId };
  console.log(JSON.stringify(summary));
  return Response.json(summary);
});
