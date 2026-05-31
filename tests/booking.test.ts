import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/initial.ts";
import { BookingSchema } from "../src/booking.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const bookingBase = getInitialValues(BookingSchema) as Record<string, unknown>;
const breakdownBase = bookingBase.breakdown as Record<string, unknown>;
const datesBase = bookingBase.dates as Record<string, unknown>;

const validBooking = {
  ...bookingBase,
  uid: "testorder10000000000:testprod100000000000:testdest100000000000",
  uid_order: "testorder10000000000",
  uid_product: "testprod100000000000",
  name: "LED Panel",
  number: 1,
  type: "rental",
  status: "reserved",
  quantity: 5,
  subject: "Event lighting",
  unit_price: 100,
  total_price: 500,
  breakdown: {
    ...breakdownBase,
    reserved: 5,
  },
  dates: {
    ...datesBase,
    start: "2026-03-01T00:00:00Z",
    start_fs: null,
    end: "2026-03-10T00:00:00Z",
    charge_start: "2026-03-01T00:00:00Z",
    charge_start_fs: null,
    charge_end: "2026-03-10T00:00:00Z",
  },
  organization: { uid: "testorg1000000000000", name: "Test Acme Corp", crms_id: null },
  uid_destination_delivery: "testdest100000000000",
  uid_destination_collection: "testdest200000000000",
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("BookingSchema validates a complete document", () => {
  assertEquals(BookingSchema.safeParse(validBooking).success, true);
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

Deno.test("BookingSchema validates with destination refs", () => {
  const doc = {
    ...validBooking,
    destinations: {
      delivery: { uid: "testdest100000000000", address: null },
      collection: null,
    },
  };
  assertEquals(BookingSchema.safeParse(doc).success, true);
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
