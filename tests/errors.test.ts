import { assertEquals } from "@std/assert";
import { ContactSchema, CreateContactInput } from "../src/contact.ts";
import { OrganizationSchema } from "../src/organization.ts";
import { CreateOrderInput } from "../src/order.ts";
import { Email, Phone } from "../src/common.ts";

/** Helper: extract issue messages from a failed safeParse result. */
function getMessages(result: { success: false; error: { issues: { message: string }[] } }): string[] {
  return result.error.issues.map((i) => i.message);
}

Deno.test("Email shows custom error for invalid format", () => {
  const result = Email.safeParse("not-an-email");
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("Must be a valid email address"), true);
  }
});

Deno.test("Phone shows custom error for too-short value", () => {
  const result = Phone.safeParse("123");
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("Phone number must be at least 10 characters"), true);
  }
});

Deno.test("Phone shows custom error for too-long value", () => {
  const result = Phone.safeParse("1".repeat(21));
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("Phone number must not exceed 20 characters"), true);
  }
});

Deno.test("ContactSchema shows custom error for empty first_name", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  const result = ContactSchema.safeParse(doc);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("First name is required"), true);
  }
});

Deno.test("CreateContactInput shows custom error for empty first_name", () => {
  const input = { uid: "test-abc-123", first_name: "" };
  const result = CreateContactInput.safeParse(input);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("First name is required"), true);
  }
});

Deno.test("OrganizationSchema shows custom error for empty name", () => {
  const doc = {
    uid: "test-org-1",
    name: "",
    crms_id: 1,
    xero_id: null,
    tax_profile: "tax_applied",
    emails: [],
    phones: [],
    billing_address: null,
    contacts: [],
    query_by_contacts: [],
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  const result = OrganizationSchema.safeParse(doc);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("Organization name is required"), true);
  }
});

Deno.test("CreateOrderInput shows custom error for empty destinations", () => {
  const input = {
    uid: "test-order-1",
    organization: { uid: "test-org-1" },
    status: "draft",
    dates: {
      delivery_start: "2026-01-01",
      delivery_end: "2026-01-02",
      collection_start: "2026-01-03",
      collection_end: "2026-01-04",
      charge_start: "2026-01-01",
      charge_end: "2026-01-04",
    },
    tax_profile: "tax_applied",
    destinations: [],
  };
  const result = CreateOrderInput.safeParse(input);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("At least one destination is required"), true);
  }
});
