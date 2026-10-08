import { assertEquals } from "@std/assert";
import { deriveOOSStatus, emptyOOSBreakdown, oosCancelRefusal, sumOOSBreakdown } from "../src/utils/out-of-service.ts";
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

Deno.test("oosCancelRefusal: refused while units are flagged or away, and on a canceled record (G11 (a))", () => {
  const rec = (b: Partial<{ flagged: number; away: number; written_off: number; returned_to_service: number }>, canceled = false) => ({
    quantity: 3,
    breakdown: { flagged: 0, away: 0, written_off: 0, returned_to_service: 0, ...b },
    canceled_at: canceled ? ({ seconds: 1, nanoseconds: 0 } as never) : null,
  });
  assertEquals(oosCancelRefusal(rec({})), null);
  assertEquals(oosCancelRefusal(rec({ written_off: 1, returned_to_service: 2 })), null);
  assertEquals(oosCancelRefusal(rec({ flagged: 1, away: 1 }))?.includes("2 unit(s) are still out of service"), true);
  assertEquals(oosCancelRefusal(rec({}, true))?.includes("already canceled"), true);
});
