// seed the companies table from MSX market watch
// usage: deno run --allow-net --env-file=.env seed.ts [--dry-run]
import { fetchMarketWatch, fetchMonthHistory, MARKETS } from "./msx-client.ts";

type Company = {
  ticker: string;
  name_en: string;
  name_ar: string;
  aliases: string[];
  sector: string | null;
  market: string;
};

// "AL OMANIYA FINANCIAL SERVICES" -> ["al omaniya financial services"]
function makeAliases(nameEn: string): string[] {
  const full = nameEn.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const short = full.replace(/\b(co|company|saog|saoc|holding)\b/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([full, short])].filter((a) => a.length > 1);
}

// full listed set (markets 1=Regular 2=Parallel 3=Under Monitoring, traded or not)
async function fetchCompanies(): Promise<Company[]> {
  const out = new Map<string, Company>();
  for (const m of MARKETS) {
    const data = await fetchMarketWatch(m);
    for (const group of data.Data ?? []) {
      for (const row of group.MarketList ?? []) {
        out.set(row.Symbol, {
          ticker: row.Symbol,
          name_en: row.ShortNameEn,
          name_ar: row.ShortNameAr,
          aliases: makeAliases(row.ShortNameEn),
          sector: null,
          market: row.MarketNameEn,
        });
      }
    }
    await new Promise((r) => setTimeout(r, 1000)); // polite pacing
  }
  return [...out.values()];
}

// sector per ticker, from history grouping (last month, markets 1-3)
async function fetchSectors(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const m of MARKETS) {
    const data = await fetchMonthHistory(m);
    for (const mkt of data.Data ?? []) {
      for (const sec of mkt.SectorList ?? []) {
        for (const row of sec.MarketWatchList ?? []) {
          map.set(row.Symbol, sec.sectornameEn);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000)); // polite pacing
  }
  return map;
}

async function upsert(companies: Company[]) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env");
  const res = await fetch(`${url}/rest/v1/companies?on_conflict=ticker`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(companies),
  });
  if (!res.ok) throw new Error(`upsert failed: HTTP ${res.status} ${await res.text()}`);
}

const companies = await fetchCompanies();
const sectors = await fetchSectors();
for (const c of companies) c.sector = sectors.get(c.ticker) ?? null;

console.log(`companies: ${companies.length}, with sector: ${companies.filter((c) => c.sector).length}`);

if (Deno.args.includes("--dry-run")) {
  console.log(companies.slice(0, 5));
} else {
  await upsert(companies);
  console.log("seeded");
}
