/**
 * `subject` is one field at three grains, and it must BEHAVE identically at all
 * three — core#97 increment 3.
 *
 * ## What this replaces
 *
 * Three independent declarations of the same field, disagreeing in both
 * directions at once:
 *
 * | grain | before | accepted `undefined`? | accepted `null`? |
 * |---|---|---|---|
 * | order | `z.string().default("")` | **yes** | no |
 * | fulfillment | `z.string().default("")` | **yes** | no |
 * | invoice | `z.string().nullable()` | no | **yes** |
 *
 * So "no subject" had two spellings and the key had two presence rules, on
 * three grains of ONE document that propagate into each other. All three are a
 * bare `z.string()` now: required, present, non-nullable, `""` for absence.
 *
 * ⭐ **This is a BEHAVIOURAL parity test rather than an instance-identity one,
 * and that is forced rather than lazy.** `tests/destination-pair-parity.test.ts`
 * can assert `===` because the pair's fields are genuinely one instance shared
 * by two grains. `subject` cannot be: each grain's `.meta()` carries its own
 * `linkTo` (`orderDetail` / `invoiceDetail` / `fulfillmentDetail`), and
 * `.meta()` CLONES — `z.globalRegistry` is a WeakMap keyed on the instance — so
 * three annotations mean three instances however the shape is written. The
 * claim worth guarding is therefore what a parse does, not what the object
 * graph looks like.
 *
 * ⚠️ **Which means the `.meta()` half has to be checked explicitly**, because
 * the clone that makes identity impossible is also what could silently drop a
 * tag. `pii: "mask"` is load-bearing on all three — `fixturePiiStrategy` masks
 * this field precisely because operators type shoot addresses into it
 * (8 of 100 consecutive prod orders, measured 2026-09-05) — and a field that
 * never had a tag is indistinguishable from one that lost it, so
 * `tests/pii.test.ts` cannot see a regression here.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { FulfillmentSchema, InvoiceSchema, OrderSchema } from "../src/schemas/mod.ts";

/** The `z.strictObject` shape behind an annotated `z.ZodType<T>` schema. */
// deno-lint-ignore no-explicit-any
function shapeOf(schema: unknown, label: string): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const def = (schema as any)?._zod?.def;
  assertEquals(def?.type, "object", `${label}: not an object schema`);
  return def.shape;
}

const GRAINS = [
  ["OrderSchema", OrderSchema, "orderDetail"],
  ["InvoiceSchema", InvoiceSchema, "invoiceDetail"],
  ["FulfillmentSchema", FulfillmentSchema, "fulfillmentDetail"],
] as const;

Deno.test("subject parity: every grain accepts a string and refuses absence and null", () => {
  for (const [label, schema] of GRAINS) {
    const subject = shapeOf(schema, label).subject as z.ZodType;

    assertEquals(subject.safeParse("May Shoot").success, true, `${label}: a string must parse`);
    assertEquals(subject.safeParse("").success, true, `${label}: "" is the no-subject value`);

    // 🔴 The two that used to disagree. `undefined` was accepted by order and
    // fulfillment (their `.default("")`, inert on a write and therefore a pure
    // widening of the accepted set); `null` was accepted by the invoice alone.
    assertEquals(
      subject.safeParse(undefined).success,
      false,
      `${label}: an ABSENT subject must be refused — a .default() here only widens what a writer may omit, it never fills a stored document`,
    );
    assertEquals(
      subject.safeParse(null).success,
      false,
      `${label}: a NULL subject must be refused — "no subject" is "" at every grain`,
    );
    assertEquals(subject.safeParse(42).success, false, `${label}: a non-string must be refused`);
  }
});

Deno.test("subject parity: the annotation agrees except for its own linkTo", () => {
  for (const [label, schema, linkTo] of GRAINS) {
    const subject = shapeOf(schema, label).subject as z.ZodType;
    const meta = z.globalRegistry.get(subject) as Record<string, unknown> | undefined;
    assert(meta, `${label}: subject carries no .meta() at all`);
    assertEquals(meta.pii, "mask", `${label}: subject must stay pii:"mask" — operators type addresses into it`);
    assertEquals(meta.column, true, `${label}: subject is a table column at every grain`);
    assertEquals(meta.label, "Subject", `${label}: the column heading must agree`);
    assertEquals(meta.linkTo, linkTo, `${label}: subject links to its OWN grain's detail route`);
  }
});
