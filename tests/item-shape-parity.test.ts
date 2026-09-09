/**
 * The three grains' line items must share ONE instance per common field.
 *
 * ## What this replaces, and why it is stronger
 *
 * `orders`, `invoices` and `fulfillments` restated `uid`/`name`/`description`/
 * `quantity`/`path`/`zero_priced` independently, and three of the six had
 * already drifted by 2026-09-09: the invoice's `name` was a bare `z.string()`
 * where the other two were `.min(1).max(100)`, and its `quantity` was `z.int()`
 * with no `.min(0)`. So an invoice line could store an empty name and a negative
 * quantity that the order line it was billed from could not.
 *
 * The obvious fix is `z.strictObject({ ...LineItemCore, … })`, and `_items.ts`
 * explains why it is not used: the shape's key order becomes the schema's key
 * order, `getFirestoreColumns` walks the shape, and the six fields are not
 * contiguous in any grain — so a spread silently reorders the operator's column
 * picker on all three surfaces. Referencing per key preserves the order and
 * gives up exactly one thing: a new field no longer arrives on all three grains
 * for free. **This test is where that guarantee moved to.**
 *
 * ⭐ **And it is strictly stronger than the spread it replaces.** A spread cannot
 * see a grain SHADOWING a shared key — `{ ...LineItemCore, name: z.string() }`
 * compiles, and the later key silently wins. That is precisely how `name` and
 * `quantity` drifted. Instance identity catches both directions: a grain that
 * omits a shared field, and a grain that re-declares one.
 *
 * 🔴 **Instance identity is the assertion, not structural equality.** Two
 * separately-declared `z.string().min(1).max(100)` nodes are structurally
 * identical and are still a defect, because `z.globalRegistry` is a WeakMap
 * keyed on the instance: the copy carries none of the base's `.meta()`, and a
 * dropped `pii` tag is invisible to `tests/pii.test.ts` by construction. Only
 * `===` sees that.
 *
 * ⚠️ Reached through the PUBLIC collection schemas rather than by importing the
 * un-annotated Inner consts, so what is checked is what a consumer can actually
 * parse with. A grain that shared the instance internally and exported something
 * else would pass an import-based check and fail this one.
 */
import { assert, assertEquals } from "@std/assert";
import { LineItemCore } from "../src/schemas/_items.ts";
import { InvoiceDocItem, schemas } from "../src/schemas/mod.ts";

const GRAINS = ["orders", "invoices", "fulfillments"] as const;

/**
 * The line-item arm of a grain's `items` union.
 *
 * Discriminated by `type` being an `enum` — every divider arm declares a
 * `z.literal()` ("destination", "group", the invoice's "order"), and only the
 * line arm carries a vocabulary. That is a structural fact about the unions, not
 * a name match, so it survives a new divider being added.
 */
// deno-lint-ignore no-explicit-any
function lineArmShape(collection: (typeof GRAINS)[number]): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const root = schemas[collection] as any;
  const itemsField = root._zod.def.shape.items;
  // `items` is `z.array(...).default([])` at all three grains.
  const arr = itemsField._zod.def.innerType ?? itemsField;
  assertEquals(arr._zod.def.type, "array", `${collection}: items is not an array`);
  const union = arr._zod.def.element;
  assertEquals(union._zod.def.type, "union", `${collection}: items element is not a union`);

  // deno-lint-ignore no-explicit-any
  const arms = (union._zod.def.options as any[]).filter(
    (o) => o._zod.def.shape?.type?._zod.def.type === "enum",
  );
  assertEquals(arms.length, 1, `${collection}: expected exactly one line-item arm, got ${arms.length}`);
  return arms[0]._zod.def.shape;
}

Deno.test("every LineItemCore field is present on all three grains", () => {
  const missing: string[] = [];
  for (const grain of GRAINS) {
    const shape = lineArmShape(grain);
    for (const key of Object.keys(LineItemCore)) {
      if (!(key in shape)) missing.push(`${grain}.items[].${key}`);
    }
  }
  assertEquals(
    missing,
    [],
    "A shared line-item field is absent from a grain. Add it, or remove it from " +
      "LineItemCore — a field on two of three grains is the drift this module exists to stop:\n" +
      missing.join("\n"),
  );
});

Deno.test("every shared field is the SAME INSTANCE at all three grains", () => {
  const drifted: string[] = [];
  for (const grain of GRAINS) {
    const shape = lineArmShape(grain);
    for (const [key, canonical] of Object.entries(LineItemCore)) {
      if (!(key in shape)) continue; // reported by the arm above
      if (shape[key] !== canonical) {
        drifted.push(`${grain}.items[].${key} — re-declared instead of referencing LineItemCore.${key}`);
      }
    }
  }
  assertEquals(
    drifted,
    [],
    "A grain re-declared a shared field. It may be byte-identical today and it is " +
      "still a defect: `.meta()` is registered per INSTANCE, so the copy carries " +
      "none of the base's pii/column/label tags and nothing else would notice:\n" +
      drifted.join("\n"),
  );
});

Deno.test("LineItemCore is not vacuous", () => {
  // The failure mode this arm exists for: someone empties LineItemCore, or the
  // walk above stops finding line arms, and both tests above pass by iterating
  // nothing. Same shape as `meta-preservation.test.ts`'s non-vacuity gate.
  assert(Object.keys(LineItemCore).length >= 6, "LineItemCore has lost fields");
  for (const grain of GRAINS) {
    assert(
      Object.keys(lineArmShape(grain)).length > Object.keys(LineItemCore).length,
      `${grain}: line arm has no grain-specific fields — the walk is probably wrong`,
    );
  }
});

Deno.test("the invoice grain carries the bounds it drifted from", () => {
  // Pinned as VALUES rather than left to instance identity alone, because that
  // is the concrete defect this pass repaired and a future edit to
  // LineItemCore would otherwise relax all three grains at once with every
  // parity arm still green.
  const invoice = lineArmShape("invoices");
  assertEquals(invoice.name.safeParse("").success, false, "empty item name must be refused");
  assertEquals(invoice.name.safeParse("x".repeat(101)).success, false, "a 101-char item name must be refused");
  assertEquals(invoice.name.safeParse("Dewalt Work Light").success, true);
  assertEquals(invoice.quantity.safeParse(-1).success, false, "a negative quantity must be refused");
  assertEquals(invoice.quantity.safeParse(2.5).success, false, "a fractional quantity must be refused");
  assertEquals(invoice.quantity.safeParse(3).success, true);
});

/**
 * The remaining increment-1 tightenings, asserted as VALUES.
 *
 * ⚠️ Separate from the parity arms above on purpose. Instance identity says the
 * three grains agree; it cannot say *what* they agree on, so a later edit to
 * `LineItemCore` could relax all three at once with every parity arm still
 * green. These pin the constraints themselves.
 */
Deno.test("checkZeroPricedAmount now runs when an INVOICE DOCUMENT parses", () => {
  // 🔴 The regression this catches is not a loosened bound — it is the refine
  // silently detaching again. It was attached to the exported alias
  // (`InvoiceDocLineItem`) while `InvoiceDocItem`'s union is built from
  // the un-refined Inner, so `validateBeforeWrite` on an invoice never asked
  // whether a zero-priced line carried a charge. Asserted through the ITEM
  // UNION, which is what the document actually parses with — testing the
  // exported alias would have passed for that entire period.
  const line = (over: Record<string, unknown> = {}) => ({
    uid: "abcdefghij0123456789",
    type: "rental",
    name: "Light",
    description: "",
    quantity: 1,
    path: ["abcdefghij0123456789"],
    price: {
      base_cents: 1000,
      formula: "five_day_week",
      chargeable_days: 1,
      subtotal_cents: 1000,
      subtotal_discounted_cents: 1000,
      total_cents: 1000,
      discount: null,
      taxes: [],
      taxes_base: [],
    },
    ...over,
  });

  // Positive control — the same line without the flag must still parse, so a
  // failure below is attributable to `zero_priced` and not to the fixture.
  assertEquals(InvoiceDocItem.safeParse(line()).success, true, "control line must parse");
  assertEquals(
    InvoiceDocItem.safeParse(line({ zero_priced: true })).success,
    false,
    "a zero_priced line carrying a non-zero base_cents must be REFUSED by the document union",
  );
  // And the flag itself is not what makes it fail — only the contradiction does.
  const zeroed = line({ zero_priced: true });
  (zeroed.price as Record<string, unknown>).base_cents = 0;
  (zeroed.price as Record<string, unknown>).subtotal_cents = 0;
  (zeroed.price as Record<string, unknown>).subtotal_discounted_cents = 0;
  (zeroed.price as Record<string, unknown>).total_cents = 0;
  assertEquals(InvoiceDocItem.safeParse(zeroed).success, true, "a genuinely zero-priced line must parse");
});

Deno.test("invoice items[].price.chargeable_days is integral", () => {
  const days = (v: number) =>
    // deno-lint-ignore no-explicit-any
    (lineArmShape("invoices").price as any)._zod.def.shape.chargeable_days.safeParse(v).success;
  assertEquals(days(2.5), false, "a fractional chargeable_days must be refused — a count of days is integral");
  assertEquals(days(3), true);
  assertEquals(days(0), true);
});

Deno.test("all three grain guards are reachable from the BARREL, not just their own module", async () => {
  // 🔴 `schemas/mod.ts` lists its exports EXPLICITLY, and nothing else in this
  // repo notices an omission: `deno check` passes (the module compiles),
  // `check:declarations` passes (the symbol has a type), and the suite passes
  // because core's tests import schema files directly rather than through the
  // barrel. It surfaces at the first CONSUMER import, one publish later —
  // beta.342 shipped it once, and beta.388 shipped `isFulfillmentLineItem` that
  // way despite the source export being correct.
  //
  // ⚠️ Imported dynamically, by NAME, from the barrel — a static
  // `import { x } from "../src/schemas/mod.ts"` for an unused binding is elided
  // before the module links, so it passes for a symbol that does not exist.
  const barrel = await import("../src/schemas/mod.ts");
  const missing = (["isLineItem", "isInvoiceLineItem", "isFulfillmentLineItem"] as const)
    .filter((name) => typeof (barrel as Record<string, unknown>)[name] !== "function");
  assertEquals(
    missing,
    [],
    "A grain's line-item guard is not on the `@cfs/core/schemas` barrel. Consumers " +
      "cannot reach it, which is the entire point of core#90 — the copies it replaces " +
      "all import the barrel. Add it to the export block in `schemas/mod.ts`:\n" +
      missing.join("\n"),
  );
});
