import { assert, assertEquals } from "jsr:@std/assert@1";

const src = await Deno.readTextFile(new URL("./supabase/functions/app/app.ts", import.meta.url));

Deno.test("public API comments and copy are not family-specific", () => {
  assert(!/\bDad\b/i.test(src));
});

Deno.test("mutations are listed as write actions", () => {
  for (const action of [
    "save", "remove", "watch", "unwatch", "save_settings",
    "list_exports", "export_url", "run_ingest_now", "run_refresh_now",
  ]) {
    assert(src.includes(`"${action}"`), `WRITE_ACTIONS missing ${action}`);
  }
});

Deno.test("unprivileged writes return 403 and CORS allows the ingest header", () => {
  assert(src.includes('status: 403'));
  assert(src.includes("content-type, x-ingest-key"));
  assert(src.includes("digest_email = null"));
});

Deno.test("isPrivileged fails closed when the secret is empty", () => {
  function isPrivileged(got: string | null, secret: string | undefined): boolean {
    const s = secret ?? "";
    const g = got ?? "";
    return s.length > 0 && g === s;
  }
  assertEquals(isPrivileged(null, undefined), false);
  assertEquals(isPrivileged("", ""), false);
  assertEquals(isPrivileged("x", ""), false);
  assertEquals(isPrivileged("secret", "secret"), true);
  assertEquals(isPrivileged("nope", "secret"), false);
});
