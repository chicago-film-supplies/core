import { assertEquals } from "@std/assert";
import { HolidayDatesSchema } from "../src/schemas/holiday-dates.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { date_fs: mockTimestamp, created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("HolidayDatesSchema validates a complete document", () => {
  const doc = {
    uid: "testhd10000000000000",
    uid_holiday: "11111111-1111-4111-8111-111111111111",
    date: "2026-12-25",
    name: "Christmas Day",
    type: "fixed",
    ...ts,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDatesSchema accepts variable type", () => {
  const doc = {
    uid: "testhd20000000000000",
    uid_holiday: "22222222-2222-4222-8222-222222222222",
    date: "2026-04-05",
    name: "Easter Sunday",
    type: "variable",
    ...ts,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDatesSchema rejects invalid type", () => {
  const doc = {
    uid: "testhd10000000000000",
    uid_holiday: "11111111-1111-4111-8111-111111111111",
    date: "2026-01-01",
    name: "New Year",
    type: "unknown",
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, false);
});

Deno.test("HolidayDatesSchema rejects additional properties", () => {
  const doc = {
    uid: "testhd10000000000000",
    uid_holiday: "11111111-1111-4111-8111-111111111111",
    date: "2026-01-01",
    name: "New Year",
    type: "fixed",
    bogus: true,
  };
  assertEquals(HolidayDatesSchema.safeParse(doc).success, false);
});
