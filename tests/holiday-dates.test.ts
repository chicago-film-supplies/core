import { assertEquals } from "@std/assert";
import { HolidayDatesSchema } from "../src/holiday-dates.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { date_fs: mockTimestamp, created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("HolidayDatesSchema validates a complete document", () => {
  const doc = {
    uid: "test-hd-1",
    uid_holiday: "test-holiday-1",
    date: "2026-12-25",
    name: "Christmas Day",
    type: "fixed",
    ...ts,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDatesSchema accepts variable type", () => {
  const doc = {
    uid: "test-hd-2",
    uid_holiday: "test-holiday-2",
    date: "2026-04-05",
    name: "Easter Sunday",
    type: "variable",
    ...ts,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDatesSchema rejects invalid type", () => {
  const doc = {
    uid: "test-hd-1",
    uid_holiday: "test-h-1",
    date: "2026-01-01",
    name: "New Year",
    type: "unknown",
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, false);
});

Deno.test("HolidayDatesSchema rejects additional properties", () => {
  const doc = {
    uid: "test-hd-1",
    uid_holiday: "test-h-1",
    date: "2026-01-01",
    name: "New Year",
    type: "fixed",
    bogus: true,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, false);
});
