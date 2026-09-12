import { assertEquals } from "jsr:@std/assert@1";
import { resolveSavedRecipient } from "./email.ts";

// Shipped mail uses the Settings address only. DIGEST_EMAIL / MAINTAINER_EMAIL
// must never become the recipient, even if they are still set as function secrets.

Deno.test("resolveSavedRecipient: saved address is trimmed", () => {
  Deno.env.set("DIGEST_EMAIL", "env@fallback.com");
  Deno.env.set("MAINTAINER_EMAIL", "maint@fallback.com");
  assertEquals(resolveSavedRecipient("  user@saved.com  "), "user@saved.com");
  Deno.env.delete("DIGEST_EMAIL");
  Deno.env.delete("MAINTAINER_EMAIL");
});

Deno.test("resolveSavedRecipient: blank/whitespace/null/undefined does not fall back to env", () => {
  Deno.env.set("DIGEST_EMAIL", "env@fallback.com");
  Deno.env.set("MAINTAINER_EMAIL", "maint@fallback.com");
  assertEquals(resolveSavedRecipient(""), null);
  assertEquals(resolveSavedRecipient("   "), null);
  assertEquals(resolveSavedRecipient(null), null);
  assertEquals(resolveSavedRecipient(undefined), null);
  Deno.env.delete("DIGEST_EMAIL");
  Deno.env.delete("MAINTAINER_EMAIL");
});
