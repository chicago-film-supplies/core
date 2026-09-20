/**
 * The destination property → unit tree — {@link computeDestinationNode} and the
 * six one-document invariants on `DestinationSchema`.
 *
 * 🔴 **Every invariant is planted in BOTH directions.** A guard that only ever
 * sees well-formed input reports clean for the wrong reason, and the correct
 * assertion differs by level — a property states a jurisdiction and has no line
 * 2, a unit is the exact opposite. A one-polarity check passes against a
 * constant-false guard.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DestinationSchema } from "../src/schemas/destination.ts";
import {
  applyDestinationStreet2,
  computeDestinationNode,
  destinationLevel,
  destinationOwnName,
  destinationParentUid,
  destinationPropertyUid,
  isDestinationProperty,
  isDestinationUnit,
  resolveDestinationJurisdictionSeed,
} from "../src/utils/destinations.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

const PROPERTY_UID = "testprop10000000000a";
const UNIT_UID = "testunit10000000000a";

function address(over: Record<string, unknown> = {}) {
  return {
    city: "Chicago",
    country_name: "US",
    full: "2558 W 16th St",
    name: "Cinespace",
    postcode: "60608",
    region: "IL",
    street: "2558 W 16th St",
    ...over,
  };
}

/** The property root, exactly as the migration writes it. */
function property(over: Record<string, unknown> = {}) {
  const node = computeDestinationNode({ uid: PROPERTY_UID, name: "Cinespace" }, null);
  return {
    uid: PROPERTY_UID,
    address: address(),
    mapbox_ids: [],
    path: node.path,
    query_by_path: node.query_by_path,
    jurisdiction: null,
    ...ts,
    ...over,
  };
}

/** A unit hung under it. */
function unit(over: Record<string, unknown> = {}) {
  const parent = property();
  const node = computeDestinationNode({ uid: UNIT_UID, name: "Stage 25" }, parent);
  return {
    uid: UNIT_UID,
    address: applyDestinationStreet2(address(), node.street2),
    mapbox_ids: [],
    path: node.path,
    query_by_path: node.query_by_path,
    ...ts,
    ...over,
  };
}

// ── computeDestinationNode ────────────────────────────────────────────────

Deno.test("computeDestinationNode: a property is a path of ONE and has no line 2", () => {
  const n = computeDestinationNode({ uid: PROPERTY_UID, name: "Cinespace" }, null);
  assertEquals(n.path, [{ uid: PROPERTY_UID, name: "Cinespace" }]);
  assertEquals(n.query_by_path, [PROPERTY_UID]);
  // ⚠️ `undefined`, never `""` — `street2` is `.optional()` and invariant 3
  // reads an empty string as a violation rather than as an absence.
  assertEquals(n.street2, undefined);
});

Deno.test("computeDestinationNode: a unit derives from the RESOLVED parent, and its name IS street2", () => {
  const n = computeDestinationNode({ uid: UNIT_UID, name: "Stage 25" }, property());
  assertEquals(n.path.map((p) => p.uid), [PROPERTY_UID, UNIT_UID]);
  assertEquals(n.query_by_path, [PROPERTY_UID, UNIT_UID]);
  assertEquals(n.street2, "Stage 25");
});

Deno.test("computeDestinationNode: a unit takes its PROPERTY's place name at path[0], not its own former one", () => {
  // The Cinespace root's stored `address.name` was the tenancy
  // "20th Television - Deli Boys - S2: Office" and the migration renames it.
  // A unit's `path[0].name` must follow the PROPERTY, so the denorm stays
  // checkable from one document — six of the twelve rows named a production.
  const n = computeDestinationNode(
    { uid: UNIT_UID, name: "Stage 25" },
    property({ address: address({ name: "Cinespace" }) }),
  );
  assertEquals(n.path[0].name, "Cinespace");
  assertEquals(n.path[1].name, "Stage 25");
});

Deno.test("computeDestinationNode: an EMPTY property name is legal — 211 E Chicago Ave has none", () => {
  const n = computeDestinationNode({ uid: PROPERTY_UID, name: "" }, null);
  assertEquals(n.path[0].name, "");
  assert(DestinationSchema.safeParse(
    property({ address: address({ name: "" }), path: n.path, query_by_path: n.query_by_path }),
  ).success);
});

Deno.test("computeDestinationNode: an empty UNIT name THROWS — an empty line 2 is not a unit", () => {
  assertThrows(
    () => computeDestinationNode({ uid: UNIT_UID, name: "   " }, property()),
    Error,
    "empty line 2 is not a unit",
  );
});

Deno.test("computeDestinationNode: a THIRD level THROWS — a brand over several lots is several properties", () => {
  assertThrows(
    () => computeDestinationNode({ uid: "testdeep10000000000a", name: "Room 3" }, unit()),
    Error,
    "would make it 3",
  );
});

Deno.test("computeDestinationNode: a CYCLE throws — a node cannot be its own ancestor", () => {
  assertThrows(
    () => computeDestinationNode({ uid: PROPERTY_UID, name: "Stage 25" }, property()),
    Error,
    "twice in its own path",
  );
});

Deno.test("computeDestinationNode: a PATHLESS parent throws rather than minting a root", () => {
  // The expand third leaves `path` optional, so an un-backfilled parent is a
  // real state — and silently treating it as a root would hang the unit at
  // depth 1 with its unit text stranded in `street`.
  assertThrows(
    () =>
      computeDestinationNode({ uid: UNIT_UID, name: "Stage 25" }, {
        uid: PROPERTY_UID,
        path: undefined,
        address: address(),
      }),
    Error,
    "has no path",
  );
});

Deno.test("applyDestinationStreet2 DELETES the key rather than writing an empty string", () => {
  const withUnit = applyDestinationStreet2(address(), "Stage 25");
  assertEquals(withUnit.street2, "Stage 25");
  const withoutUnit = applyDestinationStreet2(withUnit, undefined);
  assertEquals("street2" in withoutUnit, false);
});

// ── The readers ───────────────────────────────────────────────────────────

Deno.test("the level readers agree, both ways", () => {
  assertEquals(destinationLevel(property()), "property");
  assertEquals(destinationLevel(unit()), "unit");
  assertEquals(isDestinationProperty(property()), true);
  assertEquals(isDestinationProperty(unit()), false);
  assertEquals(isDestinationUnit(unit()), true);
  assertEquals(isDestinationUnit(property()), false);
  assertEquals(destinationPropertyUid(unit()), PROPERTY_UID);
  assertEquals(destinationPropertyUid(property()), PROPERTY_UID);
  assertEquals(destinationParentUid(unit()), PROPERTY_UID);
  assertEquals(destinationParentUid(property()), null);
  assertEquals(destinationOwnName(unit()), "Stage 25");
  assertEquals(destinationOwnName(property()), "Cinespace");
});

Deno.test("destinationLevel THROWS on a pathless document rather than guessing a level", () => {
  assertThrows(() => destinationLevel({ path: undefined }), Error, "(no path)");
});

Deno.test("the jurisdiction SEED walks to the property, and a unit's own value never shadows it", () => {
  const p = { uid: PROPERTY_UID, jurisdiction: "frankfort" as const };
  assertEquals(resolveDestinationJurisdictionSeed(unit(), p), "frankfort");
  // A property resolving itself must not read its own value twice through the
  // ancestor slot — it returns null when it states nothing, not the caller's.
  assertEquals(
    resolveDestinationJurisdictionSeed(property(), { uid: PROPERTY_UID, jurisdiction: "frankfort" }),
    null,
  );
  // A dangling property states nothing rather than throwing — a deleted parent
  // must not take down every write in its subtree.
  assertEquals(resolveDestinationJurisdictionSeed(unit(), null), null);
});

// ── The schema invariants, both polarities ────────────────────────────────

Deno.test("invariant 1 — path is SELF-INCLUSIVE", () => {
  assert(DestinationSchema.safeParse(unit()).success);
  const wrong = unit();
  wrong.path = [wrong.path[0], { uid: "testother0000000000a", name: "Stage 25" }];
  assertEquals(DestinationSchema.safeParse(wrong).success, false);
});

Deno.test("invariant 2 — query_by_path IS path.map(n => n.uid), ORDER included", () => {
  assert(DestinationSchema.safeParse(unit()).success);
  assertEquals(DestinationSchema.safeParse(unit({ query_by_path: [UNIT_UID, PROPERTY_UID] })).success, false);
  assertEquals(DestinationSchema.safeParse(unit({ query_by_path: [PROPERTY_UID] })).success, false);
});

Deno.test("invariant 3 — street2 is the unit's name, and exists on NOTHING else", () => {
  assert(DestinationSchema.safeParse(unit()).success);
  // A unit whose line 2 disagrees with its node.
  assertEquals(
    DestinationSchema.safeParse(unit({ address: address({ street2: "Stage 30" }) })).success,
    false,
  );
  // A unit with no line 2 at all.
  assertEquals(DestinationSchema.safeParse(unit({ address: address() })).success, false);
  // 🔴 The other polarity: a hand-written line 2 on a PROPERTY. This is the one
  // that matters — `street2` was empty on all 322 documents while ≥14 carried
  // unit text inside `street`, so the tempting wrong fix is to type it here.
  assertEquals(
    DestinationSchema.safeParse(property({ address: address({ street2: "Stage 25" }) })).success,
    false,
  );
  assert(DestinationSchema.safeParse(property()).success);
});

Deno.test("invariant 4 — a hand-built unit with an EMPTY name is refused at the schema too", () => {
  // `computeDestinationNode` throws on this, but the schema is the last line
  // for a document built by hand — the migration and the audits both do.
  const u = unit();
  u.path = [u.path[0], { uid: UNIT_UID, name: "" }];
  u.address = address();
  assertEquals(DestinationSchema.safeParse(u).success, false);
});

Deno.test("invariant 5 — path[0].name mirrors address.name on BOTH levels", () => {
  assertEquals(
    DestinationSchema.safeParse(property({ address: address({ name: "Something Else" }) })).success,
    false,
  );
  const drifted = unit();
  drifted.path = [{ uid: PROPERTY_UID, name: "20th Television - Deli Boys - S2" }, drifted.path[1]];
  assertEquals(DestinationSchema.safeParse(drifted).success, false);
});

Deno.test("invariant 6 — the jurisdiction seed is the PROPERTY's, and a unit states none", () => {
  assert(DestinationSchema.safeParse(property({ jurisdiction: "frankfort" })).success);
  assert(DestinationSchema.safeParse(property({ jurisdiction: null })).success);
  assertEquals(DestinationSchema.safeParse(unit({ jurisdiction: "frankfort" })).success, false);
  // `null` on a unit is fine — it states nothing, which is the requirement.
  assert(DestinationSchema.safeParse(unit({ jurisdiction: null })).success);
});

Deno.test("a PATHLESS destination still parses — the expand third, and the guards are inert on it", () => {
  // ⚠️ This is the arm that comes out with the optionality. While it stands,
  // every invariant above is skipped for a document the backfill has not
  // reached — which is correct now and a hole the moment `path` is required.
  const flat = { uid: PROPERTY_UID, address: address(), mapbox_ids: [], ...ts };
  assert(DestinationSchema.safeParse(flat).success);
});
