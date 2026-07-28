/**
 * `DocSource.collection` is constrained to {@link CFS_SOURCE_COLLECTIONS} (core#38).
 *
 * It used to be `z.string().min(1)` — free text reaching a Firestore collection
 * name straight off a POST body. See the const's doc comment for how membership
 * was surveyed.
 */
import { assertEquals } from "@std/assert";
import {
  CFS_SOURCE_COLLECTIONS,
  DocSource,
  schemas,
} from "../src/schemas/mod.ts";

Deno.test("every CFS_SOURCE_COLLECTIONS member is a known collection", () => {
  // A typo guard, NOT a coupling. The `schemas` record double-keys singular and
  // plural onto each document schema, so it is the canonical collection
  // namespace and catches a misspelled member for free.
  //
  // The enum is deliberately NOT derived from that record: it also carries
  // singular keys and legacy aliases (`dates` → HolidayDatesSchema), which would
  // make a `DocSource.collection` far more permissive than the survey supports.
  const unknown = CFS_SOURCE_COLLECTIONS.filter((c) => !(c in schemas));
  assertEquals(unknown, [], `not keys of the \`schemas\` record: ${unknown.join(", ")}`);
});

Deno.test("CFS_SOURCE_COLLECTIONS is sorted and free of duplicates", () => {
  const sorted = [...CFS_SOURCE_COLLECTIONS].sort();
  assertEquals([...CFS_SOURCE_COLLECTIONS], sorted, "keep the list sorted");
  assertEquals(new Set(CFS_SOURCE_COLLECTIONS).size, CFS_SOURCE_COLLECTIONS.length);
});

Deno.test("DocSource accepts every surveyed collection", () => {
  for (const collection of CFS_SOURCE_COLLECTIONS) {
    const result = DocSource.safeParse({ collection, uid: "order100000000000000" });
    assertEquals(result.success, true, `${collection} should parse`);
  }
});

Deno.test("DocSource accepts a composite uid, including a movement's", () => {
  // A reversal names the event it negates: {collection:"transactions", uid:<MovementId>}.
  // Without a MovementId arm on AnyUid that uid falls through to the slug
  // pattern and the write is rejected — which took out the journal's only
  // correction path.
  const composites = [
    "0199a1f2-3b4c-7d8e-9f01-234567890abc|sale|testprod100000000000",
    "0199a1f2-3b4c-7d8e-9f01-234567890abc|check_out|testordr100000000000:testitem10000000000x:testdest100000000000",
    "testordr100000000000:testitem10000000000x:testdest100000000000",
  ];
  for (const uid of composites) {
    assertEquals(
      DocSource.safeParse({ collection: "transactions", uid }).success,
      true,
      uid,
    );
  }
});

Deno.test("DocSource rejects a collection outside the known set", () => {
  // The core#38 shape: an arbitrary string off a POST body reaching a Firestore
  // collection name.
  assertEquals(
    DocSource.safeParse({ collection: "not-a-collection", uid: "order100000000000000" }).success,
    false,
  );
  assertEquals(
    DocSource.safeParse({ collection: "", uid: "order100000000000000" }).success,
    false,
  );
});

Deno.test("DocSource still carries an optional label and rejects extras", () => {
  assertEquals(
    DocSource.safeParse({
      collection: "bookings",
      // BookingId — `{uid_order}:{uid_product}:{uid_destination}` (see `_uid.ts`).
      uid: "order100000000000000:product1000000000000:dest1000000000000000",
      label: "Booking #1042",
    }).success,
    true,
  );
  assertEquals(
    DocSource.safeParse({ collection: "cards", uid: "card1000000000000000", extra: 1 }).success,
    false,
  );
});
