// monthly companies refresh: add new listings, deactivate delistings, keep aliases/sectors
// fresh. Same MSX source as the one-time seed; runs on a pg_cron schedule.
import { fetchMarketWatch, fetchMonthHistory, MARKETS } from "./msx-client.ts";
import { isCadenceDue } from "./cadence.ts";
import { C, emailShell, resolveSavedRecipient, sendEmail } from "./email.ts";

const SANS = "Arial,Helvetica,sans-serif";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// well-known nicknames the auto-generated aliases can't derive from the formal name
const CURATED: Record<string, string[]> = {
  OFMI: ["omfico", "oman flour"],
  OQBI: ["oq base", "oq base industries", "oq base industry"],
  BKMB: ["bm"],
};

function makeAliases(nameEn: string, ticker: string): string[] {
  const full = nameEn.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const short = full.replace(/\b(co|company|saog|saoc|holding)\b/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([full, short, ...(CURATED[ticker] ?? [])])].filter((a) => a.length > 1);
}

// onProgress fires after each market's batch resolves — genuine cumulative counts, not a tick per stock.
async function fetchCompanies(onProgress?: (done: number) => void) {
  const out = new Map<string, { ticker: string; name_en: string; name_ar: string; aliases: string[]; sector: string | null; market: string; active: boolean }>();
  for (const m of MARKETS) {
    const data = await fetchMarketWatch(m);
    for (const g of data.Data ?? []) {
      for (const r of g.MarketList ?? []) {
        out.set(r.Symbol, {
          ticker: r.Symbol, name_en: r.ShortNameEn, name_ar: r.ShortNameAr,
          aliases: makeAliases(r.ShortNameEn, r.Symbol), sector: null, market: r.MarketNameEn, active: true,
        });
      }
    }
    onProgress?.(out.size);
    await new Promise((r) => setTimeout(r, 800));
  }
  return out;
}

async function fetchSectors() {
  const map = new Map<string, string>();
  for (const m of MARKETS) {
    const data = await fetchMonthHistory(m);
    for (const mkt of data.Data ?? []) {
      for (const sec of mkt.SectorList ?? []) {
        for (const r of sec.MarketWatchList ?? []) map.set(r.Symbol, sec.sectornameEn);
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return map;
}

type RefreshSettings = {
  company_refresh_freq: string;
  last_company_refresh_at: string | null;
  email_master_enabled: boolean;
  notify_listings: boolean;
  digest_email: string | null;
};

async function getAppSettings(): Promise<RefreshSettings> {
  const res = await fetch(
    `${SB_URL}/rest/v1/app_settings?id=eq.1&select=company_refresh_freq,last_company_refresh_at,email_master_enabled,notify_listings,digest_email`,
    { headers: H },
  );
  const [row] = await res.json();
  return row ?? { company_refresh_freq: "monthly", last_company_refresh_at: null, email_master_enabled: true, notify_listings: false, digest_email: null };
}

// opt-in heads-up when the listed universe changes. Best-effort like every other email here:
// falls back to logs if Resend isn't configured, and only fires when there's a real change.
async function notifyListingChanges(
  added: string[],
  delisted: string[],
  companies: Map<string, { name_en: string }>,
  settings: RefreshSettings,
): Promise<string> {
  if (!added.length && !delisted.length) return "no changes";
  if (!settings.email_master_enabled || !settings.notify_listings) return "suppressed by settings";
  const to = resolveSavedRecipient(settings.digest_email);
  if (!to) {
    console.error("listing change (no recipient configured):", JSON.stringify({ added, delisted }));
    return "logged";
  }

  function section(title: string, items: string[]): string {
    return `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.5px;color:${C.clay};padding-bottom:12px;">${title}</div>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody>` +
      items.map((it) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.rowRule};font-family:${SANS};font-size:13px;color:${C.body};">${it}</td></tr>`).join("") +
      `</tbody></table>`;
  }
  const blocks: string[] = [];
  if (added.length) {
    blocks.push(section("NEWLY LISTED", added.map((t) => `<b style="color:${C.clay};">${t}</b>${companies.get(t)?.name_en ? " · " + companies.get(t)!.name_en : ""}`)));
  }
  if (delisted.length) {
    blocks.push(section("DELISTED / DEACTIVATED", delisted.map((t) => `<b style="color:${C.clay};">${t}</b>`)));
  }
  const bodyHtml = blocks.join(`<div style="height:28px;line-height:28px;">&nbsp;</div>`);
  const html = emailShell({
    label: "LISTINGS CHANGED",
    bodyHtml,
    footerNote: "An informational heads-up from your company refresh. You can turn these off in the app's Settings.",
  });

  try {
    await sendEmail({
      to,
      subject: `MSX listings changed: ${added.length} new, ${delisted.length} delisted`,
      html,
    });
  } catch (e) {
    console.error("listing email failed:", (e as Error).message);
    return "resend_failed";
  }
  return "emailed";
}

async function touchLastRefresh() {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH", headers: H, body: JSON.stringify({ last_company_refresh_at: new Date().toISOString() }),
  });
}

// real progress for the manual updater row — {done, total} as markets actually resolve.
// total = how many companies we already know about (a stable reference; the real final
// count may differ slightly if a listing/delisting happened, same as ingest's total).
async function setRefreshProgress(done: number, total: number) {
  await fetch(`${SB_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH", headers: H, body: JSON.stringify({ company_refresh_progress: total > 0 ? { done, total } : null }),
  });
}

Deno.serve(async (req) => {
  if (req.headers.get("x-ingest-key") !== Deno.env.get("INGEST_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const body = await req.json().catch(() => ({}));

  const settings = await getAppSettings();
  const { due, hoursSince } = isCadenceDue(settings.company_refresh_freq, settings.last_company_refresh_at, !!body.force);
  if (!due) {
    return Response.json({ skipped: `not due yet (${settings.company_refresh_freq}, last ran ${hoursSince.toFixed(1)}h ago)` });
  }

  try {
    const existing: { ticker: string; sector: string | null }[] =
      await (await fetch(`${SB_URL}/rest/v1/companies?select=ticker,sector&limit=500`, { headers: H })).json();
    const existingSet = new Set(existing.map((c) => c.ticker));
    const existingSectors = new Map(existing.map((c) => [c.ticker, c.sector]));

    const total = existing.length;
    await setRefreshProgress(0, total);
    const companies = await fetchCompanies((done) => setRefreshProgress(done, total));
    const sectors = await fetchSectors();
    // MSX derives sector from the last month's trading activity, so suspended/liquidated stocks
    // never get one from this fetch — fall back to whatever we already have instead of nulling it
    // out every refresh (that's how sectors we've backfilled by hand for those stocks used to get
    // silently wiped on the next scheduled run).
    const rows = [...companies.values()].map((c) => ({
      ...c, sector: sectors.get(c.ticker) ?? existingSectors.get(c.ticker) ?? null,
    }));

    const up = await fetch(`${SB_URL}/rest/v1/companies?on_conflict=ticker`, {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!up.ok) throw new Error(`upsert: HTTP ${up.status} ${await up.text()}`);

    const delisted = [...existingSet].filter((t) => !companies.has(t));
    if (delisted.length) {
      await fetch(`${SB_URL}/rest/v1/companies?ticker=in.(${delisted.join(",")})`, {
        method: "PATCH", headers: H, body: JSON.stringify({ active: false }),
      });
    }
    const added = [...companies.keys()].filter((t) => !existingSet.has(t));
    const notified = await notifyListingChanges(added, delisted, companies, settings);

    const summary = { live: companies.size, added, delisted, sectors: sectors.size, notified };
    console.log(JSON.stringify(summary));
    await setRefreshProgress(0, 0); // clear — a reload mid-idle should never show a stale run
    await touchLastRefresh();
    return Response.json(summary);
  } catch (e) {
    console.error("refresh error:", (e as Error).message);
    await setRefreshProgress(0, 0);
    await touchLastRefresh();
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
