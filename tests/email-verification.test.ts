import { assertEquals } from "@std/assert";
import { EmailVerificationSchema } from "../src/email-verification.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("EmailVerificationSchema validates a complete token document", () => {
  const result = EmailVerificationSchema.safeParse({
    user_id: "testuser100000000000",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, true);
});

Deno.test("EmailVerificationSchema rejects missing user_id", () => {
  const result = EmailVerificationSchema.safeParse({
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("EmailVerificationSchema rejects empty user_id", () => {
  const result = EmailVerificationSchema.safeParse({
    user_id: "",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("EmailVerificationSchema rejects invalid email", () => {
  const result = EmailVerificationSchema.safeParse({
    user_id: "testuser100000000000",
    email: "not-an-email",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
  });
  assertEquals(result.success, false);
});

Deno.test("EmailVerificationSchema rejects additional properties", () => {
  const result = EmailVerificationSchema.safeParse({
    user_id: "testuser100000000000",
    email: "test@example.com",
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    extra: "not allowed",
  });
  assertEquals(result.success, false);
});
