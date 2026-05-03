import { assertEquals } from "@std/assert";
import {
  ContactSchema,
  CreateContactInput,
  UpdateContactInput,
} from "../src/contact.ts";

const actor = { uid: "test-user-1", name: "Test User" };

Deno.test("ContactSchema validates a complete contact document", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    last_name: "Doe",
    name: "John Doe",
    emails: ["john@example.com"],
    phones: ["1234567890"],
    organizations: [{ uid: "test-org-1", name: "Acme" }],
    query_by_organizations: ["test-org-1"],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema accepts contact without last_name", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    name: "John",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema rejects missing required fields", () => {
  const doc = { uid: "test-abc-123" };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("ContactSchema rejects empty first_name", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("ContactSchema rejects additional properties", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
    bogus: true,
  };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("ContactSchema allows optional crms_id", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    name: "John",
    crms_id: 42,
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("CreateContactInput accepts minimal input", () => {
  const input = { uid: "test-abc-123", first_name: "John" };
  assertEquals(CreateContactInput.safeParse(input).success, true);
});

Deno.test("CreateContactInput accepts full input", () => {
  const input = {
    uid: "test-abc-123",
    first_name: "John",
    last_name: "Doe",
    emails: ["john@example.com"],
    phones: ["1234567890"],
    organizations: [{ uid: "test-org-1", name: "Acme" }],
  };
  assertEquals(CreateContactInput.safeParse(input).success, true);
});

Deno.test("UpdateContactInput accepts partial update", () => {
  const input = { first_name: "Jane", version: 1 };
  assertEquals(UpdateContactInput.safeParse(input).success, true);
});

Deno.test("UpdateContactInput rejects empty first_name", () => {
  const input = { first_name: "", version: 1 };
  assertEquals(UpdateContactInput.safeParse(input).success, false);
});

Deno.test("ContactSchema accepts middle_name and pronunciation", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    middle_name: "Quincy",
    last_name: "Doe",
    pronunciation: "JON QUIN-see DOH",
    name: "John Quincy Doe (JON QUIN-see DOH)",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema rejects empty middle_name", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    middle_name: "",
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("ContactSchema rejects pronunciation longer than 100 chars", () => {
  const doc = {
    uid: "test-abc-123",
    first_name: "John",
    pronunciation: "x".repeat(101),
    emails: [],
    phones: [],
    organizations: [],
    query_by_organizations: [],
    created_by: actor,
    updated_by: actor,
  };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("CreateContactInput accepts middle_name and pronunciation", () => {
  const input = {
    uid: "test-abc-123",
    first_name: "John",
    middle_name: "Quincy",
    last_name: "Doe",
    pronunciation: "JON QUIN-see DOH",
  };
  assertEquals(CreateContactInput.safeParse(input).success, true);
});

Deno.test("UpdateContactInput accepts middle_name only", () => {
  const input = { middle_name: "Quincy", version: 2 };
  assertEquals(UpdateContactInput.safeParse(input).success, true);
});

Deno.test("UpdateContactInput accepts pronunciation only", () => {
  const input = { pronunciation: "JON DOH", version: 2 };
  assertEquals(UpdateContactInput.safeParse(input).success, true);
});
