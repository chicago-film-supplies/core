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

import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { z } from "zod";
import { applyPii, createLoggerStrategy, readPiiTag } from "../src/schemas/pii/walker.ts";
import { mask, redact } from "../src/schemas/pii/transforms.ts";
import { nodeHash } from "../src/schemas/pii/hash-node.ts";
import { collectLeafPaths } from "../src/schemas/zod-walk.ts";

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

Deno.test("createLoggerStrategy: non-string SCALARS under a tag fail closed", () => {
  const strategy = createLoggerStrategy(undefined);
  // These used to pass through raw, which is how a 6dp geocode reached the log.
  assertEquals(strategy.apply(42, "mask", "x"), "[REDACTED]");
  assertEquals(strategy.apply(true, "redact", "x"), "[REDACTED]");
  assertEquals(strategy.apply(41.8781, "mask", "coordinates.latitude"), "[REDACTED]");
  assertEquals(strategy.apply(10n, "hash", "x"), "[REDACTED]");
});

Deno.test("createLoggerStrategy: null and undefined still pass through", () => {
  const strategy = createLoggerStrategy(undefined);
  assertEquals(strategy.apply(null, "hash", "x"), null);
  assertEquals(strategy.apply(null, "mask", "x"), null);
  assertEquals(strategy.apply(undefined, "redact", "x"), undefined);
  // `none` short-circuits before any of it.
  assertEquals(strategy.apply(42, "none", "x"), 42);
});

Deno.test("createLoggerStrategy: containers pass through BY REFERENCE so the walker descends", () => {
  const strategy = createLoggerStrategy(undefined);
  const obj = { city: "Chicago" };
  const arr = [1, 2];
  // Reference identity is the contract `applyTagged` keys off: return the same
  // reference → keep descending; return anything else → replace wholesale. If
  // these were redacted, a masked `Address` would collapse to "[REDACTED]" and
  // its city/region/country_name `none` opt-outs would be destroyed.
  assertStrictEquals(strategy.apply(obj, "mask", "address"), obj);
  assertStrictEquals(strategy.apply(arr, "redact", "xs"), arr);
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
  // ...but the catalog product NAME is not PII and must survive verbatim — it is
  // what makes a fixture drawn from a real order worth drawing.
  assertEquals(out.items[2].name, "Custom item");
});

// ── Tag-shape coverage ──────────────────────────────────────────────
//
// `.meta()` registers on the instance it is called on, so the builder ORDER
// decides which node holds the tag. All four shapes below are legitimate and
// all appear in these schemas; all four must reach the strategy.
//
// The bug this guards: `Address` is `.strictObject({…}).nullable().meta({pii})`,
// so the tag sat on the ZodNullable. The walker unwrapped first and read only
// the final node, saw no tag, and passed every street/postcode/geocode straight
// through — while `pii.test.ts` (which walked the wrapper chain) stayed green.

/** Rewrites string leaves only — the logger's contract, made explicit. */
const stringOnly = {
  apply(value: unknown, classification: string) {
    if (typeof value !== "string") return value;
    return classification === "none" ? value : "XXX";
  },
};

Deno.test("tag shape: on a bare leaf — z.string().meta()", () => {
  const schema = z.strictObject({ a: z.string().meta({ pii: "mask" }) });
  assertEquals(applyPii({ a: "hi" }, schema, stringOnly), { a: "XXX" });
});

Deno.test("tag shape: BEFORE the wrapper — .meta().default()", () => {
  const schema = z.strictObject({ a: z.string().meta({ pii: "mask" }).default("") });
  assertEquals(applyPii({ a: "hi" }, schema, stringOnly), { a: "XXX" });
});

Deno.test("tag shape: AFTER the wrapper — .default().meta() (the ordering trap)", () => {
  const schema = z.strictObject({ a: z.string().default("").meta({ pii: "mask" }) });
  assertEquals(applyPii({ a: "hi" }, schema, stringOnly), { a: "XXX" });
});

Deno.test("tag shape: on an OBJECT — the tag must reach the leaves", () => {
  const schema = z.strictObject({
    addr: z.strictObject({ street: z.string(), postcode: z.string() }).meta({ pii: "mask" }),
  });
  assertEquals(
    applyPii({ addr: { street: "3100 W Fillmore St", postcode: "60612" } }, schema, stringOnly),
    { addr: { street: "XXX", postcode: "XXX" } },
  );
});

Deno.test("tag shape: on an object BEHIND a wrapper — .nullable().meta() (the Address shape)", () => {
  const schema = z.strictObject({
    addr: z.strictObject({ street: z.string() }).nullable().meta({ pii: "mask" }),
  });
  assertEquals(
    applyPii({ addr: { street: "3100 W Fillmore St" } }, schema, stringOnly),
    { addr: { street: "XXX" } },
  );
});

Deno.test("walker: a child's own tag overrides the inherited classification", () => {
  const schema = z.strictObject({
    addr: z.strictObject({
      street: z.string(),
      city: z.string().meta({ pii: "none" }),
    }).nullable().meta({ pii: "mask" }),
  });
  assertEquals(
    applyPii({ addr: { street: "3100 W Fillmore St", city: "Chicago" } }, schema, stringOnly),
    { addr: { street: "XXX", city: "Chicago" } },
  );
});

Deno.test("walker: a strategy may replace a whole container and stop the descent", () => {
  const schema = z.strictObject({
    addr: z.strictObject({
      street: z.string(),
      coords: z.strictObject({ latitude: z.number(), longitude: z.number() }).nullable(),
    }).nullable().meta({ pii: "mask" }),
  });
  // Mirrors the fixture sanitizer: null a {latitude,longitude} pair wholesale.
  // Nulling `latitude` on its own would fail `z.number()` on the way back in,
  // so a leaf-only transform cannot express this.
  const nullCoords = {
    apply(value: unknown, classification: string) {
      if (value !== null && typeof value === "object" && "latitude" in value) return null;
      if (typeof value !== "string") return value;
      return classification === "none" ? value : "XXX";
    },
  };
  assertEquals(
    applyPii(
      { addr: { street: "3100 W Fillmore St", coords: { latitude: 41.8708, longitude: -87.7036 } } },
      schema,
      nullCoords,
    ),
    { addr: { street: "XXX", coords: null } },
  );
});

// ── Reachability gate on the real OrderSchema ───────────────────────
//
// The tests above this section all set `address: null`, which is exactly why the
// suite was green while `applyPii` leaked every address into git. Populate it.

/** Records every (path, classification) the walker offers, passing values through. */
function probeStrategy(): { seen: string[]; strategy: { apply: (v: unknown, c: string, p: string) => unknown } } {
  const seen: string[] = [];
  return {
    seen,
    strategy: {
      apply(value: unknown, classification: string, fieldPath: string) {
        seen.push(`${fieldPath}:${classification}`);
        return value;
      },
    },
  };
}

const SAMPLE_ADDRESS = {
  city: "Chicago",
  country_name: "United States",
  full: "3100 W Fillmore St, Chicago, IL, 60612, United States",
  name: "Chicago Film Supplies",
  postcode: "60612",
  region: "IL",
  street: "3100 W Fillmore St",
  street2: "",
  mapbox_id: "dXJuOm1ieGFkcjo0Mg",
  address_coordinates: { latitude: 41.8708, longitude: -87.7036 },
  user_coordinates: { latitude: 41.8708, longitude: -87.7036 },
};

function orderWithAddresses(): Record<string, unknown> {
  return {
    uid: "o3000000000000000000",
    number: 3,
    status: "draft",
    organization: {
      uid: "org10000000000000000",
      name: "Lakeshore Pictures",
      xero_id: null,
      billing_address: { ...SAMPLE_ADDRESS },
    },
    destinations: [{
      delivery: { uid: null, address: { ...SAMPLE_ADDRESS }, instructions: null, contact: null },
      collection: { uid: null, address: { ...SAMPLE_ADDRESS }, instructions: null, contact: null },
    }],
    items: [],
  };
}

Deno.test("gate: every scalar under a masked Address is OFFERED to the strategy", async () => {
  const { OrderSchema } = await import("../src/schemas/order.ts");
  const { seen, strategy } = probeStrategy();
  // deno-lint-ignore no-explicit-any
  applyPii(orderWithAddresses() as any, OrderSchema as any, strategy);

  // The exact set that leaked. A tag the walker never offers is a tag that does
  // nothing — which is not something a presence check can see.
  const required = [
    "organization.billing_address.street:mask",
    "organization.billing_address.full:mask",
    "organization.billing_address.name:mask",
    "organization.billing_address.postcode:mask",
    "organization.billing_address.mapbox_id:mask",
    "organization.billing_address.address_coordinates.latitude:mask",
    "organization.billing_address.address_coordinates.longitude:mask",
    "organization.billing_address.user_coordinates.latitude:mask",
    "destinations.delivery.address.street:mask",
    "destinations.delivery.address.full:mask",
    "destinations.delivery.address.address_coordinates.latitude:mask",
    "destinations.collection.address.street:mask",
  ];
  for (const path of required) {
    assert(
      seen.includes(path),
      `walker never offered "${path}" to the strategy — its pii tag is a no-op`,
    );
  }
});

Deno.test("gate: a pii:none leaf is NOT transformed (the explicit opt-out is honoured)", async () => {
  const { OrderSchema } = await import("../src/schemas/order.ts");
  const { seen, strategy } = probeStrategy();
  // deno-lint-ignore no-explicit-any
  applyPii(orderWithAddresses() as any, OrderSchema as any, strategy);
  for (const path of ["organization.billing_address.city", "organization.billing_address.region"]) {
    assert(
      !seen.some((s) => s.startsWith(`${path}:`)),
      `"${path}" is tagged pii:"none" but the walker still handed it to the strategy`,
    );
  }
});

Deno.test("gate: no identifying address string survives a masking pass", async () => {
  const { OrderSchema } = await import("../src/schemas/order.ts");
  // deno-lint-ignore no-explicit-any
  const out = applyPii(orderWithAddresses() as any, OrderSchema as any, stringOnly) as any;
  const billing = out.organization.billing_address;
  for (const leaf of ["street", "full", "name", "postcode", "mapbox_id"]) {
    assertEquals(billing[leaf], "XXX", `billing_address.${leaf} survived unmasked`);
  }
  assertEquals(out.destinations[0].delivery.address.street, "XXX");
  assertEquals(out.destinations[0].collection.address.full, "XXX");
  // Coarse geography is opted out on purpose — it identifies nobody, and it is
  // what keeps a sanitized address plausible.
  assertEquals(billing.city, "Chicago");
  assertEquals(billing.region, "IL");
  assertEquals(billing.country_name, "United States");
});

// ── One reader ──────────────────────────────────────────────────────

/**
 * The guard (`tests/pii.test.ts`) reads tags via `collectLeafPaths`' merged
 * `leaf.meta.pii`. The runtime reads them via `readPiiTag`. If those two ever
 * disagree about WHERE a tag is allowed to live, the guard reports a field as
 * protected while `applyPii` logs it raw — which is exactly how `Address`'s
 * object-level tag stayed green in the test while doing nothing at runtime.
 *
 * They HAVE disagreed: `collectLeafPaths` looked through `.readonly()`,
 * `.nonoptional()` and `.transform()`; `readMetaThroughWrappers` did not. So
 * `z.string().meta({pii:"mask"}).transform(s => s.trim())` read `mask` in the
 * test and `undefined` at runtime. `WRAPPER_TYPES` was widened to match and a
 * pipe arm added to the meta reader.
 *
 * This is the regression test. It covers every wrapper form, with the tag placed
 * both BEFORE and AFTER each wrapper, and asserts three things agree:
 * the two readers, and that `applyPii` actually transforms the value.
 */
Deno.test("one reader: readPiiTag, collectLeafPaths and applyPii agree on every wrapper form", () => {
  const fields: Record<string, z.ZodType> = {
    bare: z.string().meta({ pii: "mask" }),

    // Tag BEFORE the wrapper (registers on the inner node).
    optional_inner: z.string().meta({ pii: "mask" }).optional(),
    nullable_inner: z.string().meta({ pii: "mask" }).nullable(),
    default_inner: z.string().meta({ pii: "mask" }).default("x"),
    catch_inner: z.string().meta({ pii: "mask" }).catch("x"),
    prefault_inner: z.string().meta({ pii: "mask" }).prefault("x"),
    readonly_inner: z.string().meta({ pii: "mask" }).readonly(),
    nonoptional_inner: z.string().meta({ pii: "mask" }).optional().nonoptional(),
    // A ZodPipe: the tag is on the input side of the transform.
    transform_inner: z.string().meta({ pii: "mask" }).transform((s) => s.trim()),

    // Tag AFTER the wrapper (registers on the wrapper node) — the `Address` shape.
    optional_outer: z.string().optional().meta({ pii: "mask" }),
    nullable_outer: z.string().nullable().meta({ pii: "mask" }),
    default_outer: z.string().default("x").meta({ pii: "mask" }),
    catch_outer: z.string().catch("x").meta({ pii: "mask" }),
    readonly_outer: z.string().readonly().meta({ pii: "mask" }),
  };

  const schema = z.object(fields);
  const { leaves, unhandled } = collectLeafPaths(schema, { inherit: ["pii"] });
  assertEquals(unhandled, [], "collectLeafPaths could not interpret the wrapper fixture");

  const record: Record<string, string> = {};
  for (const key of Object.keys(fields)) record[key] = "sensitive@example.com";

  // deno-lint-ignore no-explicit-any
  const scrubbed = applyPii(record, schema as any, stringOnly) as Record<string, unknown>;

  const disagreements: string[] = [];
  for (const key of Object.keys(fields)) {
    const viaReadPiiTag = readPiiTag(fields[key]);
    const leaf = leaves.find((l) => l.path === key);
    const viaCollect = leaf?.meta.pii;

    if (viaReadPiiTag !== "mask") {
      disagreements.push(`${key}: readPiiTag → ${viaReadPiiTag} (expected "mask")`);
    }
    if (viaCollect !== "mask") {
      disagreements.push(`${key}: collectLeafPaths → ${viaCollect} (expected "mask")`);
    }
    // The reads agreeing is necessary but not sufficient — the DESCENT has to
    // reach the field too, which is a different code path (`unwrapZod`).
    if (scrubbed[key] !== "XXX") {
      disagreements.push(`${key}: applyPii left it as ${JSON.stringify(scrubbed[key])} — tag is decorative`);
    }
  }

  assertEquals(
    disagreements,
    [],
    `The two tag readers and the runtime must agree:\n  ${disagreements.join("\n  ")}`,
  );
});
