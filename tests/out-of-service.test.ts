import { assertEquals } from "@std/assert";
import {
  CreateOutOfServiceInput,
  OutOfServiceSchema,
  UpdateOutOfServiceInput,
} from "../src/out-of-service.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const fs = mockTimestamp;

const validOOS = {
  uid: "test-oos-1",
  uid_product: "test-prod-1",
  number: 1,
  reason: "damaged",
  status: "active",
  quantity: 2,
  breakdown: {
    draft: 0,
    planned: 0,
    active: 2,
    blocked: 0,
    written_off: 0,
    returned_to_service: 0,
  },
  canceled_at: null,
  organization: null,
  dates: {
    start: "2026-03-01T00:00:00.000-06:00",
    start_fs: fs,
    end: null,
    end_fs: null,
  },
  sources: [{ collection: "orders", uid: "test-order-1", label: "Order #1001" }],
  query_by_sources: ["orders:test-order-1"],
  stores: [],
  query_by_uid_store: [],
  query_by_uid_location: [],
  version: 0,
  created_by: { uid: "test-user-1", name: "Test User" },
  updated_by: { uid: "test-user-1", name: "Test User" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("OutOfServiceSchema validates a complete document", () => {
  assertEquals(OutOfServiceSchema.safeParse(validOOS).success, true);
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
      { collection: "bookings", uid: "test-booking-1", label: "Booking #5" },
      { collection: "orders", uid: "test-order-1", label: "Order #1001" },
    ],
    query_by_sources: ["bookings:test-booking-1", "orders:test-order-1"],
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema validates with stores and transactions", () => {
  const doc = {
    ...validOOS,
    status: "complete",
    breakdown: { draft: 0, planned: 0, active: 0, blocked: 0, written_off: 1, returned_to_service: 1 },
    dates: { ...validOOS.dates, end: "2026-03-15T00:00:00.000-05:00", end_fs: fs },
    stores: [{
      uid_store: "test-store-1",
      name: "Main",
      default: true,
      quantity: 2,
      locations: [{
        uid_location: "test-loc-1",
        name: "Shelf A",
        quantity: 5,
        transactionQuantity: 2,
        default: true,
      }],
    }],
    transactions: [{
      date: "2026-03-01T00:00:00.000-06:00",
      date_fs: fs,
      quantity: 2,
      source: { collection: "bookings", uid: "test-booking-1" },
      type: "open",
    }],
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema rejects additional properties", () => {
  const doc = { ...validOOS, bogus: true };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, false);
});

Deno.test("OutOfServiceSchema validates organization denormalization", () => {
  const doc = {
    ...validOOS,
    organization: { uid: "test-org-1", name: "Acme Co", crms_id: 42 },
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("OutOfServiceSchema accepts nullable dates.start", () => {
  const doc = {
    ...validOOS,
    status: "draft",
    breakdown: { draft: 2, planned: 0, active: 0, blocked: 0, written_off: 0, returned_to_service: 0 },
    dates: { start: null, start_fs: null, end: null, end_fs: null },
  };
  assertEquals(OutOfServiceSchema.safeParse(doc).success, true);
});

Deno.test("CreateOutOfServiceInput accepts a minimal payload", () => {
  const input = {
    uid_product: "test-prod-1",
    reason: "damaged" as const,
    quantity: 2,
    dates: { start: "2026-03-01T00:00:00.000-06:00" },
  };
  assertEquals(CreateOutOfServiceInput.safeParse(input).success, true);
});

Deno.test("UpdateOutOfServiceInput requires version", () => {
  const ok = UpdateOutOfServiceInput.safeParse({ status: "canceled", version: 1 });
  assertEquals(ok.success, true);
  const missingVersion = UpdateOutOfServiceInput.safeParse({ status: "canceled" });
  assertEquals(missingVersion.success, false);
});
