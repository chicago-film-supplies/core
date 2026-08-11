import { assertEquals } from "@std/assert";
import { Address, isIllinoisPostcode, toRegionCode, toUsStateCode } from "../src/schemas/mod.ts";

// ── toUsStateCode ────────────────────────────────────────────────
//
// The corpus this exists for: 458 prod destinations, 409 spelled `"IL"` and 48
// not — but **18 of those 48 are Illinois spelled `"Illinois"`**, 13 of them
// Chicago. A `region !== "IL"` out-of-state test would zero the tax on all 18.

Deno.test("toUsStateCode: a full name resolves to its USPS code", () => {
  assertEquals(toUsStateCode("Illinois"), "IL");
  assertEquals(toUsStateCode("Missouri"), "MO");
  assertEquals(toUsStateCode("Wisconsin"), "WI");
  assertEquals(toUsStateCode("Iowa"), "IA");
  assertEquals(toUsStateCode("New York"), "NY");
  assertEquals(toUsStateCode("Mississippi"), "MS");
});

Deno.test("toUsStateCode: an existing code passes through, case- and space-insensitively", () => {
  assertEquals(toUsStateCode("IL"), "IL");
  assertEquals(toUsStateCode("il"), "IL");
  assertEquals(toUsStateCode(" IL "), "IL");
  assertEquals(toUsStateCode("new   york"), "NY");
});

Deno.test("toUsStateCode: unresolvable input is null, never a guess", () => {
  // `null` means UNKNOWN. Every consequential caller has to treat it
  // conservatively rather than as "not Illinois" — see `_usState.ts`.
  assertEquals(toUsStateCode(""), null);
  assertEquals(toUsStateCode("   "), null);
  assertEquals(toUsStateCode(null), null);
  assertEquals(toUsStateCode(undefined), null);
  assertEquals(toUsStateCode("Ontario"), null);
  assertEquals(toUsStateCode("Illinoise"), null);
  // Two letters that are not a state code must not be blessed just for being
  // two letters — this is what a bare `.toUpperCase()` would get wrong.
  assertEquals(toUsStateCode("XX"), null);
  assertEquals(toUsStateCode("UK"), null);
});

Deno.test("toUsStateCode: is idempotent", () => {
  for (const input of ["Illinois", "IL", "il", "Missouri", "Ontario", ""]) {
    const once = toRegionCode(input);
    assertEquals(toRegionCode(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

// ── toRegionCode (the stored form) ───────────────────────────────

Deno.test("toRegionCode: normalizes rather than validates", () => {
  assertEquals(toRegionCode("Illinois"), "IL");
  // An unresolvable region is TRIMMED and kept, not rejected and not blanked.
  // `Address` is shared by destinations, orgs, orders and invoices and its
  // `region` is legitimately blank on plenty of prod documents; rejecting would
  // turn a data-quality problem into a failed order write.
  assertEquals(toRegionCode("  Ontario "), "Ontario");
  assertEquals(toRegionCode(""), "");
});

Deno.test("Address parses region through the canonicalizer", () => {
  const parsed = Address.parse({ city: "Chicago", region: "Illinois", postcode: "60607" });
  assertEquals((parsed as { region: string }).region, "IL");
});

Deno.test("Address still accepts a region it cannot resolve", () => {
  const parsed = Address.parse({ city: "Toronto", region: "Ontario" });
  assertEquals((parsed as { region: string }).region, "Ontario");
});

// ── isIllinoisPostcode (the cross-check, not the answer) ─────────

Deno.test("isIllinoisPostcode: 600xx–629xx", () => {
  assertEquals(isIllinoisPostcode("60607"), true);
  assertEquals(isIllinoisPostcode("62999"), true);
  assertEquals(isIllinoisPostcode("60000"), true);
  assertEquals(isIllinoisPostcode("59999"), false);
  assertEquals(isIllinoisPostcode("63000"), false);
});

Deno.test("isIllinoisPostcode: ZIP+4 reads the first five", () => {
  assertEquals(isIllinoisPostcode("61826-8848"), true);
});

Deno.test("isIllinoisPostcode: malformed input is false, not a throw", () => {
  // Prod carries a LaPorte, Indiana destination at postcode "4635".
  assertEquals(isIllinoisPostcode("4635"), false);
  assertEquals(isIllinoisPostcode(""), false);
  assertEquals(isIllinoisPostcode(null), false);
  assertEquals(isIllinoisPostcode("abcde"), false);
});
