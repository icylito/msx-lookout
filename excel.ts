// on-demand Excel export: snapshot over a range, optional period comparison
// usage: deno run -A --env-file=.env excel.ts <start> <end> [compareStart:compareEnd] [out.xlsx]
import ExcelJS from "npm:exceljs@4.4.0";

const GREEN = "FF16A34A";
const RED = "FFDC2626";

type Snap = { ticker: string; name: string; first: number; close: number; volume: number };

async function rest(path: string) {
  const u = Deno.env.get("SUPABASE_URL")!;
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${u}/rest/v1/${path}`, { headers: { apikey: k, Authorization: `Bearer ${k}` } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return await res.json();
}

// per ticker over a range: first close, last close, total volume
async function rangeSnapshot(start: string, end: string): Promise<Map<string, Snap>> {
  const names = new Map<string, string>(
    (await rest("companies?select=ticker,name_en")).map((c: { ticker: string; name_en: string }) => [c.ticker, c.name_en]),
  );
  const rows = await rest(
    `stock_prices?source=eq.msx&period_type=eq.daily&date=gte.${start}&date=lte.${end}` +
      `&select=ticker,date,close,volume&order=ticker,date&limit=100000`,
  );
  const out = new Map<string, Snap>();
  for (const r of rows) {
    const s = out.get(r.ticker);
    if (!s) {
      out.set(r.ticker, { ticker: r.ticker, name: names.get(r.ticker) ?? r.ticker, first: r.close, close: r.close, volume: r.volume ?? 0 });
    } else {
      s.close = r.close; // rows are date-ordered, so this ends at the last close
      s.volume += r.volume ?? 0;
    }
  }
  return out;
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function colorBySign(cell: ExcelJS.Cell, value: number) {
  cell.font = { color: { argb: value > 0 ? GREEN : value < 0 ? RED : "FF374151" }, bold: value !== 0 };
}

export async function generateExcel(
  start: string,
  end: string,
  compareTo?: { start: string; end: string },
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const snap = await rangeSnapshot(start, end);

  const s1 = wb.addWorksheet(`Snapshot ${end}`);
  s1.columns = [
    { header: "Ticker", key: "t", width: 10 },
    { header: "Company", key: "n", width: 38 },
    { header: `Close (${end})`, key: "c", width: 14, style: { numFmt: "0.000" } },
    { header: `Change since ${start}`, key: "ch", width: 18, style: { numFmt: "0.000" } },
    { header: "Change %", key: "p", width: 12, style: { numFmt: "0.00%" } },
    { header: "Volume (period)", key: "v", width: 16, style: { numFmt: "#,##0" } },
  ];
  styleHeader(s1);
  for (const s of [...snap.values()].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    const change = s.close - s.first;
    const row = s1.addRow({ t: s.ticker, n: s.name, c: s.close, ch: change, p: s.first ? change / s.first : 0, v: s.volume });
    colorBySign(row.getCell("ch"), change);
    colorBySign(row.getCell("p"), change);
  }

  if (compareTo) {
    const other = await rangeSnapshot(compareTo.start, compareTo.end);
    const s2 = wb.addWorksheet("Comparison");
    s2.columns = [
      { header: "Ticker", key: "t", width: 10 },
      { header: "Company", key: "n", width: 38 },
      { header: `Close ${compareTo.start}..${compareTo.end}`, key: "a", width: 22, style: { numFmt: "0.000" } },
      { header: `Close ${start}..${end}`, key: "b", width: 22, style: { numFmt: "0.000" } },
      { header: "Change", key: "ch", width: 12, style: { numFmt: "0.000" } },
      { header: "Change %", key: "p", width: 12, style: { numFmt: "0.00%" } },
    ];
    styleHeader(s2);
    for (const s of [...snap.values()].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
      const o = other.get(s.ticker);
      if (!o) continue;
      const change = s.close - o.close;
      const row = s2.addRow({ t: s.ticker, n: s.name, a: o.close, b: s.close, ch: change, p: o.close ? change / o.close : 0 });
      colorBySign(row.getCell("ch"), change);
      colorBySign(row.getCell("p"), change);
    }
  }

  return new Uint8Array(await wb.xlsx.writeBuffer());
}

if (import.meta.main) {
  const [start, end, cmp, out] = Deno.args;
  if (!start || !end) {
    console.log("usage: excel.ts <start> <end> [compareStart:compareEnd] [out.xlsx]");
    Deno.exit(1);
  }
  const compareTo = cmp?.includes(":") ? { start: cmp.split(":")[0], end: cmp.split(":")[1] } : undefined;
  const file = out ?? (cmp && !cmp.includes(":") ? cmp : `msx-${start}-to-${end}.xlsx`);
  await Deno.writeFile(file, await generateExcel(start, end, compareTo));
  console.log(`wrote ${file}`);
}
