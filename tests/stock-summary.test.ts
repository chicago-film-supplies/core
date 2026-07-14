import { assertEquals } from "@std/assert";
import { StockSummarySchema } from "../src/schemas/stock-summary.ts";
import { mockTimestamp, tsAt } from "./helpers/timestamp.ts";

const PRODUCT = "testprod100000000000";
const BOOKING = "testorder10000000000:testprod100000000000:testdest100000000000";

const validSummary = {
  // The doc id IS the product uid — there is no composite form any more.
  uid: PRODUCT,
  uid_product: PRODUCT,
  type: "rental",
  quantity_held: 20,
  bookings: [{
    uid: BOOKING,
    number: 42,
    start: "2026-03-01T00:00:00.000-06:00",
    start_fs: tsAt("2026-03-01T00:00:00.000-06:00"),
    end: "2026-03-05T23:59:59.999-06:00",
    end_fs: tsAt("2026-03-05T23:59:59.999-06:00"),
    breakdown: {
      quoted: 0,
      reserved: 3,
      prepped: 0,
      out: 2,
      returned: 0,
      lost: 0,
      damaged: 0,
    },
  }],
  out_of_service: [{
    uid: "testoos1000000000000",
    start: "2026-03-02T00:00:00.000-06:00",
    start_fs: tsAt("2026-03-02T00:00:00.000-06:00"),
    end: null,
    end_fs: null,
    quantity: 2,
    reason: "damaged",
    status: "active",
  }],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("StockSummarySchema validates a complete document", () => {
  assertEquals(StockSummarySchema.safeParse(validSummary).success, true);
});

Deno.test("StockSummarySchema accepts empty bookings + out_of_service", () => {
  const doc = { ...validSummary, bookings: [], out_of_service: [] };
  assertEquals(StockSummarySchema.safeParse(doc).success, true);
});

Deno.test("StockSummarySchema accepts an open-ended booking (the sale case)", () => {
  // A sale booking has no end date — the sold unit does not come back.
  const doc = {
    ...validSummary,
    type: "sale",
    bookings: [{ ...validSummary.bookings[0], end: null, end_fs: null }],
  };
  assertEquals(StockSummarySchema.safeParse(doc).success, true);
});

Deno.test("StockSummarySchema canonicalizes interval bounds to Chicago offset form", () => {
  const doc = {
    ...validSummary,
    bookings: [{
      ...validSummary.bookings[0],
      start: "2026-03-01T06:00:00.000Z", // same instant, UTC spelling
      end: "2026-03-06T05:59:59.999Z",
    }],
  };
  const parsed = StockSummarySchema.safeParse(doc);
  assertEquals(parsed.success, true);
  if (!parsed.success) return;
  const b = (parsed.data as typeof validSummary).bookings[0];
  assertEquals(b.start, "2026-03-01T00:00:00.000-06:00");
  assertEquals(b.end, "2026-03-05T23:59:59.999-06:00");
});

Deno.test("StockSummarySchema rejects a bare YYYY-MM-DD bound", () => {
  const doc = {
    ...validSummary,
    bookings: [{ ...validSummary.bookings[0], start: "2026-03-01" }],
  };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema rejects an invalid product type", () => {
  const doc = { ...validSummary, type: "invalid" };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema rejects an invalid OOS reason", () => {
  const doc = {
    ...validSummary,
    out_of_service: [{ ...validSummary.out_of_service[0], reason: "gremlins" }],
  };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema rejects additional properties", () => {
  const doc = { ...validSummary, bogus: true };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema rejects the retired window-keyed fields", () => {
  for (
    const dead of ["summary_type", "dates", "quantity_available", "store_breakdown", "expiresAt"]
  ) {
    const doc = { ...validSummary, [dead]: "anything" };
    assertEquals(
      StockSummarySchema.safeParse(doc).success,
      false,
      dead + " should no longer be accepted",
    );
  }
});
