import { assertEquals } from "@std/assert";
import {
  CreateOrganizationInput,
  OrganizationSchema,
  UpdateOrganizationInput,
} from "../src/organization.ts";

const validAddress = {
  city: "Chicago",
  country_name: "US",
  full: "123 Main St, Chicago, IL",
  name: "HQ",
  postcode: "60601",
  region: "IL",
  street: "123 Main St",
};

const actor = { uid: "test-user-1", name: "Test User" };

Deno.test("OrganizationSchema validates a complete document", () => {
  const doc = {
    uid: "test-org-1",
    name: "Acme Corp",
    crms_id: 100,
    xero_id: "test-xero-1",
    tax_profile: "tax_applied",
    emails: ["info@acme.com"],
    phones: ["1234567890"],
    billing_address: validAddress,
    contacts: [{ uid: "test-c1", first_name: "John", name: "John", roles: ["admin"] }],
    query_by_contacts: ["test-c1"],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects missing required fields", () => {
  assertEquals(OrganizationSchema.safeParse({ uid: "test-org-1" }).success, false);
});

Deno.test("OrganizationSchema accepts null billing_address", () => {
  const doc = {
    uid: "test-org-1",
    name: "Acme",
    crms_id: 1,
    xero_id: null,
    billing_address: null,
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects invalid tax_profile", () => {
  const doc = {
    uid: "test-org-1",
    name: "Acme",
    crms_id: 1,
    xero_id: null,
    tax_profile: "invalid",
    billing_address: null,
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(OrganizationSchema.safeParse(doc).success, false);
});

Deno.test("OrganizationSchema rejects additional properties", () => {
  const doc = {
    uid: "test-org-1",
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
    uid: "test-org-1",
    name: "Acme",
    tax_profile: "tax_applied",
    billing_address: validAddress,
  };
  assertEquals(CreateOrganizationInput.safeParse(input).success, true);
});

Deno.test("UpdateOrganizationInput accepts partial update", () => {
  const input = { name: "New Name", version: 1 };
  assertEquals(UpdateOrganizationInput.safeParse(input).success, true);
});
