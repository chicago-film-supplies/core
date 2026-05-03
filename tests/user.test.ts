import { assertEquals } from "@std/assert";
import { CreateUserInput, UpdateUserInput, UserSchema } from "../src/user.ts";

const base = {
  uid: "test-user-1",
  email: "test@example.com",
  first_name: "Alex",
  name: "Alex",
  password_hash: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
  email_verified: false,
  prefs_firestore: {},
  prefs_typesense: {},
};

Deno.test("UserSchema validates a complete user document", () => {
  const result = UserSchema.safeParse({
    ...base,
    last_name: "Hughes",
    uid_contact: "test-contact-1",
    created_at: { _seconds: 1700000000, _nanoseconds: 0 },
    updated_at: { _seconds: 1700000000, _nanoseconds: 0 },
  });
  assertEquals(result.success, true);
});

Deno.test("UserSchema accepts user without last_name", () => {
  const result = UserSchema.safeParse(base);
  assertEquals(result.success, true);
});

Deno.test("UserSchema rejects missing required fields", () => {
  const result = UserSchema.safeParse({ uid: "test-user-1" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema rejects missing first_name", () => {
  const { first_name: _, ...rest } = base;
  const result = UserSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("UserSchema rejects invalid email", () => {
  const result = UserSchema.safeParse({ ...base, email: "not-an-email" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema rejects empty password_hash", () => {
  const result = UserSchema.safeParse({ ...base, password_hash: "" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema defaults email_verified to false", () => {
  const { email_verified: _, ...rest } = base;
  const result = UserSchema.safeParse(rest);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.email_verified, false);
  }
});

Deno.test("UserSchema rejects additional properties", () => {
  const result = UserSchema.safeParse({ ...base, extraField: "not allowed" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema rejects old preference field names", () => {
  for (const old of ["tablePreferences", "columnPreferences", "filterPreferences"]) {
    const result = UserSchema.safeParse({ ...base, [old]: {} });
    assertEquals(result.success, false, `should reject "${old}"`);
  }
});

Deno.test("UserSchema rejects old uid_customer field", () => {
  const result = UserSchema.safeParse({ ...base, uid_customer: "test-contact-1" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema accepts prefs_firestore", () => {
  const result = UserSchema.safeParse({
    ...base,
    prefs_firestore: {
      orders: {
        columns: ["number", "status"],
        filters: { status: ["active"] },
        sort: { column: "number", direction: "desc" },
      },
    },
  });
  assertEquals(result.success, true);
});

Deno.test("UserSchema accepts prefs_typesense", () => {
  const result = UserSchema.safeParse({
    ...base,
    prefs_typesense: {
      bookings: {
        columns: ["number", "name"],
        filters: { status: [] },
        sort: { column: "number", direction: "desc" },
        group: null,
        facet: [],
      },
    },
  });
  assertEquals(result.success, true);
});

Deno.test("CreateUserInput accepts a full valid payload", () => {
  const result = CreateUserInput.safeParse({
    email: "new@example.com",
    first_name: "New",
    last_name: "User",
    password: "supersecret",
    roles: ["admin"],
    uid_contact: "test-contact-1",
  });
  assertEquals(result.success, true);
});

Deno.test("CreateUserInput accepts minimal payload", () => {
  const result = CreateUserInput.safeParse({
    email: "new@example.com",
    first_name: "New",
    password: "supersecret",
  });
  assertEquals(result.success, true);
});

Deno.test("CreateUserInput rejects short password", () => {
  const result = CreateUserInput.safeParse({
    email: "new@example.com",
    first_name: "New",
    password: "short",
  });
  assertEquals(result.success, false);
});

Deno.test("UpdateUserInput validates prefs-only payload", () => {
  const valid = UpdateUserInput.safeParse({
    version: 0,
    prefs_firestore: {
      orders: {
        columns: ["number"],
        filters: {},
        sort: { column: "number", direction: "asc" },
      },
    },
  });
  assertEquals(valid.success, true);
});

Deno.test("UpdateUserInput accepts name fields", () => {
  const valid = UpdateUserInput.safeParse({
    version: 0,
    first_name: "Jane",
    last_name: "Doe",
  });
  assertEquals(valid.success, true);
});

Deno.test("UpdateUserInput requires version", () => {
  const result = UpdateUserInput.safeParse({
    prefs_typesense: {
      bookings: {
        columns: ["number"],
        filters: {},
        sort: { column: "number", direction: "desc" },
        group: null,
        facet: [],
      },
    },
  });
  assertEquals(result.success, false);
});

Deno.test("UpdateUserInput strips unknown fields", () => {
  const result = UpdateUserInput.safeParse({
    version: 1,
    password_hash: "should-be-stripped",
    roles: ["admin"],
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals("password_hash" in result.data, false);
    assertEquals("roles" in result.data, false);
  }
});

Deno.test("UserSchema defaults version to 0", () => {
  const result = UserSchema.safeParse(base);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.version, 0);
  }
});

Deno.test("UserSchema accepts middle_name and pronunciation", () => {
  const result = UserSchema.safeParse({
    ...base,
    middle_name: "Quincy",
    last_name: "Hughes",
    pronunciation: "AL-iks HYOOZ",
  });
  assertEquals(result.success, true);
});

Deno.test("UserSchema rejects empty middle_name", () => {
  const result = UserSchema.safeParse({ ...base, middle_name: "" });
  assertEquals(result.success, false);
});

Deno.test("UserSchema rejects pronunciation longer than 100 chars", () => {
  const result = UserSchema.safeParse({ ...base, pronunciation: "x".repeat(101) });
  assertEquals(result.success, false);
});

Deno.test("CreateUserInput accepts middle_name and pronunciation", () => {
  const result = CreateUserInput.safeParse({
    email: "test@example.com",
    first_name: "Alex",
    middle_name: "Quincy",
    last_name: "Hughes",
    pronunciation: "AL-iks",
    password: "supersecret",
  });
  assertEquals(result.success, true);
});

Deno.test("UpdateUserInput accepts middle_name only", () => {
  const result = UpdateUserInput.safeParse({ middle_name: "Quincy", version: 3 });
  assertEquals(result.success, true);
});

Deno.test("UpdateUserInput accepts pronunciation only", () => {
  const result = UpdateUserInput.safeParse({ pronunciation: "AL-iks", version: 3 });
  assertEquals(result.success, true);
});
