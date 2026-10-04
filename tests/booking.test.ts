import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { BookingSchema } from "../src/schemas/booking.ts";
import { breakdownObjectSchema } from "../src/schemas/_breakdown.ts";
import { z } from "zod";
import { mockTimestamp } from "./helpers/timestamp.ts";

const bookingBase = getInitialValues(BookingSchema) as Record<string, unknown>;
const breakdownBase = bookingBase.breakdown as Record<string, unknown>;
const datesBase = bookingBase.dates as Record<string, unknown>;

const validBooking = {
  ...bookingBase,
  uid: "testorder10000000000:testprod100000000000:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48",
  uid_order: "testorder10000000000",
  uid_product: "testprod100000000000",
  name: "LED Panel",
  number: 1,
  type: "rental",
  status: "reserved",
  quantity: 5,
  subject: "Event lighting",
  breakdown: {
    ...breakdownBase,
    reserved: 5,
  },
  dates: {
    ...datesBase,
    start: "2026-03-01T00:00:00Z",
    start_fs: null,
    end: "2026-03-10T00:00:00Z",
  },
  organization: {
    uid: "testorg1000000000000",
    // The chain, copied from the order — `name` left this block at
    // api-cloudrun#782's contract step, and `composeOrgName(path)` replaces it.
    path: [{ uid: "testorg1000000000000", name: "Test Acme Corp", derived: false }],
    crms_id: null,
  },
  // A rental comes back, so it names a collection, and the flat id mirrors it.
  destinations: {
    delivery: { uid: "testdest100000000000", address: null },
    collection: { uid: "testdest200000000000", address: null },
  },
  uid_destination_delivery: "testdest100000000000",
  uid_destination_collection: "testdest200000000000",
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("BookingSchema validates a complete document", () => {
  assertEquals(BookingSchema.safeParse(validBooking).success, true);
});

Deno.test("BookingSchema: `units` is REQUIRED-nullable — absent refused, null accepted (serial-tracking D2)", () => {
  const { units: _units, ...absent } = { ...validBooking, units: null };
  const r = BookingSchema.safeParse(absent);
  assertEquals(r.success, false);
  assertEquals(r.error?.issues.map((i) => i.path.join(".")), ["units"]);
  assertEquals(BookingSchema.safeParse({ ...validBooking, units: null }).success, true);
});

Deno.test("BookingSchema validates with stores", () => {
  const doc = {
    ...validBooking,
    stores: [{
      uid_store: "teststore10000000000",
      name: "Main",
      default: true,
      quantity: 5,
      locations: [{
        uid_location: "testloc1000000000000",
        name: "Shelf A",
        quantity: 5,
        default: true,
      }],
    }],
    query_by_uid_store: ["teststore10000000000"],
  };
  assertEquals(BookingSchema.safeParse(doc).success, true);
});

Deno.test("BookingSchema validates a sale booking with no collection", () => {
  const doc = {
    ...validBooking,
    type: "sale",
    destinations: { ...validBooking.destinations, collection: null },
    uid_destination_collection: null,
  };
  assertEquals(BookingSchema.safeParse(doc).success, true, JSON.stringify(BookingSchema.safeParse(doc).error?.issues));
});

Deno.test("BookingSchema: a booking's collection follows its own type (api-cloudrun#1154)", async (t) => {
  const refusedAt = (doc: unknown, path: PropertyKey[]) => {
    const r = BookingSchema.safeParse(doc);
    return !r.success && r.error.issues.some((i) => i.path.join(".") === path.join("."));
  };
  await t.step("a rental with no collection is refused at the collection", () => {
    const doc = {
      ...validBooking,
      destinations: { ...validBooking.destinations, collection: null },
      uid_destination_collection: null,
    };
    assertEquals(refusedAt(doc, ["destinations", "collection"]), true);
  });
  await t.step("a sale that names a collection is refused at the collection", () => {
    assertEquals(refusedAt({ ...validBooking, type: "sale" }, ["destinations", "collection"]), true);
  });
  await t.step("a flat id that disagrees with the ref is refused at the flat id", () => {
    assertEquals(
      refusedAt({ ...validBooking, uid_destination_collection: "testdest300000000000" }, ["uid_destination_collection"]),
      true,
    );
    const sale = { ...validBooking, type: "sale", destinations: { ...validBooking.destinations, collection: null } };
    assertEquals(refusedAt(sale, ["uid_destination_collection"]), true, "a sale keeping the flat id");
  });
});

Deno.test("BookingSchema accepts optional crms_id fields", () => {
  const doc = {
    ...validBooking,
    crms_id: 123,
    crms_product_id: 456,
  };
  assertEquals(BookingSchema.safeParse(doc).success, true);
});

Deno.test("BookingSchema rejects invalid status", () => {
  const doc = { ...validBooking, status: "invalid" };
  assertEquals(BookingSchema.safeParse(doc).success, false);
});

Deno.test("BookingSchema rejects invalid type", () => {
  const doc = { ...validBooking, type: "invalid" };
  assertEquals(BookingSchema.safeParse(doc).success, false);
});

Deno.test("BookingSchema accepts part-prepped status", () => {
  const doc = { ...validBooking, status: "part-prepped" };
  assertEquals(BookingSchema.safeParse(doc).success, true);
});

Deno.test("BookingSchema rejects additional properties", () => {
  const doc = { ...validBooking, bogus: true };
  assertEquals(BookingSchema.safeParse(doc).success, false);
});

// custody-actions P2b step 5: `cleaning`/`maintenance` are REQUIRED on every
// spelling of the breakdown. One key dropped per case, and the issue must name
// exactly it — a bare `success: false` could be failing for any reason.
Deno.test("P2b: every breakdown spelling refuses a breakdown lacking cleaning or maintenance", () => {
  const nine = { quoted: 0, reserved: 5, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0, cleaning: 0, maintenance: 0 };
  const spellings: [string, z.ZodType, (b: Record<string, number>) => unknown, (string | number)[]][] = [
    ["BookingSchema.breakdown", BookingSchema, (b) => ({ ...validBooking, breakdown: b }), ["breakdown"]],
    ["the order roll-up (strict)", breakdownObjectSchema(() => z.number(), "strict"), (b) => b, []],
  ];
  for (const [name, schema, wrap, prefix] of spellings) {
    assertEquals(schema.safeParse(wrap(nine)).success, true, `${name}: the nine-key control parses`);
    for (const key of ["cleaning", "maintenance"] as const) {
      const { [key]: _dropped, ...rest } = nine;
      const r = schema.safeParse(wrap(rest));
      assertEquals(r.success, false, `${name} accepted a breakdown without ${key}`);
      assertEquals(r.error!.issues.map((i) => i.path), [[...prefix, key]], `${name}: the issue names ${key}`);
    }
  }
});
