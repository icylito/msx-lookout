import { assert, assertEquals, assertGreater, assertLess } from "jsr:@std/assert@1";

// These are the failure stories from 2026-09-08: if the chrome stack, overlay
// stacking, or tab-switch scroll ever regresses, the same visual bugs come back.
// Reading the static HTML is the seam — index.html isn't type-checked, and
// Playwright isn't in the stack.

const html = await Deno.readTextFile(new URL("./web/index.html", import.meta.url));

function cssBlock(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (^|\\n)\\s* so ".settings-nav {" cannot satisfy a search for "nav {"
  const re = new RegExp("(^|\\n)\\s*" + esc + "\\s*\\{([^}]+)\\}");
  const m = html.match(re);
  assert(m, `missing CSS block for ${selector}`);
  return m[2];
}
function zIndex(selector: string): number {
  const m = cssBlock(selector).match(/z-index\s*:\s*(\d+)/);
  assert(m, `missing z-index on ${selector}`);
  return Number(m[1]);
}

Deno.test("chrome wraps tbar + header + nav so they cannot scroll away independently", () => {
  const chrome = html.indexOf('<div id="chrome">');
  const tbar = html.indexOf('<div id="tbar">');
  const header = html.indexOf("<header>");
  const nav = html.indexOf("<nav>");
  const navEnd = html.indexOf("</nav>");
  const main = html.indexOf("<main>");
  assert(chrome >= 0 && tbar > chrome && header > tbar && nav > header);
  assert(navEnd > nav && navEnd < main);
  const between = html.slice(navEnd, main);
  assert(between.includes("</div>"), "chrome must close after nav, before main");
});

Deno.test("chrome is sticky at the top of the viewport", () => {
  const block = cssBlock("#chrome");
  assert(block.includes("position: sticky") || block.includes("position:sticky"));
  assert(/top\s*:\s*0/.test(block));
});

Deno.test("header itself is not sticky — that was what covered the tabs on scroll", () => {
  const block = cssBlock("header");
  assert(!/position\s*:\s*sticky/.test(block));
});

Deno.test("nav gap above the tabs is padding, not margin, so rows cannot show through", () => {
  const block = cssBlock("nav");
  assert(/padding\s*:\s*34px/.test(block));
  assert(!/margin\s*:\s*34px/.test(block));
});

Deno.test("loading overlay cannot paint over chrome; settings modal still can", () => {
  const chrome = zIndex("#chrome");
  const overlay = zIndex(".loading-overlay");
  const modal = zIndex("#settings-modal");
  assertGreater(chrome, overlay);
  assertLess(chrome, modal);
});

Deno.test("switching tabs always jumps to the top of the page", () => {
  assert(html.includes("window.scrollTo(0, 0)"));
});

Deno.test("updater: frequency row and version line have breathing room", () => {
  assert(html.includes(".settings-group .freq-toggle + .mut"));
  assert(html.includes("#app-update-group #app-version-text"));
  assertEquals(cssBlock(".settings-group .freq-toggle + .mut").includes("margin-top"), true);
});

Deno.test("window close and settings close have different names so a modal dismiss cannot quit the app", () => {
  assert(html.includes('id="tbar-close" aria-label="Close window"'));
  assert(html.includes('id="settings-close" aria-label="Close settings"'));
});
