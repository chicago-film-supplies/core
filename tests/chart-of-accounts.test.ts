import { assertEquals } from "@std/assert";
import { ChartOfAccountsSchema } from "../src/chart-of-accounts.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("ChartOfAccountsSchema validates a complete document", () => {
  const doc = {
    uid: "testcoa1000000000000",
    code: 4000,
    name: "Sales",
    type: "Revenue",
    description: "General sales revenue",
    default_tax_profile: "tax_chicago_sales_tax",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
  assertEquals(ChartOfAccountsSchema.safeParse(doc).success, true);
});

Deno.test("ChartOfAccountsSchema rejects invalid code", () => {
  const doc = {
    uid: "testcoa1000000000000",
    code: 9999,
    name: "Invalid",
    type: "Revenue",
    default_tax_profile: "tax_none",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
  };
  assertEquals(ChartOfAccountsSchema.safeParse(doc).success, false);
});

Deno.test("ChartOfAccountsSchema rejects invalid type", () => {
  const doc = {
    uid: "testcoa1000000000000",
    code: 4000,
    name: "Sales",
    type: "Fake Type",
    default_tax_profile: "tax_none",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
  };
  assertEquals(ChartOfAccountsSchema.safeParse(doc).success, false);
});

Deno.test("ChartOfAccountsSchema rejects additional properties", () => {
  const doc = {
    uid: "testcoa1000000000000",
    code: 4000,
    name: "Sales",
    type: "Revenue",
    default_tax_profile: "tax_none",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    bogus: true,
  };
  assertEquals(ChartOfAccountsSchema.safeParse(doc).success, false);
});
