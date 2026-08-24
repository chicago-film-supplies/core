import { assertEquals } from "@std/assert";
import {
  ContactSchema,
  CreateContactInput,
  UpdateContactInput,
} from "../src/schemas/contact.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "testuser100000000000", name: "Test User" };
const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

/**
 * A MINIMAL VALID contact document, so every negative case below fails for
 * exactly the reason it names.
 *
 * ⚠️ **This factory exists because the four negative tests here were ALREADY
 * passing for the wrong reason before `uid_thread` became required
 * (2026-08-23).** Each spelled its fields inline and each omitted `name` and
 * the two timestamps — all three required long before this wave — so
 * "rejects empty first_name" was really asserting "rejects SOMETHING", and the
 * `first_name` constraint it names could have been deleted with the test still
 * green. Requiring one more field would have hidden that permanently rather
 * than surfacing it. Same lesson, same shape, as `tests/store.test.ts`.
 */
const validContact = (overrides: Record<string, unknown> = {}) => ({
  uid: "testabc1230000000000",
  first_name: "John",
  name: "John",
  emails: [] as string[],
  phones: [] as string[],
  organizations: [] as Array<{ uid: string; name: string }>,
  query_by_organizations: [] as string[],
  uid_thread: "testthread0000000000",
  created_by: actor,
  updated_by: actor,
  ...ts,
  ...overrides,
});

Deno.test("ContactSchema validates a complete contact document", () => {
  const doc = validContact({
    last_name: "Doe",
    name: "John Doe",
    emails: ["john@example.com"],
    phones: ["1234567890"],
    organizations: [{ uid: "testorg1000000000000", name: "Acme" }],
    query_by_organizations: ["testorg1000000000000"],
  });
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema accepts contact without last_name", () => {
  const doc = validContact();
  assertEquals("last_name" in doc, false);
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema rejects missing required fields", () => {
  const doc = { uid: "testabc1230000000000" };
  assertEquals(ContactSchema.safeParse(doc).success, false);
});

Deno.test("ContactSchema requires uid_thread — every contact is born with a thread", () => {
  // 166/166 prod and 178/178 dev carry the key (2026-08-23, `orderBy`
  // key-presence). Dropping exactly one field from a valid document is what
  // makes this an assertion about `uid_thread` rather than about the fixture.
  const { uid_thread: _omitted, ...withoutThread } = validContact();
  assertEquals(ContactSchema.safeParse(withoutThread).success, false);
});

Deno.test("ContactSchema rejects empty first_name", () => {
  assertEquals(ContactSchema.safeParse(validContact({ first_name: "" })).success, false);
});

Deno.test("ContactSchema rejects additional properties", () => {
  assertEquals(ContactSchema.safeParse(validContact({ bogus: true })).success, false);
});

Deno.test("ContactSchema allows optional crms_id", () => {
  // ⚠️ Still optional, and deliberately: prod is 166/166 but DEV is 166 of 178
  // — its 12 dev-native contacts carry no CRMS id at all. That gap is the whole
  // reason this field was left out of the Wave 5b tightening while `uid_thread`
  // beside it went in.
  assertEquals(ContactSchema.safeParse(validContact({ crms_id: 42 })).success, true);
  assertEquals(ContactSchema.safeParse(validContact()).success, true);
});

Deno.test("ContactSchema accepts middle_name and pronunciation", () => {
  const doc = validContact({
    middle_name: "Quincy",
    last_name: "Doe",
    pronunciation: "JON QUIN-see DOH",
    name: "John Quincy Doe (JON QUIN-see DOH)",
  });
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema rejects empty middle_name", () => {
  assertEquals(ContactSchema.safeParse(validContact({ middle_name: "" })).success, false);
});

Deno.test("ContactSchema rejects pronunciation longer than 100 chars", () => {
  assertEquals(ContactSchema.safeParse(validContact({ pronunciation: "x".repeat(101) })).success, false);
});

Deno.test("CreateContactInput accepts minimal input", () => {
  const input = { uid: "testabc1230000000000", first_name: "John" };
  assertEquals(CreateContactInput.safeParse(input).success, true);
});

Deno.test("CreateContactInput accepts full input", () => {
  const input = {
    uid: "testabc1230000000000",
    first_name: "John",
    last_name: "Doe",
    emails: ["john@example.com"],
    phones: ["1234567890"],
    organizations: [{ uid: "testorg1000000000000", name: "Acme" }],
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

Deno.test("CreateContactInput accepts middle_name and pronunciation", () => {
  const input = {
    uid: "testabc1230000000000",
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
