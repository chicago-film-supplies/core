import { assertEquals } from "@std/assert";
import { StockSummarySchema } from "../src/stock-summary.ts";

const validSummary = {
  uid: "test-ss-1",
  uid_product: "test-prod-1",
  summary_type: "rental",
  type: "rental",
  dates: {
    start: "2026-03-01",
    start_fs: null,
    end: null,
    end_fs: null,
  },
  bookings: [],
  bookings_breakdown: {
    quoted: 0,
    reserved: 3,
    prepped: 0,
    out: 2,
    returned: 0,
    lost: 0,
    damaged: 0,
  },
  out_of_service_breakdown: {
    cleaning: 0,
    damaged: 1,
    maintenance: 0,
    lost: 0,
  },
  quantity_available: 10,
  quantity_booked: 5,
  quantity_held: 20,
  quantity_in_service: 18,
  quantity_out_of_service: 2,
  store_breakdown: [{
    uid_store: "test-store-1",
    name: "Main",
    default: true,
    crms_stock_level_id: null,
    quantity: 20,
    locations: [{
      uid_location: "test-loc-1",
      name: "Shelf A",
      quantity: 20,
      default: true,
      max: null,
    }],
  }],
  query_by_uid_store: ["test-store-1"],
  created_at: null,
  updated_at: null,
  expiresAt: null,
};

Deno.test("StockSummarySchema validates a complete document", () => {
  assertEquals(StockSummarySchema.safeParse(validSummary).success, true);
});

Deno.test("StockSummarySchema rejects invalid summary_type", () => {
  const doc = { ...validSummary, summary_type: "lease" };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema rejects invalid type", () => {
  const doc = { ...validSummary, type: "invalid" };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});

Deno.test("StockSummarySchema accepts sale summary_type", () => {
  const doc = { ...validSummary, summary_type: "sale", type: "sale" };
  assertEquals(StockSummarySchema.safeParse(doc).success, true);
});

Deno.test("StockSummarySchema accepts dates with end value", () => {
  const doc = {
    ...validSummary,
    dates: { ...validSummary.dates, end: "2026-03-10" },
  };
  assertEquals(StockSummarySchema.safeParse(doc).success, true);
});

Deno.test("StockSummarySchema rejects additional properties", () => {
  const doc = { ...validSummary, bogus: true };
  assertEquals(StockSummarySchema.safeParse(doc).success, false);
});
