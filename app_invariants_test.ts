import { assert } from "jsr:@std/assert@1";

const src = await Deno.readTextFile(new URL("./supabase/functions/app/app.ts", import.meta.url));

Deno.test("public API comments and copy are not family-specific", () => {
  assert(!/\bDad\b/i.test(src));
});

Deno.test("the app has no write actions left", () => {
  for (const action of ["save", "remove", "watch", "unwatch", "save_settings", "run_ingest_now", "run_refresh_now"]) {
    assert(!src.includes(`case "${action}"`), `${action} should have been removed, not left as a write path`);
  }
  assert(!src.includes("x-ingest-key"), "the app no longer needs an operator key — it's read-only");
  assert(!src.includes("INGEST_SECRET"), "the app no longer checks the ingest secret");
});

Deno.test("digest_email is never served over the public read API", () => {
  assert(src.includes("digest_email = null"));
});
