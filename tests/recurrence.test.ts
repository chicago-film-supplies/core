import { assertEquals } from "@std/assert";
import {
  CreateRecurrenceInput,
  RecurrenceRule,
  RecurrenceSchema,
  UpdateRecurrenceInput,
} from "../src/recurrence.ts";

const validRule = {
  freq: "WEEKLY" as const,
  interval: 1,
  byweekday: ["TU"] as ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[],
  bymonthday: null,
  bymonth: null,
  bysetpos: null,
  count: null,
  until: null,
};

const validPrototype = {
  subject: "Weekly shoot — ACME",
  body: null,
  body_text: "",
  status: "planned" as const,
  destination: null,
  sources: [{ collection: "organizations", uid: "org-1" }],
  attachments: [],
  uid_assignees: [],
  locked: ["card" as const, "subject" as const],
};

const validRecurrence = {
  uid: "rec-1",
  uid_list: "list-1",
  status: "active" as const,
  rule: validRule,
  active_from: "2026-04-21",
  active_until: null,
  horizon_through: "2026-06-20",
  horizon_days: null,
  exception_dates: [],
  prototype: validPrototype,
  created_by: { uid: "user-1", name: "Alex" },
  updated_by: { uid: "user-1", name: "Alex" },
  created_at: null,
  updated_at: null,
};

Deno.test("RecurrenceSchema validates a complete document", () => {
  assertEquals(RecurrenceSchema.safeParse(validRecurrence).success, true);
});

Deno.test("RecurrenceSchema accepts paused + archived status values", () => {
  for (const status of ["paused", "archived"] as const) {
    const doc = { ...validRecurrence, status };
    assertEquals(RecurrenceSchema.safeParse(doc).success, true);
  }
});

Deno.test("RecurrenceSchema rejects an invalid status", () => {
  const doc = { ...validRecurrence, status: "running" };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

Deno.test("RecurrenceSchema accepts all four FREQ values", () => {
  for (const freq of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const) {
    const doc = { ...validRecurrence, rule: { ...validRule, freq } };
    assertEquals(RecurrenceSchema.safeParse(doc).success, true);
  }
});

Deno.test("RecurrenceRule rejects freq/interval under 1", () => {
  const bad = { ...validRule, interval: 0 };
  assertEquals(RecurrenceRule.safeParse(bad).success, false);
});

Deno.test("RecurrenceRule rejects count and until together", () => {
  const bad = { ...validRule, count: 12, until: "2027-01-01" };
  assertEquals(RecurrenceRule.safeParse(bad).success, false);
});

Deno.test("RecurrenceRule accepts count alone", () => {
  const rule = { ...validRule, count: 12, until: null };
  assertEquals(RecurrenceRule.safeParse(rule).success, true);
});

Deno.test("RecurrenceRule accepts until alone", () => {
  const rule = { ...validRule, count: null, until: "2027-01-01" };
  assertEquals(RecurrenceRule.safeParse(rule).success, true);
});

Deno.test("RecurrenceRule rejects bymonthday of 0", () => {
  const bad = { ...validRule, bymonthday: [0] };
  assertEquals(RecurrenceRule.safeParse(bad).success, false);
});

Deno.test("RecurrenceRule accepts negative bymonthday for last-of-month", () => {
  const rule = { ...validRule, bymonthday: [-1] };
  assertEquals(RecurrenceRule.safeParse(rule).success, true);
});

Deno.test("RecurrenceRule accepts bysetpos for 'first Monday' pattern", () => {
  const rule = { ...validRule, freq: "MONTHLY" as const, byweekday: ["MO" as const], bysetpos: [1] };
  assertEquals(RecurrenceRule.safeParse(rule).success, true);
});

Deno.test("RecurrenceSchema rejects an invalid weekday code", () => {
  const doc = {
    ...validRecurrence,
    rule: { ...validRule, byweekday: ["MON"] },
  };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

Deno.test("RecurrenceSchema accepts exception_dates with deleted instance dates", () => {
  const doc = { ...validRecurrence, exception_dates: ["2026-05-05", "2026-05-12"] };
  assertEquals(RecurrenceSchema.safeParse(doc).success, true);
});

Deno.test("RecurrenceSchema accepts horizon_days override", () => {
  const doc = { ...validRecurrence, horizon_days: 90 };
  assertEquals(RecurrenceSchema.safeParse(doc).success, true);
});

Deno.test("RecurrenceSchema rejects horizon_days of 0", () => {
  const doc = { ...validRecurrence, horizon_days: 0 };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

Deno.test("RecurrenceSchema rejects unknown properties on the root", () => {
  const doc = { ...validRecurrence, extra: "nope" };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

Deno.test("RecurrenceSchema rejects unknown properties on the prototype", () => {
  const doc = {
    ...validRecurrence,
    prototype: { ...validPrototype, extra: "nope" },
  };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

Deno.test("RecurrenceSchema rejects invalid lock key on prototype", () => {
  const doc = {
    ...validRecurrence,
    prototype: { ...validPrototype, locked: ["uid"] },
  };
  assertEquals(RecurrenceSchema.safeParse(doc).success, false);
});

// ── Input schemas ───────────────────────────────────────────────────

Deno.test("CreateRecurrenceInput accepts a minimal payload", () => {
  const input = {
    uid_list: "list-1",
    rule: validRule,
    active_from: "2026-04-21",
    prototype: { subject: "Weekly shoot" },
  };
  assertEquals(CreateRecurrenceInput.safeParse(input).success, true);
});

Deno.test("CreateRecurrenceInput rejects an empty prototype subject", () => {
  const input = {
    uid_list: "list-1",
    rule: validRule,
    active_from: "2026-04-21",
    prototype: { subject: "" },
  };
  assertEquals(CreateRecurrenceInput.safeParse(input).success, false);
});

Deno.test("UpdateRecurrenceInput accepts status-only patch", () => {
  assertEquals(
    UpdateRecurrenceInput.safeParse({ status: "paused", version: 1 }).success,
    true,
  );
});

Deno.test("UpdateRecurrenceInput accepts rule-only patch", () => {
  const input = { rule: { ...validRule, interval: 2 }, version: 1 };
  assertEquals(UpdateRecurrenceInput.safeParse(input).success, true);
});

Deno.test("UpdateRecurrenceInput accepts a partial prototype patch", () => {
  const input = { prototype: { subject: "Renamed series" }, version: 1 };
  assertEquals(UpdateRecurrenceInput.safeParse(input).success, true);
});

Deno.test("UpdateRecurrenceInput accepts horizon_days null to clear override", () => {
  assertEquals(
    UpdateRecurrenceInput.safeParse({ horizon_days: null, version: 1 }).success,
    true,
  );
});

Deno.test("UpdateRecurrenceInput rejects missing version", () => {
  assertEquals(
    UpdateRecurrenceInput.safeParse({ status: "paused" }).success,
    false,
  );
});
