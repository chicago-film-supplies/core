import { assert, assertEquals } from "@std/assert";
import {
  ContactSchema,
  CreateContactInput,
  UpdateContactInput,
} from "../src/schemas/contact.ts";
import { AcceptInviteInput } from "../src/schemas/invite.ts";
import { UpdateUserInput } from "../src/schemas/user.ts";
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
  // Present-and-null, never absent — the three parts are required and nullable
  // as of core#84. `null` is how a contact has no middle name.
  middle_name: null,
  last_name: null,
  pronunciation: null,
  name: "John",
  emails: [] as string[],
  phones: [] as string[],
  organizations: [] as Array<{ uid: string }>,
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
    organizations: [{ uid: "testorg1000000000000" }],
    query_by_organizations: ["testorg1000000000000"],
  });
  assertEquals(ContactSchema.safeParse(doc).success, true);
});

Deno.test("ContactSchema requires last_name PRESENT — `null` is how a contact has none", () => {
  // core#84 contracted the three optional name parts to bare `.nullable()`:
  // present-and-null, never absent, because absence is the state that yields
  // `undefined` and breaks writers. Both halves are asserted — a null parses,
  // and dropping exactly one key from an otherwise valid document does not.
  assertEquals(ContactSchema.safeParse(validContact()).success, true);
  const { last_name: _omitted, ...withoutLast } = validContact();
  assertEquals(ContactSchema.safeParse(withoutLast).success, false);
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
    organizations: [{ uid: "testorg1000000000000" }],
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

Deno.test("UpdateContactInput: null is the clear verb on the three optional parts", async (t) => {
  // manager#338 — `ContactName`'s ✕ wrote `""`, which fails `min(1)`, so the
  // store aborted before any request, the input collapsed and the old value
  // came back on the next snapshot. The repair is a null arm on exactly the
  // three parts that can legitimately have no value, NOT a looser string: `""`
  // has to stay rejected on all four, or the same silent-abort path reopens for
  // an operator who types and deletes a character.
  //
  // 🔴 `first_name` gets no null arm. It is required and `min(1)` on every
  // stored surface, so a `null` here would type-check its way to a write that
  // cannot validate.
  const base = { version: 1 };
  const cases: Array<[string, string, unknown, boolean]> = [
    ["middle_name: null clears", "middle_name", null, true],
    ["last_name: null clears", "last_name", null, true],
    ["pronunciation: null clears", "pronunciation", null, true],
    ["first_name: null is REJECTED", "first_name", null, false],
    ["middle_name: \"\" is rejected", "middle_name", "", false],
    ["last_name: \"\" is rejected", "last_name", "", false],
    ["pronunciation: \"\" is rejected", "pronunciation", "", false],
    ["first_name: \"\" is rejected", "first_name", "", false],
    ["middle_name: a value is accepted", "middle_name", "Quincy", true],
    ["first_name: a value is accepted", "first_name", "Jane", true],
  ];
  for (const [label, field, value, expected] of cases) {
    await t.step(label, () => {
      assertEquals(UpdateContactInput.safeParse({ ...base, [field]: value }).success, expected);
    });
  }

  // Omitting every part is still a legal patch — that is what makes this an
  // input rather than the stored contract.
  await t.step("all four omitted is accepted", () => {
    assertEquals(UpdateContactInput.safeParse(base).success, true);
  });

  // The clear arm has to survive the parse as a value distinguishable from
  // absence: `null` means CLEAR IT and absence means LEAVE IT, and a parse that
  // collapsed one into the other would make the verb unreadable to the writer.
  await t.step("null and absent stay distinguishable after parsing", () => {
    const cleared = UpdateContactInput.safeParse({ ...base, middle_name: null });
    assert(cleared.success);
    assertEquals(cleared.data.middle_name, null);
    assertEquals("middle_name" in cleared.data, true);
    const untouched = UpdateContactInput.safeParse(base);
    assert(untouched.success);
    assertEquals(untouched.data.middle_name, undefined);
    assertEquals("middle_name" in untouched.data, false);
  });
});

Deno.test("UpdateUserInput and AcceptInviteInput are deliberately NOT on the clear verb", async (t) => {
  // The reason `NamePartsFieldsPatch` is a fourth block rather than a widening
  // of `NamePartsFieldsPartial` (core#70). `AcceptInviteInput` spreads the
  // partial block, and `api-cloudrun/src/routes/invites.ts` merges the accept
  // body with `body.middle_name ?? invite.middle_name` — so `null ?? x` yields
  // `x` and an invitee clearing a middle name would silently inherit the
  // INVITER's. It type-checks; only this assertion stops the widening.
  //
  // ⚠️ Assert the REFUSAL, not merely that the two schemas differ. If a later
  // change hands them the arm, the failure has to name the reader that would
  // then be wrong.
  await t.step("UpdateUserInput rejects a null middle_name", () => {
    assertEquals(UpdateUserInput.safeParse({ middle_name: null, version: 1 }).success, false);
  });
  await t.step("AcceptInviteInput rejects a null middle_name", () => {
    const body = { token: "t".repeat(43), password: "hunter2hunter2", middle_name: null };
    assertEquals(AcceptInviteInput.safeParse(body).success, false);
  });
  // Non-vacuity: both DO accept the same field with a value, so the assertions
  // above are about `null` and not about an unrelated rejection.
  await t.step("both accept a middle_name with a value", () => {
    assertEquals(UpdateUserInput.safeParse({ middle_name: "Quincy", version: 1 }).success, true);
    const body = { token: "t".repeat(43), password: "hunter2hunter2", middle_name: "Quincy" };
    assertEquals(AcceptInviteInput.safeParse(body).success, true);
  });
});
