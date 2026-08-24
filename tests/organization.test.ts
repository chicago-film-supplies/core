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

/**
 * A MINIMAL VALID organization document, so every negative case below fails for
 * exactly the reason it names.
 *
 * ⚠️ Introduced when `uid_thread` became required (2026-08-23). The
 * "rejects additional properties" case below is the one that shows why: it
 * already omitted `emails`, `phones`, `contacts`, `query_by_contacts` and both
 * timestamps, so it rejected whether or not the extra key was there — the same
 * defect this file's `tax_profile` test had already been corrected for, still
 * live one test lower down.
 */
const validOrganization = (overrides: Record<string, unknown> = {}) => ({
  uid: "testorg1000000000000",
  name: "Acme",
  crms_id: 1,
  xero_id: null as string | null,
  emails: [] as string[],
  phones: [] as string[],
  billing_address: null as Record<string, unknown> | null,
  contacts: [] as Array<Record<string, unknown>>,
  query_by_contacts: [] as string[],
  uid_thread: "testthread0000000000",
  created_by: actor,
  updated_by: actor,
  ...ts,
  ...overrides,
});

Deno.test("OrganizationSchema validates a complete document", () => {
  const doc = validOrganization({
    name: "Acme Corp",
    crms_id: 100,
    xero_id: "00000000-0000-4000-8000-000000000001",
    emails: ["info@acme.com"],
    phones: ["1234567890"],
    billing_address: validAddress,
    contacts: [{ uid: "testc100000000000000", first_name: "John", name: "John", roles: ["admin"] }],
    query_by_contacts: ["testc100000000000000"],
  });
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects missing required fields", () => {
  assertEquals(OrganizationSchema.safeParse({ uid: "testorg1000000000000" }).success, false);
});

Deno.test("OrganizationSchema requires uid_thread — every organization is born with a thread", () => {
  // 291/291 prod and 313/313 dev carry the key (2026-08-23, `orderBy`
  // key-presence), and dev's 22 native extras carrying it is what makes this a
  // fact about `createOrganization` rather than about the CRMS ingest.
  const { uid_thread: _omitted, ...withoutThread } = validOrganization();
  assertEquals(OrganizationSchema.safeParse(withoutThread).success, false);
});

Deno.test("OrganizationSchema accepts null billing_address", () => {
  // `contacts` lost its `.default()` — the Typesense config declares it
  // required and a default never reaches the stored doc. See
  // `tests/typesense-parity.test.ts`.
  assertEquals(OrganizationSchema.safeParse(validOrganization({ billing_address: null })).success, true);
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
  assertEquals(OrganizationSchema.safeParse(validOrganization()).success, true, "…without it, this parses");
  for (const value of ["tax_applied", "invalid"]) {
    assertEquals(
      OrganizationSchema.safeParse(validOrganization({ tax_profile: value })).success,
      false,
      `a stored ${value} is refused as an unknown key`,
    );
  }
});

Deno.test("OrganizationSchema rejects additional properties", () => {
  assertEquals(OrganizationSchema.safeParse(validOrganization({ bogus: true })).success, false);
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
