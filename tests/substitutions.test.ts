import { assert, assertEquals, assertFalse } from "@std/assert";

import {
  collectSubstitutionAnchors,
  findSubtreeAnchor,
  isAtOrBelow,
  isInSubstitutedSubtree,
  isRemovedBySubstitution,
  isStrictlyBelow,
  overclaimedReplacements,
  repointReplaces,
  standInUnits,
  substitutionResync,
} from "../src/utils/substitutions.ts";
import { SubstitutedForList } from "../src/schemas/common.ts";
import { mapPathsAcrossRebuild } from "../src/utils/item-pairing.ts";

/**
 * The path algebra behind every substitution guard, on both surfaces.
 *
 * ⚠️ **These arms MOVED here from
 * `api-cloudrun/tests/unit/substitutedSubtree.test.ts` with the code they
 * cover**, when the invoice sync became the fourth, fifth and sixth caller and
 * the predicate's home in `api-cloudrun` became wrong. What stayed behind is
 * `itemsWithSubstitutions` — the booking projection's input, which reads
 * `price.total_cents` and belongs to the order→booking projection rather than
 * to the predicate.
 *
 * The guards that CONSUME these predicates are exercised where they live:
 * api-cloudrun's `tests/integration/fulfillment/` for the wire boundary, and
 * `tests/invoices.test.ts` here for the order→invoice sync.
 */


// ── the prefix test itself ───────────────────────────────────────

Deno.test("isAtOrBelow: a path is at-or-below itself", () => {
  assert(isAtOrBelow(["d", "x"], ["d", "x"]));
});

Deno.test("isAtOrBelow: a proper prefix is an ancestor", () => {
  assert(isAtOrBelow(["d", "x", "c1"], ["d", "x"]));
  assert(isAtOrBelow(["d", "x", "c1", "c2"], ["d", "x"]));
});

Deno.test("isAtOrBelow: a longer candidate ancestor is never one", () => {
  assertFalse(isAtOrBelow(["d", "x"], ["d", "x", "c1"]));
});

Deno.test("isAtOrBelow: a sibling is not an ancestor", () => {
  assertFalse(isAtOrBelow(["d", "y"], ["d", "x"]));
});

/**
 * 🔴 The arm this module exists in its own file for.
 *
 * Every other path comparison on this surface goes through a `join("\x1f")` key,
 * and reusing that instinct for the PREFIX test is wrong with any separator:
 * `["a","b"].join()` is a string prefix of `["a","bc"].join()`, so a
 * `startsWith` reports an unrelated sibling's component as part of a substituted
 * subtree — which would let a submission remove rows it never named.
 *
 * Fails against a `pathKey(a).startsWith(pathKey(b))` implementation; passes
 * against the element-wise one.
 */
Deno.test("isAtOrBelow: a uid that EXTENDS another is not a descendant of it", () => {
  assertFalse(isAtOrBelow(["d", "bc"], ["d", "b"]));
  assertFalse(isAtOrBelow(["d", "bc", "c1"], ["d", "b"]));
  // …and the genuine descendant of the same short uid still resolves.
  assert(isAtOrBelow(["d", "b", "c1"], ["d", "b"]));
});

Deno.test("isStrictlyBelow: excludes the row itself", () => {
  assertFalse(isStrictlyBelow(["d", "x"], ["d", "x"]));
  assert(isStrictlyBelow(["d", "x", "c1"], ["d", "x"]));
});

// ── anchors ──────────────────────────────────────────────────────

Deno.test("collectSubstitutionAnchors: only rows carrying substituted_for", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "a"] },
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
    { path: ["d", "y", "c1"] },
    { path: ["d", "b"], substituted_for: undefined },
    { path: ["d", "e"], substituted_for: [] },
  ]);
  assertEquals(anchors.length, 1);
  assertEquals(anchors[0].path, ["d", "y"]);
  assertEquals(anchors[0].substitutedFor, ["d", "x"]);
});

// ── removal: read from the X side ────────────────────────────────

Deno.test("collectSubstitutionAnchors: an EMPTY path on either side is not an anchor", () => {
  // 🔴 `[]` is a prefix of every path, so one empty anchor explains the entire
  // document — every guard relaxed at once, silently, in the permissive
  // direction. Reachable rather than theoretical: the field is `.optional()`
  // with no `.min(1)` and `getInitialValues` materializes an optional array as
  // `[]`, so any line seeded from the schema carries one.
  const fromSeed = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: [], quantity: 1 }] },
  ]);
  assertEquals(fromSeed, []);
  assertFalse(
    isRemovedBySubstitution(["completely", "unrelated"], fromSeed),
    "an empty substitutedFor must license NOTHING, not everything",
  );

  // The mirror: an anchor with no path of its own would put every row in the
  // document inside its subtree.
  const noOwnPath = collectSubstitutionAnchors([
    { path: [], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assertEquals(noOwnPath, []);
  assertFalse(isInSubstitutedSubtree(["completely", "unrelated"], noOwnPath));
});

Deno.test("isRemovedBySubstitution: X itself is explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assert(isRemovedBySubstitution(["d", "x"], anchors));
});

Deno.test("isRemovedBySubstitution: X's whole component subtree is explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assert(isRemovedBySubstitution(["d", "x", "c1"], anchors));
  assert(isRemovedBySubstitution(["d", "x", "c1", "c2"], anchors));
});

Deno.test("isRemovedBySubstitution: an unrelated row is NOT explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assertFalse(isRemovedBySubstitution(["d", "z"], anchors));
  assertFalse(isRemovedBySubstitution(["d", "z", "c1"], anchors));
  // The omission guard keeps its teeth with no anchors at all.
  assertFalse(isRemovedBySubstitution(["d", "x"], []));
});

/**
 * 🔴 The two path fields are NOT interchangeable, and swapping them is the
 * failure this module's shape exists to prevent: Y's own path licenses
 * ADDITIONS, X's licenses REMOVALS. An implementation that read `path` here
 * would explain the absence of a row the submission never mentioned.
 */
Deno.test("isRemovedBySubstitution: reads substitutedFor, never the anchor's own path", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assert(isRemovedBySubstitution(["d", "x"], anchors));
  assertFalse(isRemovedBySubstitution(["d", "y"], anchors));
});

// ── subtree: read from the Y side ────────────────────────────────

Deno.test("isInSubstitutedSubtree: Y's components are explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assert(isInSubstitutedSubtree(["d", "y", "c1"], anchors));
  assert(isInSubstitutedSubtree(["d", "y", "c1", "c2"], anchors));
});

/**
 * ⚠️ Y is validated by the substitution branch (in-place path, live
 * `Product.alternates[]`). Admitting it here as well would let a row license
 * its own presence and skip that branch entirely.
 */
Deno.test("isInSubstitutedSubtree: Y is NOT inside its own subtree", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assertFalse(isInSubstitutedSubtree(["d", "y"], anchors));
});

Deno.test("isInSubstitutedSubtree: X's surviving descendants are not explained as additions", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assertFalse(isInSubstitutedSubtree(["d", "x", "c1"], anchors));
});

// ── nested kits ──────────────────────────────────────────────────

Deno.test("findSubtreeAnchor: returns the NEAREST enclosing anchor", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
    { path: ["d", "y", "c1", "y2"], substituted_for: [{ path: ["d", "y", "c1", "x2"], quantity: 1 }] },
  ]);
  // A component of the inner substitution belongs to the inner anchor — the
  // product whose `components[]` must sanction it.
  assertEquals(findSubtreeAnchor(["d", "y", "c1", "y2", "c9"], anchors)?.path, [
    "d",
    "y",
    "c1",
    "y2",
  ]);
  // A component of the outer one still resolves to the outer.
  assertEquals(findSubtreeAnchor(["d", "y", "c1"], anchors)?.path, ["d", "y"]);
});

Deno.test("findSubtreeAnchor: undefined when nothing encloses the path", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], substituted_for: [{ path: ["d", "x"], quantity: 1 }] },
  ]);
  assertEquals(findSubtreeAnchor(["d", "z", "c1"], anchors), undefined);
  assertEquals(findSubtreeAnchor(["d", "y"], anchors), undefined);
});

// ── substituted_for (manager#414, Track S1) ──────────────────────────────────

Deno.test("collectSubstitutionAnchors: a substituted_for subtree anchors at its ROOT only, one anchor per X", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], quantity: 5, substituted_for: [{ path: ["d", "x1"], quantity: 2 }, { path: ["d", "x2"], quantity: 1 }] },
    { path: ["d", "y", "c"], quantity: 10, substituted_for: [{ path: ["d", "x1"], quantity: 4 }] },
  ]);
  assertEquals(anchors.map((a) => [a.path.join("/"), a.substitutedFor.join("/"), a.quantity]), [
    ["d/y", "d/x1", 2],
    ["d/y", "d/x2", 1],
  ]);
});

Deno.test("standInUnits: sums only entries whose X is live", () => {
  const row = { path: ["d", "y"], substituted_for: [{ path: ["d", "x1"], quantity: 2 }, { path: ["d", "x2"], quantity: 1 }] };
  assertEquals(standInUnits(row, new Set(["d/x1", "d/x2"])), 3);
  assertEquals(standInUnits(row, new Set(["d/x2"])), 1);
  assertEquals(standInUnits({ path: ["d", "y"] }, new Set(["d/x"])), 0);
});

Deno.test("SubstitutedForList: entries are unique by path, and a path and a positive quantity are required", () => {
  const d = "Dest1AAAAAAAAAAAAAAA", x = "ProdXAAAAAAAAAAAAAAA", w = "ProdWAAAAAAAAAAAAAAA";
  assert(SubstitutedForList.safeParse([{ path: [d, x], quantity: 2 }, { path: [d, w], quantity: 1 }]).success);
  assertFalse(SubstitutedForList.safeParse([{ path: [d, x], quantity: 2 }, { path: [d, x], quantity: 1 }]).success);
  assertFalse(SubstitutedForList.safeParse([{ path: [], quantity: 2 }]).success);
  assertFalse(SubstitutedForList.safeParse([{ path: [d, x], quantity: 0 }]).success);
});

// ── substitutionResync (manager#414, S2) ─────────────────────────

const line = (path: string[], quantity: number) => ({ type: "rental", path, quantity });

Deno.test("substitutionResync: merged Y reads order-equivalent, and re-offsets on the next order", () => {
  const X = ["d", "x"], Y = ["d", "y"];
  const rows = [{ path: Y, quantity: 4, substituted_for: [{ path: X, quantity: 2 }] }];
  const r = substitutionResync(rows, [line(X, 2), line(Y, 2)], [line(X, 2), line(Y, 3)]);
  assertEquals(r.orderEquivalent(Y, rows[0]), 2);
  assertEquals(r.reoffset(Y, rows[0].substituted_for, 3), {
    quantity: 5,
    substituted_for: [{ path: X, quantity: 2 }],
    substituted: true,
  });
});

Deno.test("substitutionResync: a partial X is credited, its components by the order's ratio", () => {
  const X = ["d", "x"], C = ["d", "x", "c"], Y = ["d", "y"];
  const rows = [{ path: Y, quantity: 1, substituted_for: [{ path: X, quantity: 1 }] }];
  const order = [line(X, 4), line(C, 8)];
  const r = substitutionResync(rows, order, order);
  assertEquals(r.orderEquivalent(X, { path: X, quantity: 3 }), 4);
  assertEquals(r.orderEquivalent(C, { path: C, quantity: 6 }), 8);
  assertEquals(r.reoffset(C, undefined, 8).quantity, 6);
});

Deno.test("substitutionResync: X gone from the next order drops the entry WITH its units", () => {
  const X = ["d", "x"], Y = ["d", "y"];
  const entries = [{ path: X, quantity: 2 }];
  const r = substitutionResync([{ path: Y, quantity: 4, substituted_for: entries }], [line(X, 2), line(Y, 2)], [line(Y, 2)]);
  assertEquals(r.anchorsNext, []);
  assertEquals(r.reoffset(Y, entries, 2), { quantity: 2, substituted_for: undefined, substituted: true });
});

Deno.test("substitutionResync: an entry already spent on the previous order keeps its units", () => {
  const X = ["d", "x"], Y = ["d", "y"];
  const entries = [{ path: X, quantity: 2 }];
  const r = substitutionResync([{ path: Y, quantity: 4, substituted_for: entries }], [line(Y, 2)], [line(Y, 2)]);
  const equivalent = r.orderEquivalent(Y, { path: Y, quantity: 4, substituted_for: entries });
  assertEquals(equivalent, 4, "nothing live to subtract");
  assertEquals(r.reoffset(Y, entries, equivalent), { quantity: 4, substituted_for: undefined, substituted: true });
});

Deno.test("substitutionResync: X reparented re-points the entry", () => {
  const X = ["d", "g1", "x"], X2 = ["d", "g2", "x"], Y = ["d", "g1", "y"];
  const entries = [{ path: X, quantity: 2 }];
  const r = substitutionResync(
    [{ path: Y, quantity: 2, substituted_for: entries }],
    [line(X, 2)],
    [line(X2, 2)],
    (p) => (p.join("/") === X.join("/") ? X2 : undefined),
  );
  assertEquals(r.reoffset(Y, entries, 0).substituted_for, [{ path: X2, quantity: 2 }]);
});

// ── repointReplaces — a swap's pointer follows X (api-cloudrun#1114) ─────

Deno.test("repointReplaces: an entry naming a row that is there is kept as it is", () => {
  const r = repointReplaces([{ path: ["L", "X"], quantity: 2, reason: "damaged" }], [{ path: ["L", "X"] }]);
  assertEquals(r, [{ path: ["L", "X"], quantity: 2, reason: "damaged" }]);
});

Deno.test("repointReplaces: X regrouped — the map carries the entry to X's new path", () => {
  const prev = [{ uid: "X", path: ["L", "X"] }];
  const next = [{ uid: "G", path: ["L", "G"] }, { uid: "X", path: ["L", "G", "X"] }];
  const r = repointReplaces([{ path: ["L", "X"], quantity: 1, reason: "damaged" }], next, [mapPathsAcrossRebuild(prev, next)]);
  assertEquals(r, [{ path: ["L", "G", "X"], quantity: 1, reason: "damaged" }]);
});

Deno.test("🔴 repointReplaces: X substituted away — NOT moved onto the stand-in; which unit broke is the operator's fact", () => {
  const rows = [{ path: ["L", "Z"], substituted_for: [{ path: ["L", "X"], quantity: 1 }] }];
  assertEquals(repointReplaces([{ path: ["L", "X"], quantity: 1, reason: "damaged" }], rows), [{ path: ["L", "X"], quantity: 1, reason: "damaged" }]);
});

Deno.test("🔴 repointReplaces: X gone — the entry is KEPT verbatim, a difference to surface, never dropped", () => {
  const r = repointReplaces([{ path: ["L", "X"], quantity: 3, reason: "damaged" }], [{ path: ["L", "Y"] }]);
  assertEquals(r, [{ path: ["L", "X"], quantity: 3, reason: "damaged" }]);
});

Deno.test("repointReplaces: two entries landing on one row MERGE, so the list stays unique by path", () => {
  // X moved onto the path another entry already names — `SwapReplacementList`
  // refuses a duplicate path, so the result must sum rather than repeat.
  const moved = { toPath: (p: readonly string[] | undefined) => (p?.join("/") === "L/Xold" ? ["L", "X"] : undefined) };
  const r = repointReplaces(
    [{ path: ["L", "X"], quantity: 1, reason: "damaged" }, { path: ["L", "Xold"], quantity: 2, reason: "damaged" }],
    [{ path: ["L", "X"] }],
    [moved],
  );
  assertEquals(r, [{ path: ["L", "X"], quantity: 3, reason: "damaged" }]);
});

Deno.test("repointReplaces: the reason is carried, and one row under two reasons stays TWO entries", () => {
  const r = repointReplaces(
    [{ path: ["L", "X"], quantity: 2, reason: "cleaning" }, { path: ["L", "X"], quantity: 1, reason: "damaged" }],
    [{ path: ["L", "X"] }],
  );
  assertEquals(r, [
    { path: ["L", "X"], quantity: 2, reason: "cleaning" },
    { path: ["L", "X"], quantity: 1, reason: "damaged" },
  ]);
});

// ── overclaimedReplacements — the authoring cap (api-cloudrun#1116) ──────

const row = (path: string[], quantity: number, replaces?: Array<{ path: string[]; quantity: number }>) => ({
  path,
  quantity,
  replaces: replaces?.map((e) => ({ ...e, reason: "damaged" as const })),
});

Deno.test("overclaimedReplacements: swaps within the row's quantity report nothing", () => {
  const next = [row(["R", "X"], 5), row(["S1", "Y"], 2, [{ path: ["R", "X"], quantity: 2 }]), row(["S2", "Y"], 3, [{ path: ["R", "X"], quantity: 3 }])];
  assertEquals(overclaimedReplacements([], next), []);
});

Deno.test("overclaimedReplacements: a new swap pushing the SUM over the row is reported", () => {
  const prev = [row(["R", "X"], 5), row(["S1", "Y"], 4, [{ path: ["R", "X"], quantity: 4 }])];
  const next = [...prev, row(["S2", "Y"], 2, [{ path: ["R", "X"], quantity: 2 }])];
  assertEquals(overclaimedReplacements(prev, next), [{ path: ["R", "X"], quantity: 5, claimed: 6 }]);
});

Deno.test("🔴 overclaimedReplacements: lowering X under an EXISTING claim is not refused — a difference, not a write error", () => {
  const prev = [row(["R", "X"], 5), row(["S1", "Y"], 4, [{ path: ["R", "X"], quantity: 4 }])];
  const next = [row(["R", "X"], 3), row(["S1", "Y"], 4, [{ path: ["R", "X"], quantity: 4 }])];
  assertEquals(overclaimedReplacements(prev, next), []);
});

Deno.test("overclaimedReplacements: a chained claim counts against the earlier swap's row, not the root's", () => {
  const next = [
    row(["R", "X"], 1),
    row(["S1", "Y"], 1, [{ path: ["R", "X"], quantity: 1 }]),
    row(["S2", "Y"], 1, [{ path: ["S1", "Y"], quantity: 1 }]),
  ];
  assertEquals(overclaimedReplacements([], next), []);
});

Deno.test("overclaimedReplacements: a dangling entry is skipped", () => {
  assertEquals(overclaimedReplacements([], [row(["S1", "Y"], 9, [{ path: ["R", "gone"], quantity: 9 }])]), []);
});
