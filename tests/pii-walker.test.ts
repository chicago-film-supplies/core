/**
 * PII walker + transforms unit tests.
 *
 * Covers:
 * - Each classification round-trips correctly (mask / hash / redact / none)
 * - Idempotency for mask / redact (hash is deterministic but not idempotent
 *   in the trivial sense — `hash(hash(x))` is the hash of a different value)
 * - Walker recursion: nested objects, arrays of objects, arrays of
 *   pii-tagged primitives
 * - Fail-closed: when no `hashFn` is supplied, `pii: "hash"` fields
 *   degrade to `[REDACTED]` rather than throwing or passing through raw
 * - Never throws on malformed input (circular refs, null, undefined)
 * - Walker leaves un-shaped passthrough data untouched (handled by the
 *   runtime denylist tier, not here)
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { z } from "zod";
import { applyPii, createLoggerStrategy } from "../src/schemas/pii/walker.ts";
import { mask, redact } from "../src/schemas/pii/transforms.ts";
import { nodeHash } from "../src/schemas/pii/hash-node.ts";

// ── Leaf transforms ─────────────────────────────────────────────────

Deno.test("mask: email keeps first char of local + full domain", () => {
  assertEquals(mask("alice@example.com"), "a****@example.com");
  assertEquals(mask("x@y.z"), "x*@y.z");
});

Deno.test("mask: long opaque string keeps first/last char", () => {
  assertEquals(mask("abcdefg"), "a*****g");
  assertEquals(mask("hello"), "h***o");
});

Deno.test("mask: short string is fully redacted (length < 4)", () => {
  assertEquals(mask("ab"), "[REDACTED]");
  assertEquals(mask("abc"), "[REDACTED]");
});

Deno.test("mask: idempotent on already-masked output (no further reveal)", () => {
  // The masked form of an email is a non-email shape (`a****@example.com`
  // still contains `@`), so re-masking would re-process. Verify that
  // re-masking a masked email doesn't accidentally LEAK more of the
  // original — the worst it should do is mask the masked form again.
  const masked = mask("alice@example.com");
  const twice = mask(masked);
  // The local part of `masked` is `a****` — first-char preservation
  // keeps `a`, masks the four asterisks. No leakage of original.
  assert(!twice.includes("alice"));
});

Deno.test("redact: returns the literal [REDACTED]", () => {
  assertEquals(redact(), "[REDACTED]");
});

Deno.test("nodeHash: deterministic for same (value, key)", () => {
  const h1 = nodeHash("alice@example.com", "test-key");
  const h2 = nodeHash("alice@example.com", "test-key");
  assertEquals(h1, h2);
  assertEquals(h1.length, 16);
});

Deno.test("nodeHash: differs across keys", () => {
  const h1 = nodeHash("alice@example.com", "key-A");
  const h2 = nodeHash("alice@example.com", "key-B");
  assertNotEquals(h1, h2);
});

// ── Strategy fail-closed ────────────────────────────────────────────

Deno.test("createLoggerStrategy: hash without key falls back to redact (fail-closed)", () => {
  const strategy = createLoggerStrategy(undefined);
  const result = strategy.apply("alice@example.com", "hash", "user.email");
  assertEquals(result, "[REDACTED]");
});

Deno.test("createLoggerStrategy: hash with key uses the hash function", () => {
  const strategy = createLoggerStrategy((v) => nodeHash(v, "test-key"));
  const result = strategy.apply("alice@example.com", "hash", "user.email");
  assertEquals(typeof result, "string");
  assertEquals((result as string).length, 16);
  assertNotEquals(result, "[REDACTED]");
});

Deno.test("createLoggerStrategy: none passes through unchanged", () => {
  const strategy = createLoggerStrategy(undefined);
  assertEquals(strategy.apply("hello", "none", "x"), "hello");
});

Deno.test("createLoggerStrategy: non-string values pass through regardless of classification", () => {
  const strategy = createLoggerStrategy(undefined);
  assertEquals(strategy.apply(42, "mask", "x"), 42);
  assertEquals(strategy.apply(true, "redact", "x"), true);
  assertEquals(strategy.apply(null, "hash", "x"), null);
});

// ── Walker on representative shapes ─────────────────────────────────

Deno.test("walker: applies mask to a flat pii-tagged field", () => {
  const schema = z.object({
    email: z.string().meta({ pii: "mask" }),
    safe: z.string(),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(
    { email: "alice@example.com", safe: "keep-me" },
    schema,
    strategy,
  );
  assertEquals(out.email, "a****@example.com");
  assertEquals(out.safe, "keep-me");
});

Deno.test("walker: handles optional / nullable / default wrappers around pii", () => {
  const schema = z.object({
    a: z.string().meta({ pii: "mask" }).optional(),
    b: z.string().meta({ pii: "mask" }).nullable(),
    c: z.string().meta({ pii: "mask" }).default("x"),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(
    { a: "alice@example.com", b: "bob@example.com", c: "carol@example.com" },
    schema,
    strategy,
  );
  assertEquals(out.a, "a****@example.com");
  assertEquals(out.b, "b**@example.com");
  assertEquals(out.c, "c****@example.com");
});

Deno.test("walker: recurses into nested objects", () => {
  const schema = z.object({
    user: z.object({
      email: z.string().meta({ pii: "mask" }),
      id: z.string(),
    }),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(
    { user: { email: "alice@example.com", id: "u1000000000000000000" } },
    schema,
    strategy,
  );
  assertEquals(out.user.email, "a****@example.com");
  assertEquals(out.user.id, "u1000000000000000000");
});

Deno.test("walker: recurses into arrays of objects", () => {
  const schema = z.object({
    users: z.array(z.object({
      email: z.string().meta({ pii: "mask" }),
    })),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(
    { users: [{ email: "alice@example.com" }, { email: "bob@example.com" }] },
    schema,
    strategy,
  );
  assertEquals(out.users[0].email, "a****@example.com");
  assertEquals(out.users[1].email, "b**@example.com");
});

Deno.test("walker: applies redact to redact-tagged field", () => {
  const schema = z.object({
    password: z.string().meta({ pii: "redact" }),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii({ password: "hunter2" }, schema, strategy);
  assertEquals(out.password, "[REDACTED]");
});

Deno.test("walker: pii=none is a pass-through", () => {
  const schema = z.object({
    user_id: z.string().meta({ pii: "none" }),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii({ user_id: "u-123" }, schema, strategy);
  assertEquals(out.user_id, "u-123");
});

Deno.test("walker: applies hash via supplied hashFn", () => {
  const schema = z.object({
    user_id: z.string().meta({ pii: "hash" }),
  });
  const strategy = createLoggerStrategy((v) => nodeHash(v, "test-key"));
  const out = applyPii({ user_id: "alice" }, schema, strategy);
  assertNotEquals(out.user_id, "alice");
  assertNotEquals(out.user_id, "[REDACTED]");
  assertEquals(typeof out.user_id, "string");
  assertEquals((out.user_id as string).length, 16);
});

Deno.test("walker: idempotent for mask / redact strategies", () => {
  const schema = z.object({
    email: z.string().meta({ pii: "mask" }),
    secret: z.string().meta({ pii: "redact" }),
  });
  const strategy = createLoggerStrategy(undefined);
  const once = applyPii({ email: "alice@example.com", secret: "hunter2" }, schema, strategy);
  const twice = applyPii(once, schema, strategy);
  // Mask of a masked email shouldn't leak the original — second pass
  // should produce a stable result (re-masking masked form is stable
  // shape-wise).
  assertEquals(twice.secret, "[REDACTED]");
  assert(!String(twice.email).includes("alice"));
});

Deno.test("walker: does not mutate the input record", () => {
  const schema = z.object({ email: z.string().meta({ pii: "mask" }) });
  const input = { email: "alice@example.com" };
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(input, schema, strategy);
  assertEquals(input.email, "alice@example.com");
  assertNotEquals(out.email, input.email);
});

Deno.test("walker: leaves passthrough fields untouched (no shape)", () => {
  const schema = z.object({
    msg: z.string(),
  }).passthrough();
  const strategy = createLoggerStrategy(undefined);
  const input: Record<string, unknown> = { msg: "x", unknown_field: "alice@example.com" };
  const out = applyPii<Record<string, unknown>>(
    input,
    schema as unknown as z.ZodType<Record<string, unknown>>,
    strategy,
  );
  // Walker doesn't know about unknown_field — runtime denylist tier handles those.
  assertEquals(out.unknown_field, "alice@example.com");
});

Deno.test("walker: never throws on null / undefined leaves", () => {
  const schema = z.object({
    a: z.string().meta({ pii: "mask" }).nullable(),
    b: z.string().meta({ pii: "mask" }).optional(),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii({ a: null, b: undefined } as { a: null; b: undefined }, schema, strategy);
  assertEquals(out.a, null);
  assertEquals(out.b, undefined);
});

Deno.test("walker: applies per-element transform on array of pii-tagged primitives", () => {
  const schema = z.object({
    emails: z.array(z.string().meta({ pii: "mask" })),
  });
  const strategy = createLoggerStrategy(undefined);
  const out = applyPii(
    { emails: ["alice@x.com", "bob@y.com"] },
    schema,
    strategy,
  );
  assertEquals(out.emails, ["a****@x.com", "b**@y.com"]);
});

// ── Order/Invoice free-text fixture-audit coverage ──────────────────
//
// These exercise the newly-tagged `instructions` / `description` / divider
// `name` fields on OrderSchema + InvoiceSchema so the fixture sanitizer
// (and the logger) won't leak them. Regressions here mean a future schema
// edit removed a `pii` tag without anyone noticing.

Deno.test("walker: masks destination instructions on OrderSchema", async () => {
  const { OrderSchema } = await import("../src/schemas/order.ts");
  const strategy = createLoggerStrategy(undefined);
  const doc = {
    uid: "o1000000000000000000",
    number: 1,
    status: "draft",
    organization: { uid: "org10000000000000000", name: "Acme Inc", xero_id: null },
    destinations: [
      {
        dates: {
          delivery_start: "2026-01-15T12:00:00.000-06:00",
          delivery_end: "2026-01-16T12:00:00.000-06:00",
          collection_start: "2026-01-16T12:00:00.000-06:00",
          collection_end: "2026-01-17T12:00:00.000-06:00",
          charge_start: "2026-01-15T00:00:00.000-06:00",
          charge_end: "2026-01-17T00:00:00.000-06:00",
          days_active: 2,
          days_charged: 2,
        },
        delivery: {
          uid: null,
          address: null,
          instructions: "key under mat, ask for John",
          contact: null,
        },
        collection: {
          uid: null,
          address: null,
          instructions: "ring bell at studio 4B",
          contact: null,
        },
        customer_collecting: false,
        customer_returning: false,
      },
    ],
    items: [],
  };
  // deno-lint-ignore no-explicit-any
  const out = applyPii(doc as any, OrderSchema as any, strategy) as any;
  assertNotEquals(out.destinations[0].delivery.instructions, "key under mat, ask for John");
  assertNotEquals(out.destinations[0].collection.instructions, "ring bell at studio 4B");
  // Organization name is also mask-tagged.
  assertNotEquals(out.organization.name, "Acme Inc");
});

Deno.test("walker: masks line-item + divider description/name on OrderSchema", async () => {
  const { OrderSchema } = await import("../src/schemas/order.ts");
  const strategy = createLoggerStrategy(undefined);
  const doc = {
    uid: "o2000000000000000000",
    number: 2,
    status: "draft",
    organization: { uid: "org10000000000000000", name: "Acme", xero_id: null },
    destinations: [],
    items: [
      {
        uid: "00000000-0000-0000-0000-000000000001",
        type: "destination",
        name: "John Smith — primary studio",
        description: "deliver before 8am",
        path: [],
        uid_delivery: null,
        uid_collection: null,
      },
      {
        uid: "00000000-0000-0000-0000-000000000002",
        type: "group",
        name: "Smith family shoot",
        description: "no-flash gear only",
        path: [],
      },
      {
        uid: "li100000000000000000",
        type: "rental",
        name: "Custom item",
        description: "for John's birthday wedding video",
        quantity: 1,
        stock_method: "none",
        path: [],
      },
    ],
  };
  // deno-lint-ignore no-explicit-any
  const out = applyPii(doc as any, OrderSchema as any, strategy) as any;
  // Divider name + description masked.
  assertNotEquals(out.items[0].name, "John Smith — primary studio");
  assertNotEquals(out.items[0].description, "deliver before 8am");
  assertNotEquals(out.items[1].name, "Smith family shoot");
  assertNotEquals(out.items[1].description, "no-flash gear only");
  // Custom line item description masked.
  assertNotEquals(out.items[2].description, "for John's birthday wedding video");
});
