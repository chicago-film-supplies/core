import { assertEquals } from "@std/assert";
import {
  CreateOutOfServiceInput,
  OutOfServiceSchema,
  UpdateOutOfServiceInput,
} from "../src/schemas/out-of-service.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const fs = mockTimestamp;

function issuePaths(doc: unknown): string[] {
  const r = OutOfServiceSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

const validOOS = {
  uid: "testoos1000000000000",
  uid_product: "testprod100000000000",
  number: 1,
  reason: "damaged",
  status: "active",
  quantity: 2,
  breakdown: { flagged: 2, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 0 },
  units: null,
  canceled_at: null,
  organization: null,
  dates: {
    start: "2026-03-01T00:00:00.000-06:00",
    start_fs: fs,
    end: null,
    end_fs: null,
  },
  destination: null,
  uid_destination: null,
  supplier: null,
  sources: [{ collection: "orders", uid: "testorder10000000000", label: "Order #1001" }],
  query_by_sources: ["orders:test-order-1"],
  stores: [],
  query_by_uid_store: [],
  query_by_uid_location: [],
  version: 0,
  created_by: { uid: "testuser100000000000", name: "Test User" },
  updated_by: { uid: "testuser100000000000", name: "Test User" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("OutOfServiceSchema validates a complete document", () => {
  assertEquals(OutOfServiceSchema.safeParse(validOOS).success, true);
});

Deno.test("OutOfServiceSchema: `units` is REQUIRED-nullable — absent refused, null accepted (serial-tracking D6)", () => {
  const { units: _units, ...absent } = validOOS;
  const r = OutOfServiceSchema.safeParse(absent);
  assertEquals(r.success, false);
  assertEquals(r.error?.issues.map((i) => i.path.join(".")), ["units"]);
  assertEquals(OutOfServiceSchema.safeParse({ ...validOOS, units: null }).success, true);
});

Deno.test("OutOfServiceSchema validates all reasons", () => {
  const reasons = ["cleaning", "damaged", "maintenance", "lost"];
  for (const reason of reasons) {
    const doc = { ...validOOS, reason };
    assertEquals(OutOfServiceSchema.safeParse(doc).success, true, `reason "${reason}" should be valid`);
  }
});

Deno.test("OutOfServiceSchema rejects invalid reason", () => {
  const doc = { ...validOOS, reason: "stolen" };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, false);
});

Deno.test("OutOfServiceSchema accepts empty sources for ad-hoc OOS", () => {
  const doc = { ...validOOS, sources: [], query_by_sources: [] };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema accepts plural sources (booking + order)", () => {
  const doc = {
    ...validOOS,
    sources: [
      { collection: "bookings", uid: "testorder10000000000:testprod100000000000:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48", label: "Booking #5" },
      { collection: "orders", uid: "testorder10000000000", label: "Order #1001" },
    ],
    query_by_sources: ["bookings:test-booking-1", "orders:test-order-1"],
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema validates with stores", () => {
  const doc = {
    ...validOOS,
    status: "complete",
    breakdown: { flagged: 0, away: 0, written_off: 1, returned_to_service: 1, returned_to_supplier: 0 },
    dates: { ...validOOS.dates, end: "2026-03-15T00:00:00.000-05:00", end_fs: fs },
    stores: [{
      uid_store: "teststore10000000000",
      name: "Main",
      default: true,
      quantity: 2,
      locations: [{
        uid_location: "testloc1000000000000",
        name: "Shelf A",
        quantity: 5,
        transactionQuantity: 2,
      }],
    }],
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema: a store location carries no `default` copy (api-cloudrun#1302 phase 5)", () => {
  const doc = {
    ...validOOS,
    stores: [{
      uid_store: "teststore10000000000",
      name: "Main",
      default: true,
      quantity: 2,
      locations: [{ uid_location: "testloc1000000000000", name: "Shelf A", quantity: 2, transactionQuantity: 2 }],
    }],
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
  const withCopy = { ...doc, stores: [{ ...doc.stores[0], locations: [{ ...doc.stores[0].locations[0], default: true }] }] };
  assertEquals(OutOfServiceSchema.safeParse(withCopy).success, false, "the retired copy is refused");
});

Deno.test("OutOfServiceSchema rejects additional properties", () => {
  const doc = { ...validOOS, bogus: true };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, false);
});

Deno.test("OutOfServiceSchema validates organization denormalization", () => {
  const doc = {
    ...validOOS,
    organization: {
      uid: "testorg1000000000000",
      path: [{ uid: "testorg1000000000000", name: "Acme Co", derived: false }],
      crms_id: 42,
    },
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema accepts a record not yet in effect — units in no bucket", () => {
  const doc = {
    ...validOOS,
    status: "active",
    breakdown: { flagged: 0, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 0 },
    dates: { start: null, start_fs: null, end: null, end_fs: null },
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("CreateOutOfServiceInput accepts a minimal payload", () => {
  const input = {
    uid_product: "testprod100000000000",
    reason: "damaged" as const,
    quantity: 2,
    dates: { start: "2026-03-01T00:00:00.000-06:00" },
    uuid_session: "9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48",
  };
  assertEquals(CreateOutOfServiceInput.safeParse(input).success, true);
  const { uuid_session: _, ...noSession } = input;
  assertEquals(CreateOutOfServiceInput.safeParse(noSession).success, false, "uuid_session is required");
});

Deno.test("CreateOutOfServiceInput: allocations must sum to the quantity", () => {
  const base = {
    uid_product: "testprod100000000000",
    reason: "cleaning" as const,
    quantity: 3,
    dates: {},
    uuid_session: "9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48",
  };
  assertEquals(
    CreateOutOfServiceInput.safeParse({ ...base, allocations: [{ uid_location: "testloc1000000000000", quantity: 3 }] }).success,
    true,
  );
  assertEquals(
    CreateOutOfServiceInput.safeParse({ ...base, allocations: [{ uid_location: "testloc1000000000000", quantity: 2 }] }).success,
    false,
  );
});

Deno.test("OutOfServiceSchema: the breakdown may not place more units than the record holds", () => {
  const doc = { ...validOOS, breakdown: { flagged: 2, away: 1, written_off: 0, returned_to_service: 0, returned_to_supplier: 0 } };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, false);
});

Deno.test("OutOfServiceSchema: returned_to_supplier is REQUIRED in storage — absent refused, stated parses", () => {
  assertEquals(OutOfServiceSchema.safeParse(validOOS).success, true);
  const absent = { ...validOOS, breakdown: { flagged: 2, away: 0, written_off: 0, returned_to_service: 0 } };
  assertEquals(issuePaths(absent), ["breakdown.returned_to_supplier"]);
  const settled = { ...validOOS, breakdown: { flagged: 1, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 1 } };
  assertEquals(OutOfServiceSchema.safeParse(settled).success, true);
  const negative = { ...validOOS, breakdown: { ...validOOS.breakdown, returned_to_supplier: -1 } };
  assertEquals(OutOfServiceSchema.safeParse(negative).success, false);
});

Deno.test("OutOfServiceSchema: the over-placement guard fires when returned_to_supplier is the overflow", () => {
  const supplierOver = { ...validOOS, breakdown: { flagged: 2, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 1 } };
  assertEquals(issuePaths(supplierOver), ["breakdown"]);
});

Deno.test("OutOfServiceSchema: units — returned_to_supplier is a required set, and a stated one is counted", () => {
  const units = { away: [], flagged: [1, 2], returned_to_service: [], returned_to_supplier: [], written_off: [] };
  assertEquals(OutOfServiceSchema.safeParse({ ...validOOS, units }).success, true);
  const { returned_to_supplier: _omitted, ...fourSets } = units;
  assertEquals(OutOfServiceSchema.safeParse({ ...validOOS, units: fourSets }).success, false, "an absent set is refused in storage");
  const settledUnits = { ...units, flagged: [2], returned_to_supplier: [1] };
  const settled = { ...validOOS, breakdown: { flagged: 1, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 1 }, units: settledUnits };
  assertEquals(OutOfServiceSchema.safeParse(settled).success, true);
  // More named than the bucket holds.
  assertEquals(issuePaths({ ...validOOS, units: { ...units, flagged: [2], returned_to_supplier: [1] } }), ["units.returned_to_supplier"]);
  // A unit in two buckets, one of them the new one.
  assertEquals(
    issuePaths({ ...settled, units: { ...settledUnits, flagged: [1] } }).includes("units.returned_to_supplier"),
    true,
  );
});

Deno.test("UpdateOutOfServiceInput: a client built before the bucket sends four keys, and that parses — storage is tightened, not the input", () => {
  const base = { uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc", version: 0 };
  const four = { flagged: 1, away: 0, written_off: 0, returned_to_service: 0 };
  assertEquals(UpdateOutOfServiceInput.safeParse({ ...base, breakdown: four }).success, true);
  const fourSets = { away: [], flagged: [1], returned_to_service: [], written_off: [] };
  assertEquals(UpdateOutOfServiceInput.safeParse({ ...base, breakdown: four, units: fourSets }).success, true);
  // The stated 0 and the absent key are the same request.
  const parsed = UpdateOutOfServiceInput.safeParse({ ...base, breakdown: { ...four, returned_to_supplier: 0 } });
  assertEquals(parsed.success, true);
  // Over-placement is still caught with the key absent: undefined in a raw sum is NaN.
  const over = UpdateOutOfServiceInput.safeParse({ ...base, breakdown: { flagged: 2, away: 1, written_off: 0, returned_to_service: 0 }, units: { away: [], flagged: [1, 2, 3, 4], returned_to_service: [], written_off: [] } });
  assertEquals(over.success, false);
});

Deno.test("OutOfServiceSchema: uid_destination mirrors destination", () => {
  const destination = { uid: "testdest100000000000", address: null };
  assertEquals(
    OutOfServiceSchema.safeParse({ ...validOOS, destination, uid_destination: "testdest100000000000" }).success,
    true,
  );
  assertEquals(OutOfServiceSchema.safeParse({ ...validOOS, destination, uid_destination: null }).success, false);
});

Deno.test("OutOfServiceSchema: uid_product mirrors product.uid; product is optional until the backfill", () => {
  const product = { uid: "testprod100000000000", name: "C-Stand" };
  assertEquals(OutOfServiceSchema.safeParse({ ...validOOS, product }).success, true);
  assertEquals(issuePaths({ ...validOOS, product: { ...product, uid: "testprod200000000000" } }), ["uid_product"]);
  assertEquals(issuePaths({ ...validOOS, product: { ...product, name: "" } }), ["product.name"]);
  assertEquals(OutOfServiceSchema.safeParse(validOOS).success, true);
});

Deno.test("OutOfServiceSchema refuses the retired card-status buckets", () => {
  const doc = {
    ...validOOS,
    breakdown: { draft: 0, planned: 0, active: 2, blocked: 0, written_off: 0, returned_to_service: 0 },
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, false);
});

Deno.test("UpdateOutOfServiceInput requires version", () => {
  const session = "9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
  const ok = UpdateOutOfServiceInput.safeParse({ status: "canceled", version: 1, uuid_session: session });
  assertEquals(ok.success, true);
  const missingVersion = UpdateOutOfServiceInput.safeParse({ status: "canceled", uuid_session: session });
  assertEquals(missingVersion.success, false);
  const missingSession = UpdateOutOfServiceInput.safeParse({ status: "canceled", version: 1 });
  assertEquals(missingSession.success, false);
});

Deno.test("UpdateOutOfServiceInput: a reason edit is a flag reason only", () => {
  const session = "9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
  assertEquals(UpdateOutOfServiceInput.safeParse({ reason: "cleaning", version: 1, uuid_session: session }).success, true);
  assertEquals(
    UpdateOutOfServiceInput.safeParse({ reason: "lost", version: 1, uuid_session: session }).success,
    false,
    "lost is a PLACE change, not a reason edit",
  );
  assertEquals(
    UpdateOutOfServiceInput.safeParse({ status: "active", version: 1, uuid_session: session }).success,
    false,
    "only canceled is client-settable",
  );
});

Deno.test("OOS destination input: { kind: uid } or { kind: address }, or null to clear", () => {
  const base = {
    uid_product: "testprod100000000000",
    reason: "damaged" as const,
    quantity: 1,
    dates: {},
    uuid_session: "9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48",
  };
  const address = {
    city: "Chicago",
    country_name: "United States",
    full: "1 Vendor Way, Chicago, IL 60601",
    name: "1 Vendor Way",
    postcode: "60601",
    region: "IL",
    street: "1 Vendor Way",
  };
  const parse = (destination: unknown) => CreateOutOfServiceInput.safeParse({ ...base, destination }).success;
  assertEquals(parse({ kind: "uid", uid: "testdest100000000000" }), true, "an existing destination");
  assertEquals(parse({ kind: "address", address }), true, "a new address the server resolves");
  assertEquals(parse(null), true, "null clears");
  assertEquals(parse({ uid: "testdest100000000000" }), false, "the discriminator is required");
  assertEquals(parse({ kind: "uid", uid: "testdest100000000000", address }), false, "one arm's keys only");
  assertEquals(parse({ kind: "address", address: null }), false, "the address arm refuses null");
  assertEquals(
    UpdateOutOfServiceInput.safeParse({ uuid_session: base.uuid_session, version: 1, destination: { kind: "address", address } }).success,
    true,
    "update takes the same union",
  );
});

Deno.test("UpdateOutOfServiceInput: uid_purchase is optional, input-only, and sent with the breakdown it settles", () => {
  const base = { uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc", version: 0 };
  const breakdown = { flagged: 1, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 1 };
  assertEquals(UpdateOutOfServiceInput.safeParse({ ...base, breakdown, uid_purchase: "testpurch10000000000" }).success, true);
  assertEquals(UpdateOutOfServiceInput.safeParse({ ...base, breakdown }).success, true, "the writer, not the schema, requires it");
  const alone = UpdateOutOfServiceInput.safeParse({ ...base, uid_purchase: "testpurch10000000000" });
  assertEquals(alone.success ? [] : alone.error.issues.map((i) => i.path.join(".")), ["uid_purchase"]);
  assertEquals(UpdateOutOfServiceInput.safeParse({ ...base, breakdown, uid_purchase: "not an id" }).success, false);
});
