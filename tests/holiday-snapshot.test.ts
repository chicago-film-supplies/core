import { assertEquals } from "@std/assert";
import { HolidaySnapshotSchema } from "../src/schemas/holiday-snapshot.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("HolidaySnapshotSchema validates a complete snapshot", () => {
  const doc = {
    uid: "current",
    materialized_dates: ["2026-01-01", "2026-12-25"],
    materialized_count: 2,
    materialized_year_range: { from: 2026, to: 2029 },
    materialized_at: mockTimestamp,
  };
  assertEquals(HolidaySnapshotSchema.safeParse(doc).success, true);
});

Deno.test("HolidaySnapshotSchema rejects a uid other than 'current'", () => {
  const doc = {
    uid: "stale",
    materialized_dates: [],
    materialized_count: 0,
    materialized_year_range: { from: 2026, to: 2029 },
    materialized_at: mockTimestamp,
  };
  assertEquals(HolidaySnapshotSchema.safeParse(doc).success, false);
});

Deno.test("HolidaySnapshotSchema rejects non-ISO dates", () => {
  const doc = {
    uid: "current",
    materialized_dates: ["12/25/2026"],
    materialized_count: 1,
    materialized_year_range: { from: 2026, to: 2029 },
    materialized_at: mockTimestamp,
  };
  assertEquals(HolidaySnapshotSchema.safeParse(doc).success, false);
});

Deno.test("HolidaySnapshotSchema rejects additional properties", () => {
  const doc = {
    uid: "current",
    materialized_dates: [],
    materialized_count: 0,
    materialized_year_range: { from: 2026, to: 2029 },
    materialized_at: mockTimestamp,
    bogus: true,
  };
  assertEquals(HolidaySnapshotSchema.safeParse(doc).success, false);
});
