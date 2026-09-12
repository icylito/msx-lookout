import { assertEquals } from "jsr:@std/assert@1";
import { priceRowIssue, shouldFireAlert } from "./rules.ts";

Deno.test("priceRowIssue: accepts a normal row", () => {
  assertEquals(priceRowIssue({ symbol: "BKMB", close: 1.4, prevClose: 1.38, high: 1.41, low: 1.37 }), null);
});

Deno.test("priceRowIssue: drops close <= 0 or null", () => {
  assertEquals(priceRowIssue({ symbol: "X", close: 0, prevClose: 1, high: null, low: null }), "X: close=0");
  assertEquals(priceRowIssue({ symbol: "X", close: -1, prevClose: 1, high: null, low: null }), "X: close=-1");
  assertEquals(priceRowIssue({ symbol: "X", close: null, prevClose: 1, high: null, low: null }), "X: close=null");
});

Deno.test("priceRowIssue: drops high < low", () => {
  assertEquals(priceRowIssue({ symbol: "X", close: 1, prevClose: 1, high: 0.5, low: 0.9 }), "X: high<low");
});

Deno.test("priceRowIssue: drops a >25% single-day move", () => {
  assertEquals(
    priceRowIssue({ symbol: "X", close: 1.3, prevClose: 1.0, high: 1.3, low: 1.0 }),
    "X: 1->1.3 moved >25%",
  );
});

Deno.test("priceRowIssue: keeps a move at exactly 25% (boundary is inclusive)", () => {
  assertEquals(priceRowIssue({ symbol: "X", close: 1.25, prevClose: 1.0, high: 1.25, low: 1.0 }), null);
});

Deno.test("priceRowIssue: no prevClose (0 or null) skips the move check instead of dividing by zero", () => {
  assertEquals(priceRowIssue({ symbol: "X", close: 5, prevClose: 0, high: null, low: null }), null);
  assertEquals(priceRowIssue({ symbol: "X", close: 5, prevClose: null, high: null, low: null }), null);
});

Deno.test("shouldFireAlert: 'below' fires at or under the threshold", () => {
  assertEquals(shouldFireAlert("below", 1.4, 1.4), true);
  assertEquals(shouldFireAlert("below", 1.4, 1.39), true);
  assertEquals(shouldFireAlert("below", 1.4, 1.41), false);
});

Deno.test("shouldFireAlert: 'above' fires at or over the threshold", () => {
  assertEquals(shouldFireAlert("above", 1.4, 1.4), true);
  assertEquals(shouldFireAlert("above", 1.4, 1.41), true);
  assertEquals(shouldFireAlert("above", 1.4, 1.39), false);
});

Deno.test("shouldFireAlert: unknown condition does not fire", () => {
  assertEquals(shouldFireAlert("sideways", 1.4, 1.5), false);
  assertEquals(shouldFireAlert("", 1.4, 1.0), false);
});
