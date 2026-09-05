import { assertEquals } from "@std/assert";
import {
  AcceptInviteInput,
  CreateInviteInput,
  InviteSchema,
} from "../src/schemas/invite.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * A MINIMAL VALID invite document, so every negative case below fails for
 * exactly the reason it names.
 *
 * ⚠️ **The two negative tests here were passing for the wrong reason.** Both
 * spelled their fields inline and both omitted `name`, `created_at` and
 * `updated_at` — required long before this — so "rejects additional
 * properties" was really asserting "rejects SOMETHING", and the strictness it
 * names could have been deleted with the test still green. core#84 requiring
 * the three name parts would have hidden that permanently rather than
 * surfacing it. Same lesson, same shape, as `tests/contact.test.ts`.
 */
const validInvite = (overrides: Record<string, unknown> = {}) => ({
  uid: "token-hex-abc",
  email: "invited@example.com",
  first_name: "Invited",
  // Present-and-null, never absent — required and nullable as of core#84.
  middle_name: null,
  last_name: null,
  pronunciation: null,
  name: "Invited",
  roles: ["admin"],
  invited_by: "user1000000000000000",
  used: false,
  expires_at: mockTimestamp,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
  ...overrides,
});

Deno.test("InviteSchema validates a complete invite", () => {
  const doc = validInvite({ last_name: "User", name: "Invited User" });
  assertEquals(InviteSchema.safeParse(doc).success, true);
});

Deno.test("InviteSchema requires last_name PRESENT — `null` is how an invite has none", () => {
  // core#84: present-and-null, never absent, because absence is the state that
  // yields `undefined` and breaks writers. Both halves, so this asserts the
  // rule rather than "parses for some reason".
  assertEquals(InviteSchema.safeParse(validInvite()).success, true);
  const { last_name: _omitted, ...withoutLast } = validInvite();
  assertEquals(InviteSchema.safeParse(withoutLast).success, false);
});

Deno.test("InviteSchema defaults used to false", () => {
  const { used: _omitted, ...withoutUsed } = validInvite();
  const result = InviteSchema.safeParse(withoutUsed);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.used, false);
  }
});

Deno.test("InviteSchema rejects additional properties", () => {
  // Exactly one field added to an otherwise valid document.
  assertEquals(InviteSchema.safeParse(validInvite({ bogus: 1 })).success, false);
});

Deno.test("CreateInviteInput requires at least one role", () => {
  const result = CreateInviteInput.safeParse({
    email: "a@b.com",
    first_name: "A",
    roles: [],
  });
  assertEquals(result.success, false);
});

Deno.test("CreateInviteInput accepts valid payload", () => {
  const result = CreateInviteInput.safeParse({
    email: "a@b.com",
    first_name: "A",
    last_name: "B",
    roles: ["admin"],
  });
  assertEquals(result.success, true);
});

Deno.test("CreateInviteInput still accepts an OMITTED name part", () => {
  // The input half of the core#84 split: storage requires the key, a create
  // client may omit it, and the writer normalizes `?? null` in between.
  // Requiring it here would 400 every client with no middle name.
  const result = CreateInviteInput.safeParse({
    email: "a@b.com",
    first_name: "A",
    roles: ["admin"],
  });
  assertEquals(result.success, true);
  const withNull = CreateInviteInput.safeParse({
    email: "a@b.com",
    first_name: "A",
    middle_name: null,
    roles: ["admin"],
  });
  assertEquals(withNull.success, true);
});

Deno.test("AcceptInviteInput rejects short password", () => {
  const result = AcceptInviteInput.safeParse({
    token: "abc",
    password: "short",
  });
  assertEquals(result.success, false);
});

Deno.test("AcceptInviteInput accepts valid payload", () => {
  const result = AcceptInviteInput.safeParse({
    token: "abc123",
    password: "supersecret",
  });
  assertEquals(result.success, true);
});

Deno.test("InviteSchema accepts middle_name and pronunciation", () => {
  const doc = validInvite({
    middle_name: "Quincy",
    last_name: "User",
    pronunciation: "in-VITE-ed",
    name: "Invited Quincy User (in-VITE-ed)",
  });
  assertEquals(InviteSchema.safeParse(doc).success, true);
});

Deno.test("CreateInviteInput accepts middle_name and pronunciation", () => {
  const result = CreateInviteInput.safeParse({
    email: "a@b.com",
    first_name: "A",
    middle_name: "Q",
    last_name: "B",
    pronunciation: "AY",
    roles: ["admin"],
  });
  assertEquals(result.success, true);
});
