import { assertEquals } from "@std/assert";
import {
  AcceptInviteInput,
  CreateInviteInput,
  InviteSchema,
} from "../src/invite.ts";

Deno.test("InviteSchema validates a complete invite", () => {
  const doc = {
    uid: "token-hex-abc",
    email: "invited@example.com",
    first_name: "Invited",
    last_name: "User",
    name: "Invited User",
    roles: ["admin"],
    invited_by: "user-1",
    used: false,
    expires_at: { _seconds: 1700000000, _nanoseconds: 0 },
  };
  assertEquals(InviteSchema.safeParse(doc).success, true);
});

Deno.test("InviteSchema defaults used to false", () => {
  const result = InviteSchema.safeParse({
    uid: "token-hex-abc",
    email: "invited@example.com",
    first_name: "Invited",
    name: "Invited",
    roles: ["admin"],
    invited_by: "user-1",
    expires_at: { _seconds: 1700000000, _nanoseconds: 0 },
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.used, false);
  }
});

Deno.test("InviteSchema rejects additional properties", () => {
  const result = InviteSchema.safeParse({
    uid: "token",
    email: "a@b.com",
    first_name: "A",
    roles: [],
    invited_by: "u",
    expires_at: { _seconds: 0, _nanoseconds: 0 },
    bogus: 1,
  });
  assertEquals(result.success, false);
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
  const result = InviteSchema.safeParse({
    uid: "token-hex-abc",
    email: "invited@example.com",
    first_name: "Invited",
    middle_name: "Quincy",
    last_name: "User",
    pronunciation: "in-VITE-ed",
    name: "Invited Quincy User (in-VITE-ed)",
    roles: ["admin"],
    invited_by: "user-1",
    expires_at: { _seconds: 1700000000, _nanoseconds: 0 },
  });
  assertEquals(result.success, true);
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
