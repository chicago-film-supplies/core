import { assertEquals, assertThrows } from "@std/assert";
import {
  chicagoInstant,
  chicagoStartOfDay,
  toChicagoInstant,
  toChicagoStartOfDay,
} from "../src/_datetime.ts";

// Note: the _datetime.ts transforms are intentionally duplicated from
// @cfs/utilities/dates to avoid a cross-package runtime dependency.
// The expectation strings below are the parity contract — they must
// match the corresponding expectations in utilities-next/tests/dates.test.ts
// exactly. If you change one suite, change the other.

// ── toChicagoInstant ────────────────────────────────────────────

Deno.test("toChicagoInstant: Z → Chicago offset (CST)", () => {
  assertEquals(
    toChicagoInstant("2025-12-22T15:15:00.000Z"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("toChicagoInstant: Z → Chicago offset (CDT)", () => {
  assertEquals(
    toChicagoInstant("2025-07-04T14:15:00.000Z"),
    "2025-07-04T09:15:00.000-05:00",
  );
});

Deno.test("toChicagoInstant is no-op on canonical form", () => {
  assertEquals(
    toChicagoInstant("2025-12-22T09:15:00.000-06:00"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("toChicagoInstant is idempotent", () => {
  const once = toChicagoInstant("2025-12-22T15:15:00.000Z");
  assertEquals(toChicagoInstant(once), once);
});

// ── toChicagoStartOfDay ─────────────────────────────────────────

Deno.test("toChicagoStartOfDay snaps to Chicago midnight", () => {
  assertEquals(
    toChicagoStartOfDay("2025-12-22T15:15:00.000Z"),
    "2025-12-22T00:00:00.000-06:00",
  );
});

Deno.test("toChicagoStartOfDay crosses to previous Chicago day", () => {
  assertEquals(
    toChicagoStartOfDay("2025-12-22T03:00:00.000Z"),
    "2025-12-21T00:00:00.000-06:00",
  );
});

Deno.test("toChicagoStartOfDay handles date-only string (CDT)", () => {
  assertEquals(
    toChicagoStartOfDay("2025-07-04"),
    "2025-07-04T00:00:00.000-05:00",
  );
});

Deno.test("toChicagoStartOfDay is idempotent", () => {
  const once = toChicagoStartOfDay("2025-12-22T15:15:00.000Z");
  assertEquals(toChicagoStartOfDay(once), once);
});

// ── Factories: chicagoInstant() ─────────────────────────────────

Deno.test("chicagoInstant factory parses Z form and canonicalizes", () => {
  const schema = chicagoInstant();
  assertEquals(
    schema.parse("2025-12-22T15:15:00.000Z"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("chicagoInstant factory parses offset form unchanged", () => {
  const schema = chicagoInstant();
  assertEquals(
    schema.parse("2025-12-22T09:15:00.000-06:00"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("chicagoInstant factory normalizes cross-tz input to Chicago", () => {
  const schema = chicagoInstant();
  assertEquals(
    schema.parse("2025-12-23T00:15:00.000+09:00"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("chicagoInstant factory rejects bare date (no offset)", () => {
  const schema = chicagoInstant();
  assertThrows(() => schema.parse("2025-12-22"));
});

Deno.test("chicagoInstant factory rejects malformed input", () => {
  const schema = chicagoInstant();
  assertThrows(() => schema.parse("not a date"));
});

Deno.test("chicagoInstant factory double-parse is idempotent", () => {
  const schema = chicagoInstant();
  const once = schema.parse("2025-12-22T15:15:00.000Z");
  assertEquals(schema.parse(once), once);
});

// ── Factories: chicagoStartOfDay() ──────────────────────────────

Deno.test("chicagoStartOfDay factory snaps Z form to Chicago midnight", () => {
  const schema = chicagoStartOfDay();
  assertEquals(
    schema.parse("2025-12-22T15:15:00.000Z"),
    "2025-12-22T00:00:00.000-06:00",
  );
});

Deno.test("chicagoStartOfDay factory crosses to previous day correctly", () => {
  const schema = chicagoStartOfDay();
  assertEquals(
    schema.parse("2025-12-22T03:00:00.000Z"),
    "2025-12-21T00:00:00.000-06:00",
  );
});

Deno.test("chicagoStartOfDay factory rejects bare date string", () => {
  const schema = chicagoStartOfDay();
  assertThrows(() => schema.parse("2025-12-22"));
});

Deno.test("chicagoStartOfDay factory double-parse is idempotent", () => {
  const schema = chicagoStartOfDay();
  const once = schema.parse("2025-12-22T15:15:00.000Z");
  assertEquals(schema.parse(once), once);
});
