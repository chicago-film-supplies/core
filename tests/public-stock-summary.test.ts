import { assertEquals } from "@std/assert";
import { PublicStockSummarySchema } from "../src/public-stock-summary.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const validSummary = {
  uid: "testprod100000000000:rental:2026-03-01:2036-03-01",
  uid_product: "testprod100000000000",
  summary_type: "rental",
  type: "rental",
  dates: {
    start: "2026-03-01",
    start_fs: mockTimestamp,
    end: null,
    end_fs: null,
  },
  quantity_available: 10,
  store_breakdown: [{ uid_store: "teststore10000000000", quantity: 10 }],
  query_by_uid_store: ["teststore10000000000"],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
  expiresAt: mockTimestamp,
};

Deno.test("PublicStockSummarySchema validates a complete document", () => {
  assertEquals(PublicStockSummarySchema.safeParse(validSummary).success, true);
});

Deno.test("PublicStockSummarySchema requires uid", () => {
  const { uid: _, ...doc } = validSummary;
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, false);
});

Deno.test("PublicStockSummarySchema accepts dates with end value", () => {
  const doc = {
    ...validSummary,
    dates: { ...validSummary.dates, end: "2026-03-10" },
  };
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, true);
});

Deno.test("PublicStockSummarySchema rejects invalid summary_type", () => {
  const doc = { ...validSummary, summary_type: "invalid" };
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, false);
});

Deno.test("PublicStockSummarySchema rejects additional properties", () => {
  const doc = { ...validSummary, bogus: true };
  assertEquals(PublicStockSummarySchema.safeParse(doc).success, false);
});
