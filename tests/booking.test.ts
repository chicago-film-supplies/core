import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/initial.ts";
import { BookingSchema } from "../src/booking.ts";

const bookingBase = getInitialValues(BookingSchema) as Record<string, unknown>;
const breakdownBase = bookingBase.breakdown as Record<string, unknown>;
const datesBase = bookingBase.dates as Record<string, unknown>;

const validBooking = {
  ...bookingBase,
  uid: "test-booking-1",
  uid_order: "test-order-1",
  uid_product: "test-prod-1",
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
  organization: { uid: "test-org-1", name: "Test Acme Corp", crms_id: null },
  uid_destination_delivery: "test-dest-1",
  uid_destination_collection: "test-dest-2",
  created_at: null,
  updated_at: null,
};

Deno.test("BookingSchema validates a complete document", () => {
  assertEquals(BookingSchema.safeParse(validBooking).success, true);
});

Deno.test("BookingSchema validates with stores", () => {
  const doc = {
    ...validBooking,
    stores: [{
      uid_store: "test-store-1",
      name: "Main",
      default: true,
      quantity: 5,
      locations: [{
        uid_location: "test-loc-1",
        name: "Shelf A",
        quantity: 5,
        default: true,
      }],
    }],
    query_by_uid_store: ["test-store-1"],
  };
  assertEquals(BookingSchema.safeParse(doc).success, true);
});

Deno.test("BookingSchema validates with destination refs", () => {
  const doc = {
    ...validBooking,
    destinations: {
      delivery: { uid: "test-dest-1", address: null },
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
