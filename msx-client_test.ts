import { assertEquals } from "jsr:@std/assert@1";
import { int, isTradingDay, msxPost, num } from "./msx-client.ts";

Deno.test("isTradingDay: Sun-Thu are trading days, Fri/Sat are MSX's weekend", () => {
  assertEquals(isTradingDay(new Date("2026-08-23T00:00:00Z")), true); // Sunday
  assertEquals(isTradingDay(new Date("2026-08-27T00:00:00Z")), true); // Thursday
  assertEquals(isTradingDay(new Date("2026-08-28T00:00:00Z")), false); // Friday
  assertEquals(isTradingDay(new Date("2026-08-29T00:00:00Z")), false); // Saturday
});

Deno.test("num: parses numeric strings, treats null/undefined/empty as null", () => {
  assertEquals(num("1.234"), 1.234);
  assertEquals(num(null), null);
  assertEquals(num(undefined), null);
  assertEquals(num(""), null);
});

Deno.test("int: rounds numeric strings, treats null/undefined/empty as null", () => {
  assertEquals(int("12.6"), 13);
  assertEquals(int(null), null);
  assertEquals(int(""), null);
});

// msxPost owns the only retry-with-backoff in the codebase; a bug here silently
// removes the one thing standing between a transient MSX blip and a real alert.
Deno.test("msxPost: retries a transient failure and succeeds on the next attempt", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    if (calls < 2) return Promise.resolve(new Response("", { status: 500 }));
    return Promise.resolve(new Response(JSON.stringify({ d: '{"Status":"Success"}|asc|0' })));
  }) as typeof fetch;
  try {
    const result = await msxPost("GetPageData", "1||false||||0");
    assertEquals(calls, 2);
    assertEquals((result as { Status: string }).Status, "Success");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("msxPost: throws once every attempt is exhausted", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response("", { status: 500 }));
  }) as typeof fetch;
  try {
    let threw = false;
    try {
      await msxPost("GetPageData", "1||false||||0", 2);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
