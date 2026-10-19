import { assert } from "jsr:@std/assert@1";

const src = await Deno.readTextFile(new URL("./supabase/functions/app/app.ts", import.meta.url));

Deno.test("public API comments and copy are not family-specific", () => {
  assert(!/\bDad\b/i.test(src));
});

Deno.test("no operator key on /data", () => {
  assert(!src.includes("x-ingest-key\")"), "app must not read the key from the request");
  assert(!src.includes("WRITE_ACTIONS"));
  assert(src.includes('"Access-Control-Allow-Headers": "content-type"'));
});

Deno.test("bad input is 400, unknown action is 404, the rest is 500", () => {
  assert(src.includes("status: 400"));
  assert(src.includes("status: 404"));
  assert(src.includes("status: 500"));
});

Deno.test("every value that lands in a REST URL goes through a checker", () => {
  for (const m of src.matchAll(/rest\(\s*`([^`]*)`/g)) {
    for (const v of m[1].matchAll(/\$\{([^}]+)\}/g)) {
      assert(!/\bp\.\w+/.test(v[1]) || /^(ticker|count|day)\(/.test(v[1]), `raw input in URL: ${v[1]}`);
    }
  }
});
