import { assertEquals } from "@std/assert";
import {
  CreateHolidayDefinitionInput,
  HolidayDefinitionSchema,
  UpdateHolidayDefinitionInput,
} from "../src/schemas/holiday-definition.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "manager-bot", name: "Manager Bot" };
const meta = {
  active: true,
  version: 0,
  created_by: actor,
  updated_by: actor,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};
const DEF_ID = "aB3dE5gH7jK9mN1pQ3rT";

Deno.test("HolidayDefinitionSchema validates a fixed-date holiday", () => {
  const doc = {
    uid: DEF_ID,
    type: "fixed",
    name: "Christmas Day",
    display_month: 12,
    js_month: 11,
    date: 25,
    ...meta,
  };
  assertEquals(HolidayDefinitionSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDefinitionSchema validates a variable-date holiday", () => {
  const doc = {
    uid: DEF_ID,
    type: "variable",
    name: "Thanksgiving",
    display_month: 11,
    js_month: 10,
    day: "4",
    display_day: "Thursday",
    week: "4",
    display_suffix: "th",
    ...meta,
  };
  assertEquals(HolidayDefinitionSchema.safeParse(doc).success, true);
});

Deno.test("HolidayDefinitionSchema applies active/version defaults when omitted", () => {
  const doc = {
    uid: DEF_ID,
    type: "fixed",
    name: "New Year's Day",
    display_month: 1,
    js_month: 0,
    date: 1,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
  const parsed = HolidayDefinitionSchema.safeParse(doc);
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data.active, true);
    assertEquals(parsed.data.version, 0);
  }
});

Deno.test("HolidayDefinitionSchema rejects a uuid uid (Firestore auto-id only)", () => {
  const doc = {
    uid: "11111111-1111-4111-8111-111111111111",
    type: "fixed",
    name: "Christmas Day",
    display_month: 12,
    js_month: 11,
    date: 25,
    ...meta,
  };
  assertEquals(HolidayDefinitionSchema.safeParse(doc).success, false);
});

Deno.test("HolidayDefinitionSchema rejects additional properties", () => {
  const doc = {
    uid: DEF_ID,
    type: "fixed",
    name: "Christmas Day",
    display_month: 12,
    js_month: 11,
    date: 25,
    bogus: true,
    ...meta,
  };
  assertEquals(HolidayDefinitionSchema.safeParse(doc).success, false);
});

Deno.test("CreateHolidayDefinitionInput accepts fixed + variable inputs", () => {
  assertEquals(
    CreateHolidayDefinitionInput.safeParse({
      type: "fixed",
      name: "Christmas Day",
      month: 12,
      date: 25,
    }).success,
    true,
  );
  assertEquals(
    CreateHolidayDefinitionInput.safeParse({
      type: "variable",
      name: "Thanksgiving",
      month: 11,
      day: 4,
      week: "4",
    }).success,
    true,
  );
});

Deno.test("CreateHolidayDefinitionInput rejects a fixed input missing date", () => {
  assertEquals(
    CreateHolidayDefinitionInput.safeParse({ type: "fixed", name: "X", month: 12 }).success,
    false,
  );
});

Deno.test("CreateHolidayDefinitionInput rejects a variable input missing week", () => {
  assertEquals(
    CreateHolidayDefinitionInput.safeParse({ type: "variable", name: "X", month: 11, day: 4 }).success,
    false,
  );
});

Deno.test("UpdateHolidayDefinitionInput requires uid + version", () => {
  assertEquals(
    UpdateHolidayDefinitionInput.safeParse({
      uid: DEF_ID,
      version: 3,
      type: "fixed",
      name: "Christmas Day",
      month: 12,
      date: 25,
    }).success,
    true,
  );
  // Missing version → rejected.
  assertEquals(
    UpdateHolidayDefinitionInput.safeParse({
      uid: DEF_ID,
      type: "fixed",
      name: "Christmas Day",
      month: 12,
      date: 25,
    }).success,
    false,
  );
});
