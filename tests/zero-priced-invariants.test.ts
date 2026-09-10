import { assertEquals } from "@std/assert";
import {
  FulfillmentItem,
  FulfillmentSchema,
  InvoiceDocLineItem,
  InvoiceSchema,
  OrderDocLineItem,
  OrderSchema,
} from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * The ARRAY-level `zero_priced` refinement — `core#100`, both directions, on all
 * three grains.
 *
 * 🔴 **These arms exist because the suite went GREEN the moment the refinement
 * was wired in, and a refinement that refuses nothing looks exactly like a corpus
 * that satisfies it.** Every arm below moves a document across the boundary: it
 * asserts a REFUSAL, the matching ACCEPTANCE, and — for the refusal — the `path`
 * the issue is reported at, so a document failing for some unrelated reason
 * cannot satisfy it.
 *
 * The two directions are deliberately not symmetrical in what they ask:
 *  - (2) a line flagged `zero_priced` must be a COMPONENT;
 *  - (3) a COMPONENT must state the flag, where `null` is not a statement.
 */

const DIV = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";

/**
 * A line at whatever path and flag the arm needs, built through `getTestDoc` so
 * it is a COMPLETE parsed item rather than a literal that happens to satisfy
 * today's schema. `sale` rather than `rental` on purpose: a rental obliges
 * `price.replacement_cents` through its own superRefine, and an arm failing on
 * THAT would look exactly like the refinement under test firing.
 */
function line(uid: string, path: string[], zero_priced: boolean | null | undefined) {
  return getTestDoc(OrderDocLineItem, {
    uid,
    type: "sale",
    path,
    ...(zero_priced === undefined ? {} : { zero_priced }),
  });
}

function invoiceLine(uid: string, path: string[], zero_priced: boolean | null | undefined) {
  return getTestDoc(InvoiceDocLineItem, {
    uid,
    type: "sale",
    path,
    ...(zero_priced === undefined ? {} : { zero_priced }),
  });
}

function fulfillmentLine(uid: string, path: string[], zero_priced: boolean | null | undefined) {
  return getTestDoc(FulfillmentItem, {
    uid,
    type: "sale",
    path,
    ...(zero_priced === undefined ? {} : { zero_priced }),
  });
}

/** The `destination` divider both grains hang their lines under. */
const divider = { uid: DIV, type: "destination" as const, name: "Site", description: "", path: [DIV] };

/** Did the parse fail, and did it fail AT this items index on this field? */
function refusedAt(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, index: number) {
  if (result.success) return false;
  return (result.error?.issues ?? []).some((i) =>
    i.path.includes("items") && i.path.includes(index) && i.path.includes("zero_priced")
  );
}

Deno.test("invariant (2): a flagged line must be a COMPONENT", async (t) => {
  const base = getTestDoc(OrderSchema, { uid: "testorder00000000001", created_at: mockTimestamp, updated_at: mockTimestamp }, { now: mockTimestamp });

  await t.step("a flag on a line under a DIVIDER is refused, at that row", () => {
    const doc = { ...base, items: [divider, line(PARENT, [DIV, PARENT], true)] };
    assertEquals(refusedAt(OrderSchema.safeParse(doc), 1), true);
  });

  await t.step("…and the SAME document with the flag on its component is accepted", () => {
    // The control. Without it the arm above passes against a schema that refuses
    // every document, which is the failure mode a one-sided test cannot see.
    const doc = {
      ...base,
      items: [divider, line(PARENT, [DIV, PARENT], null), line(CHILD, [DIV, PARENT, CHILD], true)],
    };
    assertEquals(OrderSchema.safeParse(doc).success, true);
  });
});

Deno.test("invariant (3): a COMPONENT must state the flag", async (t) => {
  const base = getTestDoc(OrderSchema, { uid: "testorder00000000002", created_at: mockTimestamp, updated_at: mockTimestamp }, { now: mockTimestamp });
  const withChild = (flag: boolean | null | undefined) => ({
    ...base,
    items: [divider, line(PARENT, [DIV, PARENT], null), line(CHILD, [DIV, PARENT, CHILD], flag)],
  });

  await t.step("ABSENT is refused", () => {
    assertEquals(refusedAt(OrderSchema.safeParse(withChild(undefined)), 2), true);
  });

  await t.step("🔴 NULL is refused too — it is what the old writer emitted", () => {
    // The arm that matters. `buildOrderComponentLines` writes
    // `comp.zero_priced ?? null`, so accepting `null` would leave the defect
    // representable under a different spelling and the refinement would certify
    // the exact corpus it was written to empty.
    assertEquals(refusedAt(OrderSchema.safeParse(withChild(null)), 2), true);
  });

  await t.step("both booleans are accepted", () => {
    assertEquals(OrderSchema.safeParse(withChild(true)).success, true);
    assertEquals(OrderSchema.safeParse(withChild(false)).success, true);
  });

  await t.step("a NON-component may still carry null — only components are asked", () => {
    const doc = { ...base, items: [divider, line(PARENT, [DIV, PARENT], null)] };
    assertEquals(OrderSchema.safeParse(doc).success, true);
  });
});

Deno.test("the refinement is wired on ALL THREE grains, not just the order", async (t) => {
  // ⚠️ Wiring is per-array, so a grain can be missed silently: the shared
  // predicate passing its own unit test says nothing about which schemas call it.
  await t.step("invoices", () => {
    const base = getTestDoc(InvoiceSchema, { uid: "testinvoice000000001", created_at: mockTimestamp, updated_at: mockTimestamp }, { now: mockTimestamp });
    const ORDER_DIV = "testorderdoc00000001";
    const items = (flag: boolean | null) => [
      { uid: ORDER_DIV, type: "order" as const, name: "Order 1", description: "", path: [ORDER_DIV] },
      invoiceLine(PARENT, [ORDER_DIV, PARENT], null),
      invoiceLine(CHILD, [ORDER_DIV, PARENT, CHILD], flag),
    ];
    assertEquals(refusedAt(InvoiceSchema.safeParse({ ...base, items: items(null) }), 2), true);
    assertEquals(InvoiceSchema.safeParse({ ...base, items: items(true) }).success, true);
  });

  await t.step("fulfillments", () => {
    const base = getTestDoc(FulfillmentSchema, { uid: "testfulfillment00001", created_at: mockTimestamp, updated_at: mockTimestamp }, { now: mockTimestamp });
    const items = (flag: boolean | null) => [
      divider,
      fulfillmentLine(PARENT, [DIV, PARENT], null),
      fulfillmentLine(CHILD, [DIV, PARENT, CHILD], flag),
    ];
    assertEquals(refusedAt(FulfillmentSchema.safeParse({ ...base, items: items(null) }), 2), true);
    assertEquals(FulfillmentSchema.safeParse({ ...base, items: items(true) }).success, true);
  });
});
