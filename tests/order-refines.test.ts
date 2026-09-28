import { assertEquals } from "@std/assert";
import {
  CreateOrderInput,
  destinationJoinViolations,
  FulfillmentItem,
  FulfillmentSchema,
  InvoiceDocDestination,
  InvoiceDocLineItem,
  InvoiceSchema,
  isSingleEntryDeduction,
  OrderDocLineItem,
  OrderItemLine,
  OrderSchema,
  UpdateOrderInput,
  zeroQuantityComponents,
} from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * The two S8 refinements of the order-edit-custody campaign (core#119):
 *
 * 1. **divider ↔ pair** on the order and the fulfillment — never the invoice;
 * 2. **a component line never has `quantity: 0`** on the order, stored and input.
 *
 * Every arm asserts a REFUSAL at a named `path`, and its matching ACCEPTANCE, so a
 * document failing for some unrelated reason cannot satisfy it.
 */

const DIV_A = "11111111-1111-4111-8111-111111111111";
const DIV_B = "22222222-2222-4222-8222-222222222222";
const PARENT = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";
const NOW = { now: mockTimestamp };
const stamps = { created_at: mockTimestamp, updated_at: mockTimestamp };

const divider = (uid: string) => ({ uid, type: "destination" as const, name: "Site", description: "", path: [uid] });

/** A parsed fixture with its pairs renamed to `uids`, one pair per uid. */
function withPairs<D extends { destinations: { uid: string }[] }>(doc: D, uids: string[]): D {
  const proto = doc.destinations[0];
  return { ...doc, destinations: uids.map((uid) => ({ ...proto, uid })) };
}

const order = () => getTestDoc(OrderSchema, { uid: "testorder00000000001", ...stamps }, NOW);
const fulfillment = () => getTestDoc(FulfillmentSchema, { uid: "testfulfillment00001", ...stamps }, NOW);
const invoice = () => getTestDoc(InvoiceSchema, { uid: "testinvoice000000001", ...stamps }, NOW);
/** `getTestDoc` gives an invoice NO pairs (the array may be empty), so the invoice arms build real ones. */
const invoicePairs = (uids: string[]) => uids.map((uid) => getTestDoc(InvoiceDocDestination, { uid }, NOW));

/** Did the parse fail with an issue at `path`? */
function refusedAt(
  result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } },
  path: PropertyKey[],
): boolean {
  if (result.success) return false;
  return (result.error?.issues ?? []).some((i) =>
    i.path.length === path.length && i.path.every((seg, k) => seg === path[k])
  );
}

Deno.test("destinationJoinViolations: the biconditional and its one exemption", async (t) => {
  await t.step("joined 2:2 is clean", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A), divider(DIV_B)], [{ uid: DIV_A }, { uid: DIV_B }]),
      [],
    );
  });

  await t.step("a divider no pair answers is reported by its uid", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A), divider(DIV_B)], [{ uid: DIV_A }]),
      [{ kind: "divider_without_pair", uid: DIV_B }],
    );
  });

  await t.step("a pair naming no divider is reported at its index", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A)], [{ uid: DIV_A }, { uid: DIV_B }]),
      [{ kind: "pair_without_divider", uid: DIV_B, index: 1 }],
    );
  });

  await t.step("no dividers and ONE pair is the sanctioned deduction", () => {
    assertEquals(destinationJoinViolations([], [{ uid: DIV_A }]), []);
    assertEquals(isSingleEntryDeduction(0, 1), true);
  });

  await t.step("…and no dividers beside TWO pairs is not", () => {
    assertEquals(destinationJoinViolations([], [{ uid: DIV_A }, { uid: DIV_B }]).length, 2);
    assertEquals(isSingleEntryDeduction(0, 2), false);
    // One divider beside one unrelated pair is neither exempt nor joined.
    assertEquals(isSingleEntryDeduction(1, 1), false);
    assertEquals(destinationJoinViolations([divider(DIV_A)], [{ uid: DIV_B }]).length, 2);
  });

  await t.step("a row with a non-string uid is left to the schema parse", () => {
    assertEquals(destinationJoinViolations([{ type: "destination", uid: 7 }], [{ uid: DIV_A }]), []);
  });
});

Deno.test("checkDestinationJoin: wired on the order and the fulfillment, NOT the invoice", async (t) => {
  for (
    const [name, schema, make] of [
      ["order", OrderSchema, order],
      ["fulfillment", FulfillmentSchema, fulfillment],
    ] as const
  ) {
    await t.step(`${name}: the joined document is accepted (control)`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [divider(DIV_A)] };
      assertEquals(schema.safeParse(doc).success, true);
    });

    await t.step(`${name}: a divider with no pair is refused, at items`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [divider(DIV_A), divider(DIV_B)] };
      assertEquals(refusedAt(schema.safeParse(doc), ["items"]), true);
    });

    await t.step(`${name}: a pair with no divider is refused, at that pair's uid`, () => {
      const doc = { ...withPairs(make(), [DIV_A, DIV_B]), items: [divider(DIV_A)] };
      assertEquals(refusedAt(schema.safeParse(doc), ["destinations", 1, "uid"]), true);
    });

    await t.step(`${name}: no dividers and one pair is accepted`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [] };
      assertEquals(schema.safeParse(doc).success, true);
    });
  }

  await t.step("invoice: the SAME divider-less mismatch is NOT refused by the schema", () => {
    // Invoices are excluded on purpose — scoped to what they bill. The API's
    // write guard applies the shared function to them at write time instead.
    const doc = { ...invoice(), destinations: invoicePairs([DIV_A, DIV_B]), items: [divider(DIV_A)] };
    const result = InvoiceSchema.safeParse(doc);
    assertEquals(result.success, true, JSON.stringify(result.error?.issues));
  });
});

/** A stored order line at `path` with an explicit quantity (`getTestDoc` mints 0). */
const line = (uid: string, path: string[], quantity: number, zero_priced: boolean | null = null) =>
  getTestDoc(OrderDocLineItem, { uid, type: "sale", path, quantity, zero_priced });

Deno.test("zeroQuantityComponents: only a COMPONENT at quantity 0", async (t) => {
  const parent = line(PARENT, [DIV_A, PARENT], 1);

  await t.step("a component at 0 is reported at its index", () => {
    const found = zeroQuantityComponents([divider(DIV_A), parent, line(CHILD, [DIV_A, PARENT, CHILD], 0)]);
    assertEquals(found.map((f) => [f.index, f.uid, f.parentType]), [[2, CHILD, "sale"]]);
  });

  await t.step("the same component at 1 is not (control)", () => {
    assertEquals(zeroQuantityComponents([divider(DIV_A), parent, line(CHILD, [DIV_A, PARENT, CHILD], 1)]), []);
  });

  await t.step("a TOP-LEVEL line at 0 is not a component and is not reported", () => {
    assertEquals(zeroQuantityComponents([divider(DIV_A), line(PARENT, [DIV_A, PARENT], 0)]), []);
  });

  await t.step("a line whose parent resolves to nothing is left to the parentage check", () => {
    assertEquals(zeroQuantityComponents([line(CHILD, [DIV_A, PARENT, CHILD], 0)]), []);
  });
});

Deno.test("checkZeroQuantityComponents: the stored order and BOTH inputs refuse it; fulfillment and invoice do not", async (t) => {
  const items = (childQty: number) => [
    divider(DIV_A),
    line(PARENT, [DIV_A, PARENT], 1),
    line(CHILD, [DIV_A, PARENT, CHILD], childQty, false), // a component must STATE the flag (core#100)
  ];

  await t.step("stored order: refused at the component's quantity, accepted at 1 (control)", () => {
    const base = withPairs(order(), [DIV_A]);
    assertEquals(OrderSchema.safeParse({ ...base, items: items(1) }).success, true);
    assertEquals(refusedAt(OrderSchema.safeParse({ ...base, items: items(0) }), ["items", 2, "quantity"]), true);
  });

  // Input lines: the stored line minus its computed keys is not needed — the
  // input line arm is non-strict, so a stored line parses through it.
  const inputItems = (childQty: number) => items(childQty).map((i) => i.type === "destination" ? i : OrderItemLine.parse(i));

  await t.step("CreateOrderInput and UpdateOrderInput: refused at 0, accepted at 1", () => {
    const create = (childQty: number) =>
      CreateOrderInput.safeParse({
        uid: "testorder00000000001",
        organization: { uid: "testorg0000000000001" },
        status: "draft",
        destinations: [{ ...getTestDoc(OrderSchema, { uid: "x0000000000000000001", ...stamps }, NOW).destinations[0], uid: DIV_A }],
        items: inputItems(childQty),
      });
    assertEquals(create(1).success, true, JSON.stringify(create(1).error?.issues));
    assertEquals(refusedAt(create(0), ["items", 2, "quantity"]), true);

    const update = (childQty: number) => UpdateOrderInput.safeParse({ version: 0, items: inputItems(childQty) });
    assertEquals(update(1).success, true);
    assertEquals(refusedAt(update(0), ["items", 2, "quantity"]), true);
  });

  await t.step("the fulfillment and the invoice keep their zero-quantity components (kept ancestors)", () => {
    // A kept kit ancestor sits at quantity 0 and can itself be a component, so
    // the fulfillment must not carry the refinement — pinned so it is not added.
    const rows = <T>(mk: (uid: string, path: string[], quantity: number, zero_priced: boolean | null) => T) => [
      divider(DIV_A),
      mk(PARENT, [DIV_A, PARENT], 1, null),
      mk(CHILD, [DIV_A, PARENT, CHILD], 0, false),
    ];
    const fulfillmentItems = rows((uid, path, quantity, zero_priced) =>
      getTestDoc(FulfillmentItem, { uid, type: "sale", path, quantity, zero_priced })
    );
    const invoiceItems = rows((uid, path, quantity, zero_priced) =>
      getTestDoc(InvoiceDocLineItem, { uid, type: "sale", path, quantity, zero_priced })
    );
    const f = FulfillmentSchema.safeParse({ ...withPairs(fulfillment(), [DIV_A]), items: fulfillmentItems });
    assertEquals(f.success, true, JSON.stringify(f.error?.issues));
    const i = InvoiceSchema.safeParse({ ...invoice(), destinations: invoicePairs([DIV_A]), items: invoiceItems });
    assertEquals(i.success, true, JSON.stringify(i.error?.issues));
  });
});
