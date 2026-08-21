import { assertEquals } from "@std/assert";
import {
  CreateOrganizationInput,
  OrganizationSchema,
  UpdateOrganizationInput,
} from "../src/schemas/organization.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

const validAddress = {
  city: "Chicago",
  country_name: "US",
  full: "123 Main St, Chicago, IL",
  name: "HQ",
  postcode: "60601",
  region: "IL",
  street: "123 Main St",
};

const actor = { uid: "testuser100000000000", name: "Test User" };

Deno.test("OrganizationSchema validates a complete document", () => {
  const doc = {
    uid: "testorg1000000000000",
    name: "Acme Corp",
    crms_id: 100,
    xero_id: "00000000-0000-4000-8000-000000000001",
    emails: ["info@acme.com"],
    phones: ["1234567890"],
    billing_address: validAddress,
    contacts: [{ uid: "testc100000000000000", first_name: "John", name: "John", roles: ["admin"] }],
    query_by_contacts: ["testc100000000000000"],
    created_by: actor,
    updated_by: actor,
    ...ts,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects missing required fields", () => {
  assertEquals(OrganizationSchema.safeParse({ uid: "testorg1000000000000" }).success, false);
});

Deno.test("OrganizationSchema accepts null billing_address", () => {
  const doc = {
    uid: "testorg1000000000000",
    name: "Acme",
    crms_id: 1,
    xero_id: null,
    // `tax_profile` and `contacts` lost their `.default()` — the Typesense
    // config declares both required and a default never reaches the stored
    // doc. See `tests/typesense-parity.test.ts`.
    contacts: [],
    billing_address: null,
    created_by: actor,
    updated_by: actor,
    ...ts,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects ANY tax_profile — the field is gone (#596 item 3)", () => {
  // Was "rejects invalid tax_profile", asserting the member was validated.
  // The key itself no longer exists, so a VALID old member is refused exactly
  // like an invalid one — and asserting the valid one is what distinguishes
  // "the field was deleted" from "the field is still validated".
  // ⚠️ **A COMPLETE document, and that is the correction.** The arm this
  // replaces asserted only `success === false` against a fixture missing
  // `emails`, `phones`, `contacts`, `query_by_contacts` and the timestamps — so
  // it rejected whether or not `tax_profile` was there, and would have passed
  // against a schema that never validated the field at all. A one-sided
  // rejection assertion needs its positive half or it proves nothing.
  const base = {
    uid: "testorg1000000000000",
    name: "Acme",
    crms_id: 1,
    xero_id: null,
    emails: [],
    phones: [],
    billing_address: null,
    contacts: [],
    query_by_contacts: [],
    created_by: actor,
    updated_by: actor,
    ...ts,
  };
  assertEquals(OrganizationSchema.safeParse(base).success, true, "…without it, this parses");
  for (const value of ["tax_applied", "invalid"]) {
    assertEquals(
      OrganizationSchema.safeParse({ ...base, tax_profile: value }).success,
      false,
      `a stored ${value} is refused as an unknown key`,
    );
  }
});

Deno.test("OrganizationSchema rejects additional properties", () => {
  const doc = {
    uid: "testorg1000000000000",
    name: "Acme",
    crms_id: 1,
    xero_id: null,
    billing_address: null,
    created_by: actor,
    updated_by: actor,
    bogus: true,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, false);
});

Deno.test("CreateOrganizationInput accepts valid input", () => {
  const input = {
    uid: "testorg1000000000000",
    name: "Acme",
    billing_address: validAddress,
  };
  assertEquals(CreateOrganizationInput.safeParse(input).success, true);
});

Deno.test("UpdateOrganizationInput accepts partial update", () => {
  const input = { name: "New Name", version: 1 };
  assertEquals(UpdateOrganizationInput.safeParse(input).success, true);
});
