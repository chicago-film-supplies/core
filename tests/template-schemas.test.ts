/**
 * `TEMPLATE_COLLECTION_SCHEMAS` — the map that decouples "is a template source"
 * from "is a Firestore collection" (api-cloudrun#700).
 *
 * Two things need asserting, and they pull in opposite directions:
 *
 *  1. every entry that IS a collection must be the SAME schema instance
 *     `schemaFor` returns — a second table that merely agrees today is a table
 *     that drifts;
 *  2. an entry that is NOT a collection must stay out of the collection
 *     registry — that was the whole point of not registering it there, and
 *     `isCollectionName` returning true for a path with no documents is the
 *     failure this map exists to avoid.
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { isCollectionName, schemaFor } from "../src/schemas/mod.ts";
import {
  TEMPLATE_SOURCE_COLLECTIONS,
  TEMPLATE_TARGET_COLLECTIONS,
} from "../src/schemas/template.ts";
import {
  TEMPLATE_COLLECTION_SCHEMAS,
  templateSchemaFor,
} from "../src/schemas/template-schemas.ts";

Deno.test("a collection-backed entry is the SAME instance schemaFor returns", () => {
  const checked: string[] = [];
  for (const [collection, schema] of Object.entries(TEMPLATE_COLLECTION_SCHEMAS)) {
    if (!isCollectionName(collection)) continue;
    assertStrictEquals(
      schema,
      schemaFor(collection),
      `${collection} names a different instance than schemaFor("${collection}") — ` +
        `this map must delegate, never restate`,
    );
    checked.push(collection);
  }
  // Guard the premise: an empty loop would pass vacuously, and it would do so
  // precisely if someone stopped registering the collection-backed sources.
  assert(checked.length >= 4, `expected ≥4 collection-backed entries, got ${checked.length}`);
});

Deno.test("every SOURCE has a schema — a source without one can hold no fixture", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    assert(
      templateSchemaFor(collection) !== undefined,
      `${collection} is a template source with no schema. Fixture validation, ` +
        `fixture PII sanitisation and the field reference panel all resolve ` +
        `through this map, so the family could hold no fixture, therefore no ` +
        `golden, therefore no gate.`,
    );
  }
});

Deno.test("movement-sessions is a source and NOT a collection", () => {
  // The load-bearing pair. If the first ever fails, a receipt family lost its
  // schema; if the second ever fails, someone registered a schema for a path
  // that stores no documents, and `validateCollection` / `fieldMask` /
  // `firestoreDisplayDefaults` will each read it as a real collection.
  assert(TEMPLATE_SOURCE_COLLECTIONS.includes("movement-sessions"));
  assert(templateSchemaFor("movement-sessions") !== undefined);
  assertEquals(isCollectionName("movement-sessions"), false);
});

Deno.test("targets that produce a document but store none have no schema", () => {
  // `packing_lists` and `receipts` are produced BY templates; nothing computes
  // over them, so there is nothing to validate and nothing to walk. Asserted
  // rather than assumed, because adding a schema to either should force a
  // re-think (it would put them in the field reference panel).
  for (const target of ["packing_lists", "receipts"] as const) {
    assert(TEMPLATE_TARGET_COLLECTIONS.includes(target));
    assertEquals(templateSchemaFor(target), undefined);
    assertEquals(isCollectionName(target), false);
  }
});

Deno.test("templateSchemaFor answers undefined for a string that is neither", () => {
  assertEquals(templateSchemaFor("bookings"), undefined);
  assertEquals(templateSchemaFor(""), undefined);
});
