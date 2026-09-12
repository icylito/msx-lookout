// weekly CSV backup of stock_prices to a private Storage bucket (cheap insurance —
// the free tier has no automatic backups). Keeps the latest 8 weekly files.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const BUCKET = "backups";
const COLS = ["ticker", "date", "open", "high", "low", "close", "volume", "turnover", "trades", "source", "period_type"];

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function dumpCsv(): Promise<{ csv: string; rows: number }> {
  const PAGE = 1000; // Supabase caps REST responses at 1000 rows; page at the cap
  let offset = 0, rows = 0;
  const lines = [COLS.join(",")];
  for (;;) {
    const res = await fetch(
      `${SB_URL}/rest/v1/stock_prices?select=${COLS.join(",")}&order=date,ticker&limit=${PAGE}&offset=${offset}`,
      { headers: H },
    );
    if (!res.ok) throw new Error(`select: HTTP ${res.status} ${await res.text()}`);
    const batch: Record<string, unknown>[] = await res.json();
    for (const r of batch) lines.push(COLS.map((c) => csvCell(r[c])).join(","));
    rows += batch.length;
    if (batch.length < PAGE) break; // a short page means we reached the end
    offset += PAGE;
  }
  return { csv: lines.join("\n"), rows };
}

async function ensureBucket() {
  const res = await fetch(`${SB_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  // 200 created, 400 already exists — both fine
  if (!res.ok && res.status !== 400) throw new Error(`bucket: HTTP ${res.status} ${await res.text()}`);
}

// keep only the newest 8 backups
async function prune() {
  const res = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 100, sortBy: { column: "name", order: "desc" } }),
  });
  const files = await res.json();
  if (!Array.isArray(files)) return 0;
  const old = files.slice(8).map((f: { name: string }) => f.name);
  if (old.length) {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: old }),
    });
  }
  return old.length;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-ingest-key") !== Deno.env.get("INGEST_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    await ensureBucket();
    const { csv, rows } = await dumpCsv();
    const name = `stock_prices_${new Date().toISOString().slice(0, 10)}.csv`;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "text/csv", "x-upsert": "true" },
      body: csv,
    });
    if (!up.ok) throw new Error(`upload: HTTP ${up.status} ${await up.text()}`);
    const pruned = await prune();
    const summary = { file: name, rows, bytes: csv.length, pruned };
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (e) {
    console.error("backup error:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
