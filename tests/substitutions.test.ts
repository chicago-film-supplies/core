import { assert, assertEquals, assertFalse } from "@std/assert";

import {
  collectSubstitutionAnchors,
  findSubtreeAnchor,
  isAtOrBelow,
  isInSubstitutedSubtree,
  isRemovedBySubstitution,
  isStrictlyBelow,
} from "../src/utils/substitutions.ts";

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

Deno.test("collectSubstitutionAnchors: only rows carrying path_substituted_for", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "a"] },
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
    { path: ["d", "y", "c1"] },
    { path: ["d", "b"], path_substituted_for: undefined },
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
    { path: ["d", "y"], path_substituted_for: [] },
  ]);
  assertEquals(fromSeed, []);
  assertFalse(
    isRemovedBySubstitution(["completely", "unrelated"], fromSeed),
    "an empty substitutedFor must license NOTHING, not everything",
  );

  // The mirror: an anchor with no path of its own would put every row in the
  // document inside its subtree.
  const noOwnPath = collectSubstitutionAnchors([
    { path: [], path_substituted_for: ["d", "x"] },
  ]);
  assertEquals(noOwnPath, []);
  assertFalse(isInSubstitutedSubtree(["completely", "unrelated"], noOwnPath));
});

Deno.test("isRemovedBySubstitution: X itself is explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assert(isRemovedBySubstitution(["d", "x"], anchors));
});

Deno.test("isRemovedBySubstitution: X's whole component subtree is explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assert(isRemovedBySubstitution(["d", "x", "c1"], anchors));
  assert(isRemovedBySubstitution(["d", "x", "c1", "c2"], anchors));
});

Deno.test("isRemovedBySubstitution: an unrelated row is NOT explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
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
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assert(isRemovedBySubstitution(["d", "x"], anchors));
  assertFalse(isRemovedBySubstitution(["d", "y"], anchors));
});

// ── subtree: read from the Y side ────────────────────────────────

Deno.test("isInSubstitutedSubtree: Y's components are explained", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
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
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assertFalse(isInSubstitutedSubtree(["d", "y"], anchors));
});

Deno.test("isInSubstitutedSubtree: X's surviving descendants are not explained as additions", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assertFalse(isInSubstitutedSubtree(["d", "x", "c1"], anchors));
});

// ── nested kits ──────────────────────────────────────────────────

Deno.test("findSubtreeAnchor: returns the NEAREST enclosing anchor", () => {
  const anchors = collectSubstitutionAnchors([
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
    { path: ["d", "y", "c1", "y2"], path_substituted_for: ["d", "y", "c1", "x2"] },
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
    { path: ["d", "y"], path_substituted_for: ["d", "x"] },
  ]);
  assertEquals(findSubtreeAnchor(["d", "z", "c1"], anchors), undefined);
  assertEquals(findSubtreeAnchor(["d", "y"], anchors), undefined);
});
