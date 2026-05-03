import { assertEquals } from "@std/assert";
import {
  CreateOutOfServiceRecordInput,
  OutOfServiceRecordSchema,
  UpdateOutOfServiceRecordInput,
} from "../src/out-of-service-record.ts";

const validOOS = {
  uid: "test-oos-1",
  uid_product: "test-prod-1",
  reason: "damaged",
  quantity: 2,
  quantity_return_to_service: 1,
  quantity_write_off: 1,
  dates: {
    start: "2026-03-01T00:00:00Z",
    start_fs: { seconds: 0, nanoseconds: 0, toMillis: () => 0, toDate: () => new Date(0) },
    end: null,
    end_fs: null,
  },
  sources: [{ collection: "orders", uid: "test-order-1", label: "Order #1001" }],
  query_by_sources: ["orders:test-order-1"],
};

Deno.test("OutOfServiceRecordSchema validates a complete document", () => {
  assertEquals(OutOfServiceRecordSchema.safeParse(validOOS).success, true);
});

Deno.test("OutOfServiceRecordSchema validates all reasons", () => {
  const reasons = ["cleaning", "damaged", "maintenance", "lost"];
  for (const reason of reasons) {
    const doc = { ...validOOS, reason };
    assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, true, `reason "${reason}" should be valid`);
  }
});

Deno.test("OutOfServiceRecordSchema rejects invalid reason", () => {
  const doc = { ...validOOS, reason: "stolen" };
  assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, false);
});

Deno.test("OutOfServiceRecordSchema accepts empty sources for ad-hoc OOS", () => {
  const doc = { ...validOOS, sources: [], query_by_sources: [] };
  assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceRecordSchema accepts plural sources (booking + order)", () => {
  const doc = {
    ...validOOS,
    sources: [
      { collection: "bookings", uid: "test-booking-1", label: "Booking #5" },
      { collection: "orders", uid: "test-order-1", label: "Order #1001" },
    ],
    query_by_sources: ["bookings:test-booking-1", "orders:test-order-1"],
  };
  assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceRecordSchema validates with stores and transactions", () => {
  const fs = { seconds: 1, nanoseconds: 0, toMillis: () => 1000, toDate: () => new Date(1000) };
  const doc = {
    ...validOOS,
    complete: true,
    dates: { ...validOOS.dates, end: "2026-03-15T00:00:00Z", end_fs: fs },
    stores: [{
      uid_store: "test-store-1",
      name: "Main",
      locations: [{
        uid_location: "test-loc-1",
        name: "Shelf A",
        transactionQuantity: 2,
        default: true,
      }],
    }],
    transactions: [{
      date: "2026-03-01T00:00:00Z",
      out_of_service_uid: "test-oos-1",
      quantity: 2,
      type: "quarantine",
    }],
  };
  assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceRecordSchema rejects additional properties", () => {
  const doc = { ...validOOS, bogus: true };
  assertEquals(OutOfServiceRecordSchema.safeParse(doc).success, false);
});

Deno.test("CreateOutOfServiceRecordInput accepts a minimal payload", () => {
  const input = {
    uid_product: "test-prod-1",
    reason: "damaged" as const,
    quantity: 2,
    dates: { start: "2026-03-01T00:00:00Z" },
  };
  assertEquals(CreateOutOfServiceRecordInput.safeParse(input).success, true);
});

Deno.test("UpdateOutOfServiceRecordInput requires version", () => {
  const ok = UpdateOutOfServiceRecordInput.safeParse({ complete: true, version: 1 });
  assertEquals(ok.success, true);
  const missingVersion = UpdateOutOfServiceRecordInput.safeParse({ complete: true });
  assertEquals(missingVersion.success, false);
});
