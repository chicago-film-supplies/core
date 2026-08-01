import { assertEquals } from "@std/assert";
import { ChartOfAccountsSchema } from "../src/schemas/chart-of-accounts.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * A minimal VALID document, overridable per case.
 *
 * Every negative below is this minus/plus exactly one thing, so it fails for the
 * reason it names. The previous cut hand-rolled each fixture and three of them
 * omitted `created_at`/`updated_at` — so they were green because the document was
 * incomplete, not because the field under test was rejected. Adding a required
 * field silently rewrites that kind of negative test into a different one.
 */
const make = (over: Record<string, unknown> = {}) => ({
  uid: "testcoa1000000000000",
  code: 4000,
  name: "Rental Income",
  type: "Sales",
  class: "Revenue",
  status: "Active",
  xero_id: "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  default_tax_profile: "tax_chicago_rental_tax",
  version: 0,
  created_by: { uid: "testuser100000000000", name: "Test User" },
  updated_by: { uid: "testuser100000000000", name: "Test User" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
  ...over,
});

Deno.test("ChartOfAccountsSchema validates a complete document", () => {
  assertEquals(ChartOfAccountsSchema.safeParse(make()).success, true);
});

Deno.test("the fixture is minimal — dropping any required field rejects it", () => {
  // Proves the negatives below fail for their own reason rather than because
  // the fixture was incomplete to begin with.
  // `as const` keeps `field` a literal union rather than widening to `string`,
  // which is what makes the computed destructuring below legal without a cast —
  // and it means a misspelled field name is a compile error instead of a loop
  // iteration that quietly asserts nothing.
  const REQUIRED = ["uid", "code", "name", "type", "class", "status", "xero_id", "created_at"] as const;
  for (const field of REQUIRED) {
    const { [field]: _dropped, ...rest } = make();
    assertEquals(
      ChartOfAccountsSchema.safeParse(rest).success,
      false,
      `expected a document missing "${field}" to be rejected`,
    );
  }
});

Deno.test("code is an open integer, no longer a closed union", () => {
  // The literal union is gone: the `chart-of-accounts` collection is the
  // catalog, because a hardcoded list went stale and could not express 6900
  // (Bad Debt) the day a credit note needed it. 9999 used to be rejected purely
  // for being absent from the list; it is an ordinary account code now.
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: 9999 })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: 6900 })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: 6000 })).success, true);

  // Still a positive integer — the shape of an account code, not "any number".
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: 0 })).success, false);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: -1 })).success, false);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: 4000.5 })).success, false);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ code: "4000" })).success, false);
});

Deno.test("class carries the posting-side axis independently of type", () => {
  // Xero splits REVENUE class across three Types — SALES, REVENUE, OTHERINCOME —
  // so `type` cannot answer "which side of a posting is this?". That is why
  // `class` is stored rather than derived from `type`.
  assertEquals(ChartOfAccountsSchema.safeParse(make({ type: "Sales", class: "Revenue" })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ type: "Other Income", class: "Revenue" })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ type: "Expense", class: "Expense" })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ class: "Fake" })).success, false);
});

Deno.test("archived accounts are representable, so historical lines still resolve", () => {
  assertEquals(ChartOfAccountsSchema.safeParse(make({ status: "Archived" })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ status: "Deleted" })).success, false);
});

Deno.test("xero_id is nullable but never absent, and must be a uuid", () => {
  assertEquals(ChartOfAccountsSchema.safeParse(make({ xero_id: null })).success, true);
  assertEquals(ChartOfAccountsSchema.safeParse(make({ xero_id: "4000" })).success, false);
});

Deno.test("ChartOfAccountsSchema rejects an unknown type", () => {
  assertEquals(ChartOfAccountsSchema.safeParse(make({ type: "Fake Type" })).success, false);
});

Deno.test("ChartOfAccountsSchema rejects additional properties", () => {
  assertEquals(ChartOfAccountsSchema.safeParse(make({ bogus: true })).success, false);
});
