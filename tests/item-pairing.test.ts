import { assertEquals } from "@std/assert";
import { mapPathsAcrossRebuild } from "../src/utils/item-pairing.ts";

// Dividers are bare UUIDs (structural, dropped from a component ancestry);
// anything else is product-shaped.
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";

Deno.test("mapPathsAcrossRebuild — a kit component merged into a same-product line pairs the survivor with ITS OWN occurrence (api-cloudrun#1147 repro A)", () => {
  // Prev: kit K (with component X) in G1 comes first, a standalone X in G2 after it.
  const prev = [
    { uid: "K", path: [G1, "K"] },
    { uid: "X", path: [G1, "K", "X"] },
    { uid: "X", path: [G2, "X"] },
  ];
  // Next: the kit's X was merged into G2's standalone X.
  const next = [
    { uid: "K", path: [G1, "K"] },
    { uid: "X", path: [G2, "X"] },
  ];
  const map = mapPathsAcrossRebuild(prev, next);
  assertEquals(map.fromPath([G2, "X"]), [G2, "X"]);
  assertEquals(map.toPath([G1, "K", "X"]), undefined);
});

Deno.test("mapPathsAcrossRebuild — a component dragged out of its kit still reads as MOVED (the (uid, k) fallback)", () => {
  const prev = [
    { uid: "K", path: [G1, "K"] },
    { uid: "X", path: [G1, "K", "X"] },
  ];
  const next = [
    { uid: "K", path: [G1, "K"] },
    { uid: "X", path: [G2, "X"] },
  ];
  const map = mapPathsAcrossRebuild(prev, next);
  assertEquals(map.toPath([G1, "K", "X"]), [G2, "X"]);
});

Deno.test("mapPathsAcrossRebuild — the signature ignores dividers, so a group move keeps the pairing", () => {
  const prev = [{ uid: "K", path: [G1, "K"] }, { uid: "X", path: [G1, "K", "X"] }];
  const next = [{ uid: "K", path: [G2, "K"] }, { uid: "X", path: [G2, "K", "X"] }];
  const map = mapPathsAcrossRebuild(prev, next);
  assertEquals(map.toPath([G1, "K", "X"]), [G2, "K", "X"]);
});

Deno.test("mapPathsAcrossRebuild — the bare two-row form of repro A", () => {
  // The same input as repro A, with the kit's X first: a uid-only pairing maps
  // next's G2/X back to the REMOVED kit occurrence (both tests fail on it).
  const prev = [{ uid: "X", path: [G1, "K", "X"] }, { uid: "X", path: [G2, "X"] }];
  const next = [{ uid: "X", path: [G2, "X"] }];
  assertEquals(mapPathsAcrossRebuild(prev, next).fromPath([G2, "X"]), [G2, "X"]);
});

// ── exact path first (api-cloudrun rental-extension Phase 1.4) ──
//
// The signature drops dividers, so the same product on two LEGS shares one
// signature key and k-th-in-document-order decides between them. An unchanged
// path is the same row by definition, so it must pair before any key does.

Deno.test("mapPathsAcrossRebuild — an unchanged path pairs with itself when a new leg holding the product is placed BEFORE it", () => {
  // Prev: leg A holds P. Next: an extension leg B, placed first, also holds P.
  const prev = [{ uid: "P", path: [G1, "P"] }];
  const next = [{ uid: "P", path: [G2, "P"] }, { uid: "P", path: [G1, "P"] }];
  const map = mapPathsAcrossRebuild(prev, next);
  // k-th pairing reads A's row as moved to B and A's surviving row as new.
  assertEquals(map.toPath([G1, "P"]), [G1, "P"]);
  assertEquals(map.fromPath([G1, "P"]), [G1, "P"]);
  assertEquals(map.fromPath([G2, "P"]), undefined);
});

Deno.test("mapPathsAcrossRebuild — reordering two legs that hold the same product keeps each row on its own leg", () => {
  const prev = [
    { uid: "K", path: [G1, "K"] },
    { uid: "X", path: [G1, "K", "X"] },
    { uid: "K", path: [G2, "K"] },
    { uid: "X", path: [G2, "K", "X"] },
  ];
  const next = [prev[2], prev[3], prev[0], prev[1]];
  const map = mapPathsAcrossRebuild(prev, next);
  for (const row of prev) assertEquals(map.toPath(row.path), row.path);
});
