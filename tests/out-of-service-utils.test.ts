import { assertEquals } from "@std/assert";
import { deriveOOSStatus, emptyOOSBreakdown, sumOOSBreakdown } from "../src/utils/out-of-service.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("deriveOOSStatus: canceled wins over everything", () => {
  assertEquals(
    deriveOOSStatus({ quantity: 2, breakdown: { ...emptyOOSBreakdown(), written_off: 2 }, canceled_at: mockTimestamp }),
    "canceled",
  );
});

Deno.test("deriveOOSStatus: complete once every unit is resolved", () => {
  const breakdown = { ...emptyOOSBreakdown(), written_off: 1, returned_to_service: 2 };
  assertEquals(deriveOOSStatus({ quantity: 3, breakdown, canceled_at: null }), "complete");
});

Deno.test("deriveOOSStatus: active while any unit is flagged, away, or not yet in effect", () => {
  assertEquals(deriveOOSStatus({ quantity: 3, breakdown: { ...emptyOOSBreakdown(), flagged: 3 }, canceled_at: null }), "active");
  assertEquals(deriveOOSStatus({ quantity: 3, breakdown: { ...emptyOOSBreakdown(), away: 1, written_off: 2 }, canceled_at: null }), "active");
  assertEquals(deriveOOSStatus({ quantity: 3, breakdown: emptyOOSBreakdown(), canceled_at: null }), "active", "a future start");
});

Deno.test("sumOOSBreakdown counts every bucket", () => {
  assertEquals(sumOOSBreakdown({ flagged: 1, away: 2, written_off: 3, returned_to_service: 4 }), 10);
});
