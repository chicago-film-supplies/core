import { assertEquals } from "@std/assert";
import { SessionSchema } from "../src/schemas/session.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

Deno.test("SessionSchema validates a complete session document", () => {
  const result = SessionSchema.safeParse({
    uid: "a".repeat(40),
    user_id: "testuser100000000000",
    anonymous: false,
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    user_agent: "Mozilla/5.0",
  });
  assertEquals(result.success, true);
});

Deno.test("SessionSchema validates an anonymous session", () => {
  const result = SessionSchema.safeParse({
    uid: "b".repeat(40),
    user_id: "",
    anonymous: true,
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    user_agent: "",
  });
  assertEquals(result.success, true);
});

Deno.test("SessionSchema rejects session ID with wrong length", () => {
  const result = SessionSchema.safeParse({
    uid: "tooshort",
    user_id: "testuser100000000000",
    anonymous: false,
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    user_agent: "Mozilla/5.0",
  });
  assertEquals(result.success, false);
});

Deno.test("SessionSchema rejects missing required fields", () => {
  const result = SessionSchema.safeParse({ uid: "a".repeat(40) });
  assertEquals(result.success, false);
});

Deno.test("SessionSchema rejects additional properties", () => {
  const result = SessionSchema.safeParse({
    uid: "a".repeat(40),
    user_id: "testuser100000000000",
    anonymous: false,
    expiresAt: mockTimestamp,
    created_at: 1700000000000,
    user_agent: "Mozilla/5.0",
    extraField: "not allowed",
  });
  assertEquals(result.success, false);
});

Deno.test("SessionSchema rejects non-number created_at", () => {
  const result = SessionSchema.safeParse({
    uid: "a".repeat(40),
    user_id: "testuser100000000000",
    anonymous: false,
    expiresAt: mockTimestamp,
    created_at: "not a number",
    user_agent: "Mozilla/5.0",
  });
  assertEquals(result.success, false);
});
