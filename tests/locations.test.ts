import { assertEquals } from "@std/assert";
import { normalizeLocationName } from "../src/utils/locations.ts";

// ── normalizeLocationName ───────────────────────────────────────────

Deno.test("normalizeLocationName folds case", () => {
  assertEquals(normalizeLocationName("Shelf A"), "shelf a");
  assertEquals(normalizeLocationName("SHELF A"), "shelf a");
  assertEquals(normalizeLocationName("shelf a"), "shelf a");
});

Deno.test("normalizeLocationName treats separators as interchangeable", () => {
  // hyphen, slash, underscore, and multiple spaces all fold to the same key
  const key = "shelf a";
  assertEquals(normalizeLocationName("Shelf-A"), key);
  assertEquals(normalizeLocationName("SHELF / A"), key);
  assertEquals(normalizeLocationName("Shelf_A"), key);
  assertEquals(normalizeLocationName("Shelf   A"), key);
  assertEquals(normalizeLocationName("  Shelf A  "), key);
});

Deno.test("normalizeLocationName keeps a missing separator significant", () => {
  // "Shelfa" is NOT the same bin as "Shelf A"
  assertEquals(normalizeLocationName("Shelfa"), "shelfa");
  assertEquals(normalizeLocationName("Shelfa") === normalizeLocationName("Shelf A"), false);
});

Deno.test("normalizeLocationName folds diacritics", () => {
  assertEquals(normalizeLocationName("Café 1"), "cafe 1");
  assertEquals(normalizeLocationName("naïve"), "naive");
});

Deno.test("normalizeLocationName collapses a pure-separator name to empty", () => {
  // No alphanumerics → empty key. Two such names collide, which is correct
  // under "separators are insignificant".
  assertEquals(normalizeLocationName("---"), "");
  assertEquals(normalizeLocationName("  /  "), "");
});

Deno.test("normalizeLocationName is idempotent", () => {
  const once = normalizeLocationName("Shelf / A-1");
  assertEquals(normalizeLocationName(once), once);
});
