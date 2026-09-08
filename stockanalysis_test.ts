import { assertEquals } from "jsr:@std/assert@1";
import { parseDividendRows } from "./stockanalysis.ts";

// mirrors the real server-side markup: Svelte class hashes, "Mon DD, YYYY" dates, "N OMR" amounts,
// a <th> header row (no <td>, so it's ignored), and a hide-column-mobile class on the record cell.
const REAL_SHAPE = `
<table>
<thead><tr><th>Ex-Dividend Date</th><th>Cash Amount</th><th>Record Date</th><th>Pay Date</th></tr></thead>
<tbody>
<tr><td class="svelte-77tdkt">Mar 18, 2026</td><td class="svelte-77tdkt">0.018 OMR</td><td class="hide-column-mobile svelte-77tdkt">Mar 17, 2026</td><td class="svelte-77tdkt">Mar 26, 2026</td></tr>
<tr><td class="svelte-77tdkt">Mar 27, 2025</td><td class="svelte-77tdkt">0.0165 OMR</td><td class="hide-column-mobile svelte-77tdkt">Mar 26, 2025</td><td class="svelte-77tdkt">Apr 8, 2025</td></tr>
</tbody>
</table>`;

Deno.test("parseDividendRows: real-shaped table -> normalized rows", () => {
  const rows = parseDividendRows(REAL_SHAPE);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { ex_date: "2026-03-18", amount: 0.018, record_date: "2026-03-17", pay_date: "2026-03-26" });
  assertEquals(rows[1], { ex_date: "2025-03-27", amount: 0.0165, record_date: "2025-03-26", pay_date: "2025-04-08" });
});

Deno.test("parseDividendRows: strips currency suffix/prefix from the amount", () => {
  const rows = parseDividendRows(`<tr><td>Jan 5, 2024</td><td>$0.020</td></tr>`);
  assertEquals(rows[0].amount, 0.02);
});

Deno.test("parseDividendRows: ignores rows whose first cell isn't a date", () => {
  const html = `<tr><td>Some heading</td><td>not a number either</td></tr>` +
    `<tr><td>Feb 1, 2024</td><td>0.01 OMR</td></tr>`;
  const rows = parseDividendRows(html);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ex_date, "2024-02-01");
});

Deno.test("parseDividendRows: dedupes repeated ex-dates", () => {
  const html = `<tr><td>Feb 1, 2024</td><td>0.01</td></tr><tr><td>Feb 1, 2024</td><td>0.01</td></tr>`;
  assertEquals(parseDividendRows(html).length, 1);
});

Deno.test("parseDividendRows: unrecognizable HTML yields [] (graceful degrade to link-out)", () => {
  assertEquals(parseDividendRows("<html><body>they changed everything</body></html>"), []);
  assertEquals(parseDividendRows(""), []);
});

Deno.test("parseDividendRows: missing record/pay cells become null", () => {
  const rows = parseDividendRows(`<tr><td>Mar 3, 2023</td><td>0.015 OMR</td></tr>`);
  assertEquals(rows[0], { ex_date: "2023-03-03", amount: 0.015, record_date: null, pay_date: null });
});
