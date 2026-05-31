import { assertEquals } from "@std/assert";
import { PasswordResetSchema } from "../src/password-reset.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("PasswordResetSchema validates a complete token document", () => {
  const result = PasswordResetSchema.safeParse({
    user_id: "testuser100000000000",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, true);
});

Deno.test("PasswordResetSchema rejects missing user_id", () => {
  const result = PasswordResetSchema.safeParse({
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("PasswordResetSchema rejects empty user_id", () => {
  const result = PasswordResetSchema.safeParse({
    user_id: "",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("PasswordResetSchema rejects invalid email", () => {
  const result = PasswordResetSchema.safeParse({
    user_id: "testuser100000000000",
    email: "not-an-email",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("PasswordResetSchema rejects additional properties", () => {
  const result = PasswordResetSchema.safeParse({
    user_id: "testuser100000000000",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    extra: "not allowed",
  });
  assertEquals(result.success, false);
});
