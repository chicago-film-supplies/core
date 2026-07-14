import { assertEquals } from "@std/assert";
import { PublicStockSummarySchema } from "../src/schemas/public-stock-summary.ts";
import { mockTimestamp, tsAt } from "./helpers/timestamp.ts";

const PRODUCT = "testprod100000000000";

const validSummary = {
  uid: PRODUCT,
  uid_product: PRODUCT,
  type: "rental",
  quantity_held: 20,
  unavailable: [{
    start: "2026-03-01T00:00:00.000-06:00",
    start_fs: tsAt("2026-03-01T00:00:00.000-06:00"),
    end: "2026-03-05T23:59:59.999-06:00",
    end_fs: tsAt("2026-03-05T23:59:59.999-06:00"),
    quantity: 5,
  }],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("PublicStockSummarySchema validates a complete document", () => {
  assertEquals(PublicStockSummarySchema.safeParse(validSummary).success, true);
});

Deno.test("PublicStockSummarySchema requires uid", () => {
  const { uid: _, ...doc } = validSummary;
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, false);
});

Deno.test("PublicStockSummarySchema accepts an open-ended unavailable interval", () => {
  const doc = {
    ...validSummary,
    unavailable: [{ ...validSummary.unavailable[0], end: null, end_fs: null }],
  };
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, true);
});

Deno.test("PublicStockSummarySchema accepts an empty unavailable list", () => {
  assertEquals(
    PublicStockSummarySchema.safeParse({ ...validSummary, unavailable: [] }).success,
    true,
  );
});

Deno.test("PublicStockSummarySchema rejects additional properties", () => {
  const doc = { ...validSummary, bogus: true };
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, false);
});

Deno.test("PublicStockSummarySchema leaks nothing identifying", () => {
  // The whole point of the sanitized twin: an outsider must not be able to tell
  // "booked" from "in for repair", nor learn which booking / order / OOS record
  // made a unit unavailable. strictObject means any of these fails outright.
  for (const leak of ["uid_booking", "number", "reason", "status", "bookings", "out_of_service"]) {
    const doc = { ...validSummary, [leak]: "anything" };
    assertEquals(
      PublicStockSummarySchema.safeParse(doc).success,
      false,
      leak + " must not be accepted on the public twin",
    );
  }
});
