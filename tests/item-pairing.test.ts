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
