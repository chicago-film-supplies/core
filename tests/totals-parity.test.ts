/**
 * The order grain and the invoice grain must share ONE instance per totals
 * field — the third member of the family `tests/item-shape-parity.test.ts` and
 * `tests/destination-pair-parity.test.ts` already cover.
 *
 * ## Why this is a test and not a spread
 *
 * `TotalsCore` (`schemas/order.ts`) is referenced PER KEY by both grains rather
 * than spread into either, and that was forced rather than chosen. The six
 * shared fields are contiguous in both, but their internal order differs —
 * `discount_amount_cents` is FIRST on the order and THIRD on the invoice — and a
 * schema's key order is its Firestore-surface column order, because
 * `getFirestoreColumns` walks the shape. A spread would therefore have moved
 * that column on whichever grain did not supply the ordering.
 *
 * ⭐ **Contiguity is not the test; agreement on ORDER is.** The destination pair
 * COULD be spread, on exactly that distinction. Same campaign, opposite answers,
 * and this file is the third data point: two of the three grain-sharing questions in
 * core#97 could not be spread.
 *
 * ## Why instance identity, and not structural equality
 *
 * Two separately-declared but identical nodes are still a defect.
 * `z.globalRegistry` is a WeakMap keyed on the schema INSTANCE, so a copy
 * carries none of the base's `.meta()` — every `column`/`label` on these six
 * fields would silently vanish from the tables while a structural comparison
 * stayed green, and `tests/display-columns.test.ts` cannot see the difference
 * between a field that never had a heading and one that lost it.
 *
 * ⚠️ A per-key reference is no more self-enforcing than a spread: nothing stops
 * a grain re-declaring one of these inline, which is precisely how the invoice
 * line item's `name` and `quantity` drifted before core#97. Only `===` sees it.
 */
import { assertEquals } from "@std/assert";
import { InitiatorTotals, TotalsCore } from "../src/schemas/order.ts";
import { InvoiceSchema, OrderSchema, PurchaseSchema } from "../src/schemas/mod.ts";

/** The `z.strictObject` shape behind an annotated `z.ZodType<T>` schema. */
// deno-lint-ignore no-explicit-any
function shapeOf(schema: unknown, label: string): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const def = (schema as any)?._zod?.def;
  assertEquals(def?.type, "object", `${label}: not an object schema`);
  return def.shape;
}

/** Reached through the PUBLIC document schemas, so what is checked is what a consumer parses with. */
function totalsShapeOf(schema: unknown, label: string): Record<string, unknown> {
  return shapeOf(unwrapOptional(shapeOf(schema, label).totals), `${label}.totals`);
}

/** The node under an `.optional()` — the purchase's `totals` through D5's expand. */
function unwrapOptional(node: unknown): unknown {
  // deno-lint-ignore no-explicit-any
  const def = (node as any)?._zod?.def;
  return def?.type === "optional" ? def.innerType : node;
}

const GRAINS = [
  ["OrderSchema", OrderSchema],
  ["InvoiceSchema", InvoiceSchema],
  ["PurchaseSchema", PurchaseSchema],
] as const;

Deno.test("totals parity: every TotalsCore field is the SAME INSTANCE on both grains", () => {
  const wrong: string[] = [];
  for (const [label, schema] of GRAINS) {
    const shape = totalsShapeOf(schema, label);
    for (const key of Object.keys(TotalsCore)) {
      if (!(key in shape)) {
        wrong.push(`${label}.totals is MISSING ${key}`);
        continue;
      }
      if (shape[key] !== (TotalsCore as Record<string, unknown>)[key]) {
        wrong.push(`${label}.totals.${key} is a SEPARATE instance — re-declared inline, or shadowed`);
      }
    }
  }
  assertEquals(wrong, [], wrong.join("\n"));
});

Deno.test("totals parity: each grain's own key ORDER is unchanged by the sharing", () => {
  // 🔴 The property the per-key reference exists to preserve. If someone
  // "tidies" either grain into `{ ...TotalsCore, … }`, this is what goes red —
  // and it is the only arm that would, because the instances would still be
  // identical and every parse would still succeed.
  assertEquals(
    Object.keys(totalsShapeOf(OrderSchema, "OrderSchema")),
    [
      "discount_amount_cents",
      "subtotal_cents",
      "subtotal_discounted_cents",
      "taxes",
      "transaction_fees",
      "total_cents",
      "replacement_total_cents",
    ],
  );
  assertEquals(
    Object.keys(totalsShapeOf(InvoiceSchema, "InvoiceSchema")),
    [
      "subtotal_cents",
      "subtotal_discounted_cents",
      "discount_amount_cents",
      "taxes",
      "transaction_fees",
      "total_cents",
      "amount_paid_cents",
      "amount_credited_cents",
      "amount_void_cents",
      "amount_due_cents",
      // Appended LAST and carries no `column` meta, so the picker order is
      // untouched (api-cloudrun#1169).
      "closure_count",
    ],
  );
});

Deno.test("totals parity: the two initiators share ONE totals node (one-document-model D5)", () => {
  // Not merely the same keys: the same instance, so a column or label added to
  // the order's totals reaches the purchase's with nothing to keep in step.
  const order = unwrapOptional(shapeOf(OrderSchema, "OrderSchema").totals);
  const purchase = unwrapOptional(shapeOf(PurchaseSchema, "PurchaseSchema").totals);
  // `.meta()` clones, so the identity is checked on the shape the clone shares.
  assertEquals(shapeOf(purchase, "purchase.totals") === shapeOf(InitiatorTotals, "InitiatorTotals"), true);
  assertEquals(shapeOf(order, "order.totals") === shapeOf(InitiatorTotals, "InitiatorTotals"), true);
});

Deno.test("totals parity: replacement_total_cents is INITIATOR-ONLY, deliberately", () => {
  // An invoice price has no `replacement_cents`, so an invoice structurally
  // cannot compute one. Asserted so it is never "fixed" into TotalsCore.
  assertEquals("replacement_total_cents" in totalsShapeOf(OrderSchema, "OrderSchema"), true);
  assertEquals("replacement_total_cents" in totalsShapeOf(PurchaseSchema, "PurchaseSchema"), true);
  assertEquals("replacement_total_cents" in totalsShapeOf(InvoiceSchema, "InvoiceSchema"), false);
  assertEquals("replacement_total_cents" in TotalsCore, false);
});
