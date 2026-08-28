import { assertEquals } from "@std/assert";
import { ContactSchema, CreateContactInput } from "../src/schemas/contact.ts";
import { CreateOrganizationInput } from "../src/schemas/organization.ts";
import { CreateOrderInput } from "../src/schemas/order.ts";
import { Email, Phone } from "../src/schemas/common.ts";

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
    uid: "testabc1230000000000",
    first_name: "",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
  };
  const result = ContactSchema.safeParse(doc);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("First name is required"), true);
  }
});

Deno.test("CreateContactInput shows custom error for empty first_name", () => {
  const input = { uid: "testabc1230000000000", first_name: "" };
  const result = CreateContactInput.safeParse(input);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("First name is required"), true);
  }
});

Deno.test("CreateOrganizationInput shows custom error for empty name", () => {
  // ⚠️ **Moved from `OrganizationSchema` to the INPUT** (api-cloudrun#709).
  // The stored scalar is gone — a document's name is `path.at(-1).name`, built
  // by the server from a resolved parent — so the document schema has no `name`
  // to reject. The message did not become obsolete, it moved to the one place an
  // empty name can still arrive: an operator's payload. Deleting the test would
  // have dropped the only coverage of that message.
  const result = CreateOrganizationInput.safeParse({ name: "", uid_parent: null });
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("Organization name is required"), true);
  }
});

Deno.test("CreateOrderInput shows custom error for empty destinations", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    dates: {
      delivery_start: "2026-01-01",
      delivery_end: "2026-01-02",
      collection_start: "2026-01-03",
      collection_end: "2026-01-04",
      charge_start: "2026-01-01",
      charge_end: "2026-01-04",
    },
    destinations: [],
  };
  const result = CreateOrderInput.safeParse(input);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(getMessages(result).includes("At least one destination is required"), true);
  }
});
