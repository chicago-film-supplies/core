/**
 * The order grain and the invoice grain must share ONE instance per
 * destination-pair field.
 *
 * ## What this replaces, and what it caught
 *
 * `DocDestination` (`schemas/order.ts`) and `InvoiceDocDestination`
 * (`schemas/invoice.ts`) were two independent `z.strictObject`s restating the
 * same six keys. `InvoiceDocDestinationType extends DocDestinationType`, so the
 * TYPE was inherited and the compiler was satisfied; the schema inherited
 * nothing, and `invoice.ts` said so in its own words — *"🔴 THIS LIST INHERITS
 * NOTHING."*
 *
 * They drifted, in the direction this pair can least afford. `9435a15`
 * (2026-09-08) made `customer_collecting` / `customer_returning` REQUIRED on the
 * order grain, because the `.default(false)` they carried never materializes in
 * Firestore (`validateBeforeWrite` discards `result.data`) and its one effect
 * was to let a writer omit a flag that reads downstream as `false`, i.e. *"we
 * deliver"* — the answer that sends a crew to an address. The invoice grain kept
 * both defaults for another day, and 16 flags were absent across 8 prod invoices
 * (core#101).
 *
 * ⭐ **Both grains now spread `DestinationPairCore`, and the spread is what a
 * SHADOWED key defeats.** `{ ...DestinationPairCore, customer_collecting:
 * z.boolean().default(false) }` compiles and the later key silently wins — which
 * is the same shape as the original drift, one level down. Instance identity is
 * the only assertion that sees it.
 *
 * ⚠️ **Structural equality would NOT do.** Two separately-declared but identical
 * nodes are still a defect: `z.globalRegistry` is a WeakMap keyed on the
 * instance, so a copy carries none of the base's `.meta()`, and a dropped `pii`
 * or `column` tag is invisible to `tests/pii.test.ts` and
 * `tests/display-columns.test.ts` by construction. Only `===` sees it.
 *
 * ⚠️ Reached through the PUBLIC schemas rather than by reading the shape object
 * twice, so what is checked is what a consumer can actually parse with.
 */
import { assert, assertEquals } from "@std/assert";
import { DestinationPairCore } from "../src/schemas/order.ts";
import { DocDestination, InvoiceDocDestination } from "../src/schemas/mod.ts";
import type { FirestoreTimestampType } from "../src/schemas/common.ts";

/** `core` has no firebase-admin dependency — `FirestoreTimestamp` is a duck-typed
 *  `z.custom` accepting the public `{seconds, nanoseconds}` accessor shape. */
function fsTs(iso: string): FirestoreTimestampType {
  return { seconds: Math.floor(new Date(iso).getTime() / 1000), nanoseconds: 0 } as FirestoreTimestampType;
}

/** The `z.strictObject` shape behind an annotated `z.ZodType<T>` schema. */
// deno-lint-ignore no-explicit-any
function shapeOf(schema: unknown, label: string): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const def = (schema as any)?._zod?.def;
  assertEquals(def?.type, "object", `${label}: not an object schema`);
  return def.shape;
}

const GRAINS = [
  ["DocDestination", DocDestination],
  ["InvoiceDocDestination", InvoiceDocDestination],
] as const;

Deno.test("every DestinationPairCore field is present on both grains", () => {
  const missing: string[] = [];
  for (const [label, schema] of GRAINS) {
    const shape = shapeOf(schema, label);
    for (const key of Object.keys(DestinationPairCore)) {
      if (!(key in shape)) missing.push(`${label}.${key}`);
    }
  }
  assertEquals(
    missing,
    [],
    "A shared destination-pair field is absent from a grain. Add it, or remove it " +
      "from DestinationPairCore — a field on one grain and not the other is the " +
      "drift that object exists to stop:\n" + missing.join("\n"),
  );
});

Deno.test("every shared field is the SAME INSTANCE on both grains", () => {
  const drifted: string[] = [];
  for (const [label, schema] of GRAINS) {
    const shape = shapeOf(schema, label);
    for (const [key, canonical] of Object.entries(DestinationPairCore)) {
      if (!(key in shape)) continue; // reported by the arm above
      if (shape[key] !== canonical) {
        drifted.push(`${label}.${key} — re-declared instead of spreading DestinationPairCore.${key}`);
      }
    }
  }
  assertEquals(
    drifted,
    [],
    "A grain re-declared or SHADOWED a shared field. It may be byte-identical " +
      "today and it is still a defect: `.meta()` is registered per INSTANCE, so " +
      "the copy carries none of the base's pii/column/label tags and nothing else " +
      "would notice:\n" + drifted.join("\n"),
  );
});

/**
 * ⚠️ **Key ORDER is asserted, not just membership** — a schema's key order is its
 * Firestore-surface column order (`getFirestoreColumns` walks the shape), so a
 * spread that moved a key would move the operator's column picker. That is
 * precisely why `schemas/_items.ts` references its shared fields per key instead:
 * the line item's six shared fields are not contiguous in any grain. Here they
 * are the whole object and `uid_order` was already first, which is what makes the
 * spread inert. This arm is what keeps it inert.
 */
Deno.test("both grains' key order is exactly the shared shape (invoice prefixed by uid_order)", () => {
  const core = Object.keys(DestinationPairCore);
  assertEquals(
    Object.keys(shapeOf(DocDestination, "DocDestination")),
    core,
    "the order grain is the shared shape and nothing else",
  );
  assertEquals(
    Object.keys(shapeOf(InvoiceDocDestination, "InvoiceDocDestination")),
    ["uid_order", ...core],
    "the invoice grain is `uid_order` plus the shared shape, in that order — a new " +
      "key here is an operator-visible column move, so state it deliberately",
  );
});

Deno.test("DestinationPairCore is not vacuous", () => {
  // The failure mode: someone empties the shape object and both arms above pass
  // by iterating nothing. Same guard as `tests/item-shape-parity.test.ts`.
  assert(Object.keys(DestinationPairCore).length >= 7, "DestinationPairCore has lost fields");
});

/**
 * The tightening this pass landed, asserted as VALUES on the grain that did not
 * have it.
 *
 * ⚠️ Separate from the parity arms on purpose. Instance identity says the two
 * grains agree; it cannot say *what* they agree on, so a later edit to
 * `DestinationPairCore` could re-add the default on both at once with every
 * parity arm still green. `tests/order.test.ts` pins the same pair of assertions
 * on the order grain; this is the invoice half.
 */
Deno.test("InvoiceDocDestination REFUSES a pair that omits customer_collecting/returning", () => {
  const base = {
    uid_order: "testorder10000000000",
    uid: "11111111-1111-4111-8111-111111111111",
    // ⚠️ **Complete on purpose, all fourteen keys.** This map used to state six
    // and parse anyway, because `OrderDocDates` carried `.default(null)` on
    // every field. Those defaults are gone (a default on a stored schema is
    // inert — `validateBeforeWrite` persists the raw document — so its one
    // effect was letting a writer omit a key), which means an incomplete map is
    // now itself a refusal. That would make the assertion below pass for the
    // WRONG reason: the subject here is the two flags, and the positive control
    // at the foot of this test is only a control if the fixture's dates are not
    // also at fault.
    dates: {
      delivery_start: "2026-01-05T08:00:00.000-06:00",
      delivery_start_fs: fsTs("2026-01-05T08:00:00.000-06:00"),
      delivery_end: "2026-01-05T09:00:00.000-06:00",
      delivery_end_fs: fsTs("2026-01-05T09:00:00.000-06:00"),
      collection_start: "2026-01-09T08:00:00.000-06:00",
      collection_start_fs: fsTs("2026-01-09T08:00:00.000-06:00"),
      collection_end: "2026-01-09T09:00:00.000-06:00",
      collection_end_fs: fsTs("2026-01-09T09:00:00.000-06:00"),
      charge_start: "2026-01-05T08:00:00.000-06:00",
      charge_start_fs: fsTs("2026-01-05T08:00:00.000-06:00"),
      charge_end: "2026-01-09T09:00:00.000-06:00",
      charge_end_fs: fsTs("2026-01-09T09:00:00.000-06:00"),
      days_active: 5,
      days_charged: 5,
    },
    delivery: { uid: null, address: null, instructions: null, contact: null },
    collection: { uid: null, address: null, instructions: null, contact: null },
  };

  const refused = InvoiceDocDestination.safeParse(base);
  assertEquals(refused.success, false, "an omitted flag must not parse to `false`");
  assertEquals(
    refused.success === false && refused.error.issues.map((i) => i.path.join(".")).sort(),
    ["customer_collecting", "customer_returning"],
    "and BOTH are named, so a writer is told what to stamp",
  );

  // Positive control — the same pair with both flags supplied must still parse,
  // so the refusal above is attributable to the flags and not to the fixture.
  const stamped = InvoiceDocDestination.safeParse({
    ...base,
    customer_collecting: false,
    customer_returning: false,
  });
  assertEquals(stamped.success, true, "control pair must parse");
  if (stamped.success) {
    assertEquals(stamped.data.customer_collecting, false);
    assertEquals(stamped.data.customer_returning, false);
    assertEquals(stamped.data.uid_order, "testorder10000000000");
  }
});
