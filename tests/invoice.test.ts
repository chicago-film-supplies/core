import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { CreateInvoiceInput, InvoiceDocLineItemSchema, InvoiceDocOrderItem, InvoiceSchema, UpdateInvoiceInput } from "../src/schemas/invoice.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const invoiceBase = getInitialValues(InvoiceSchema) as Record<string, unknown>;
const totalsBase = invoiceBase.totals as Record<string, unknown>;
const lineItemBase = getInitialValues(InvoiceDocLineItemSchema) as Record<string, unknown>;
const priceBase = (lineItemBase as { price: Record<string, unknown> }).price;

const validDocDates = {
  delivery_start: "2026-03-01T00:00:00.000-06:00",
  delivery_start_fs: mockTimestamp,
  delivery_end: "2026-03-01T00:00:00.000-06:00",
  delivery_end_fs: mockTimestamp,
  collection_start: "2026-03-10T00:00:00.000-06:00",
  collection_start_fs: mockTimestamp,
  collection_end: "2026-03-10T00:00:00.000-06:00",
  collection_end_fs: mockTimestamp,
  charge_start: "2026-03-01T00:00:00.000-06:00",
  charge_start_fs: mockTimestamp,
  charge_end: "2026-03-10T00:00:00.000-06:00",
  charge_end_fs: mockTimestamp,
  days_active: null,
  days_charged: null,
};

const validDestination = {
  uid_order: "testorder10000000000",
  dates: validDocDates,
  delivery: { uid: null, address: null, instructions: null, contact: null },
  collection: { uid: null, address: null, instructions: null, contact: null },
};

const validInvoice = {
  ...invoiceBase,
  uid: "testinv1000000000000",
  number: 1001,
  status: "draft",
  query_by_orders: ["testorder10000000000"],
  number_orders: [1000],
  tax_profile: "tax_applied",
  date: "2026-03-01T00:00:00.000-06:00",
  date_fs: mockTimestamp,
  due_date_fs: mockTimestamp,
  organization: {
    uid: "testorg1000000000000",
    name: "Acme Corp",
    tax_profile: "tax_applied",
    xero_id: null,
    billing_address: null,
  },
  destinations: [validDestination],
  items: [{
    ...lineItemBase,
    uid: "item1000000000000000",
    type: "rental",
    name: "Camera Rental",
    quantity: 1,
    price: {
      ...priceBase,
      base: 500,
      chargeable_days: 5,
      subtotal: 500,
      subtotal_discounted: 500,
      total: 500,
    },
  }],
  totals: {
    ...totalsBase,
    subtotal: 500,
    subtotal_discounted: 500,
    total: 500,
    amount_due: 500,
  },
  created_by: { uid: "testuser100000000000", name: "Test User" },
  updated_by: { uid: "testuser100000000000", name: "Test User" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("InvoiceSchema validates a complete document", () => {
  assertEquals(InvoiceSchema.safeParse(validInvoice).success, true);
});

Deno.test("InvoiceSchema allows empty destinations when query_by_orders is empty (standalone invoice)", () => {
  const doc = { ...validInvoice, query_by_orders: [], number_orders: [], destinations: [] };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema rejects empty destinations when query_by_orders is non-empty", () => {
  const doc = { ...validInvoice, destinations: [] };
  const result = InvoiceSchema.safeParse(doc);
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.error.issues[0].path.join("."), "destinations");
  }
});

Deno.test("InvoiceSchema rejects invalid status", () => {
  const doc = { ...validInvoice, status: "pending" };
  assertEquals(InvoiceSchema.safeParse(doc).success, false);
});

Deno.test("InvoiceSchema accepts part_paid and void statuses", () => {
  assertEquals(InvoiceSchema.safeParse({ ...validInvoice, status: "part_paid" }).success, true);
  assertEquals(InvoiceSchema.safeParse({ ...validInvoice, status: "void" }).success, true);
});

Deno.test("InvoiceSchema accepts optional fields", () => {
  const doc = {
    ...validInvoice,
    subject: "March rental",
    reference: "PO-123",
    external_notes: "Thanks!",
    internal_notes: null,
    due_date: "2026-04-01T00:00:00.000-05:00",
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema accepts legacy CRMS fields", () => {
  const doc = {
    ...validInvoice,
    crms_id: 500,
    crms_opportunity_ids: [100, 200],
    organization: {
      ...validInvoice.organization,
      crms_id: 100,
    },
    items: [{
      ...validInvoice.items[0],
      crms_opportunity_id: 100,
      crms_id: 42,
      price: {
        ...validInvoice.items[0].price,
        discount_percent: 0,
      },
    }],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema rejects removed legacy item-level tax_profile field", () => {
  const doc = {
    ...validInvoice,
    items: [{
      ...validInvoice.items[0],
      price: {
        ...validInvoice.items[0].price,
        tax_profile: "tax_chicago_rental_tax",
      },
    }],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, false);
});

Deno.test("InvoiceSchema carries settlement totals without a payments array", () => {
  // `payments[]` was deleted 2026-08-03. The totals it used to sit beside are
  // now derived from the `settlements` journal by `recomputeSettlementTotals`.
  const doc = {
    ...validInvoice,
    status: "part_paid",
    totals: {
      ...validInvoice.totals,
      amount_paid: 250,
      amount_due: 250,
    },
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema rejects additional properties", () => {
  const doc = { ...validInvoice, bogus: true };
  assertEquals(InvoiceSchema.safeParse(doc).success, false);
});

Deno.test("InvoiceSchema accepts line item with path", () => {
  const doc = {
    ...validInvoice,
    items: [{
      ...validInvoice.items[0],
      path: ["dest1000000000000000", "group100000000000000"],
    }],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema accepts group item in items array", () => {
  const doc = {
    ...validInvoice,
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440000",
        type: "group",
        name: "Lighting Package",
        description: "",
      },
      ...validInvoice.items,
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema accepts destination item in items array", () => {
  const doc = {
    ...validInvoice,
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440001",
        type: "destination",
        name: "Main Venue",
        uid_delivery: "del10000000000000000",
        uid_collection: "col10000000000000000",
        description: "",
      },
      ...validInvoice.items,
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema accepts mixed items (line + group + destination)", () => {
  const doc = {
    ...validInvoice,
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440001",
        type: "destination",
        name: "Main Venue",
        uid_delivery: "del10000000000000000",
        uid_collection: null,
        description: "",
      },
      {
        uid: "550e8400-e29b-41d4-a716-446655440000",
        type: "group",
        name: "Lighting Package",
        description: "",
      },
      {
        ...validInvoice.items[0],
        path: ["550e8400-e29b-41d4-a716-446655440001", "550e8400-e29b-41d4-a716-446655440000"],
      },
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("InvoiceSchema accepts transaction_fees in totals", () => {
  const doc = {
    ...validInvoice,
    totals: {
      ...validInvoice.totals,
      transaction_fees: [{
        uid: "fee10000000000000000",
        name: "Credit Card Fee",
        rate: 3,
        type: "percent",
        amount: 15,
      }],
      total: 515,
      amount_due: 515,
    },
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("CreateInvoiceInput accepts valid input", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);
});

Deno.test("CreateInvoiceInput requires at least one order", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: [],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, false);
});

Deno.test("CreateInvoiceInput accepts items with path and destination fields", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Venue", uid_delivery: "del10000000000000000", uid_collection: "col10000000000000000" },
      { uid: "group100000000000000", type: "group", name: "Lighting" },
      { uid: "item1000000000000000", type: "rental", name: "Spot Light", path: ["dest1000000000000000", "group100000000000000"] },
    ],
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);
});

Deno.test("InvoiceSchema accepts order divider item in items array", () => {
  const doc = {
    ...validInvoice,
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440002",
        type: "order",
        name: "Order #1001",
        description: "",
      },
      {
        ...validInvoice.items[0],
        path: ["550e8400-e29b-41d4-a716-446655440002"],
      },
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

// Option B (Phase A relaxation): the order divider's uid is the source order's
// Firestore doc-id (NOT a uuid) and carries no uid_order. This doc would FAIL
// under the pre-A schema (uid: z.uuid() + uid_order required) and must pass now.
Deno.test("InvoiceSchema accepts an Option-B order divider: Firestore-id uid, no uid_order", () => {
  const doc = {
    ...validInvoice,
    items: [
      {
        uid: "k7Hq2mNpQ4rStUvWxYz0",
        type: "order",
        name: "Order #1001",
        path: [],
        description: "",
      },
      {
        ...validInvoice.items[0],
        path: ["k7Hq2mNpQ4rStUvWxYz0"],
      },
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

// Phase D: uid_order is removed from the order-divider doc schema. A divider
// still carrying it is rejected — strictObject surfaces unrecognized_keys on the
// bare member (InvoiceSchema.items is a plain union, so its top-level code would
// be invalid_union instead — assert against the member to pin the real reason).
Deno.test("InvoiceDocOrderItem rejects a uid_order key (Phase D: field removed)", () => {
  const result = InvoiceDocOrderItem.safeParse({
    uid: "order100000000000000",
    type: "order",
    name: "Order #1001",
    path: [],
    uid_order: "order100000000000000",
    description: "",
  });
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.error.issues[0].code, "unrecognized_keys");
  }
});

Deno.test("InvoiceSchema accepts full multi-order hierarchy", () => {
  const doc = {
    ...validInvoice,
    query_by_orders: ["order100000000000000", "order-2"],
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440010",
        type: "order",
        name: "Order #1001",
        description: "",
      },
      {
        uid: "550e8400-e29b-41d4-a716-446655440001",
        type: "destination",
        name: "Main Venue",
        uid_delivery: "del10000000000000000",
        uid_collection: null,
        description: "",
      },
      {
        ...validInvoice.items[0],
        path: ["550e8400-e29b-41d4-a716-446655440010", "550e8400-e29b-41d4-a716-446655440001"],
      },
      {
        uid: "550e8400-e29b-41d4-a716-446655440020",
        type: "order",
        name: "Order #1002",
        description: "",
      },
      {
        ...lineItemBase,
        uid: "item2000000000000000",
        type: "sale",
        name: "Tripod Sale",
        quantity: 2,
        price: {
          ...priceBase,
          base: 200,
          formula: "fixed",
          subtotal: 400,
          subtotal_discounted: 400,
          total: 400,
        },
        path: ["550e8400-e29b-41d4-a716-446655440020"],
      },
    ],
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("CreateInvoiceInput accepts order divider items", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
    items: [
      { uid: "orderdiv100000000000", type: "order", name: "Order #1001" },
      { uid: "dest1000000000000000", type: "destination", name: "Venue", uid_delivery: "del10000000000000000", path: ["orderdiv100000000000"] },
      { uid: "item1000000000000000", type: "rental", name: "Spot Light", path: ["orderdiv100000000000", "dest1000000000000000"] },
    ],
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);

  // The transitional `uid_order` this test used to carry is now rejected rather
  // than ignored. Phase D made the divider's identity the source order's uid;
  // the field has had no reader since, and the manager stopped sending it.
  const withRetiredField = {
    ...input,
    items: [{ ...input.items[0], uid_order: "order100000000000000" }],
  };
  assertEquals(CreateInvoiceInput.safeParse(withRetiredField).success, false);
});

Deno.test("UpdateInvoiceInput requires version", () => {
  const input = { status: "issued" };
  assertEquals(UpdateInvoiceInput.safeParse(input).success, false);
  assertEquals(UpdateInvoiceInput.safeParse({ ...input, version: 1 }).success, true);
});

// ── Invoice item input — the discriminated boundary ───────────────

Deno.test("CreateInvoiceInput: an item must declare its type", () => {
  // `type` was `.optional()`, which is why `buildInvoiceItems` carried two
  // `item.type ?? "rental"` defaults — defaulting an under-specified item into
  // the ONE type whose stored contract demands a `price.replacement`.
  const bad = CreateInvoiceInput.safeParse({
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
    items: [{ uid: "item1000000000000000", name: "Spot Light", quantity: 1 }],
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["items", 0, "type"]);
});

Deno.test("CreateInvoiceInput: a divider cannot carry a price or a quantity", () => {
  const bad = CreateInvoiceInput.safeParse({
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    tax_profile: "tax_applied",
    items: [{ uid: "order100000000000000", type: "order", name: "Order #1", quantity: 2, price: { base: 10 } }],
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].code, "unrecognized_keys");
});

Deno.test("UpdateInvoiceInput: a line ships back with its stored extras", () => {
  // Same asymmetry as the order side: the line arm strips, the divider arms
  // reject. A stored invoice line carries xero_id/crms_id/computed price fields.
  const ok = UpdateInvoiceInput.safeParse({
    version: 1,
    items: [{
      uid: "item1000000000000000",
      type: "rental",
      name: "Spot Light",
      quantity: 1,
      path: ["order100000000000000"],
      price: { base: 100, subtotal: 100, total: 109 },
      xero_id: "550e8400-e29b-41d4-a716-446655440099",
      crms_id: 4021,
    }],
  });
  assertEquals(ok.success, true);
  const item = (ok.data as unknown as { items: Array<Record<string, unknown>> }).items[0];
  assertEquals(item.xero_id, undefined);
  assertEquals(item.crms_id, undefined);
  // The computed half of the price is stripped too — this path recomputes.
  assertEquals((item.price as Record<string, unknown>).subtotal, undefined);
});

Deno.test("UpdateInvoiceInput: percent_of_total is inexpressible on an input line", () => {
  const bad = UpdateInvoiceInput.safeParse({
    version: 1,
    items: [{ uid: "item1000000000000000", type: "rental", price: { base: 10, formula: "percent_of_total" } }],
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["items", 0, "price", "formula"]);
});

Deno.test("CreateInvoiceInput: an invoice may still start with a line item", () => {
  // Unlike CreateOrderInput there is NO "first item must be a destination"
  // refine here, and there must not be: 28 prod invoices are flat CRMS invoices
  // that start with a line.
  assertEquals(
    CreateInvoiceInput.safeParse({
      uid: "newinv10000000000000",
      query_by_orders: ["order100000000000000"],
      organization: { uid: "org10000000000000000" },
      tax_profile: "tax_applied",
      items: [{ uid: "item1000000000000000", type: "service", name: "Delivery" }],
    }).success,
    true,
  );
});

// ── The three-term settlement identity ───────────────────────────
//
// `amount_paid + amount_credited + amount_due === total`. Shipped here rather
// than as a parnas Item 3 step, and with `void` exempt from the start —
// `markInvoiceVoidedFromXero` zeroes both amounts while keeping `total`, which
// is exactly the 4 corpus-wide violators, all of them void.

const withTotals = (t: Record<string, number>) => ({
  ...validInvoice,
  totals: { ...validInvoice.totals, ...t },
});

Deno.test("the identity refine rejects a three-term violation", () => {
  const bad = InvoiceSchema.safeParse(
    withTotals({ total: 1000, amount_paid: 400, amount_credited: 100, amount_due: 400 }),
  );
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["totals", "amount_due"]);
});

Deno.test("the identity refine accepts a fully-credited invoice", () => {
  // #1301's shape: billed 18,196 / collected 16,000 / wrote off 2,196.
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total: 18_196, amount_paid: 16_000, amount_credited: 2_196, amount_due: 0 }),
    ).success,
    true,
  );
});

Deno.test("the identity refine accepts a credit with ZERO cash — #1322's shape", () => {
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total: 4_495.62, amount_paid: 0, amount_credited: 4_495.62, amount_due: 0 }),
    ).success,
    true,
  );
});

Deno.test("the identity refine tolerates a half-cent, not a whole one", () => {
  assertEquals(
    InvoiceSchema.safeParse(withTotals({ total: 1000, amount_paid: 999.996, amount_due: 0 }))
      .success,
    true,
  );
  assertEquals(
    InvoiceSchema.safeParse(withTotals({ total: 1000, amount_paid: 999.98, amount_due: 0 }))
      .success,
    false,
  );
});

Deno.test("VOID is exempt, and that exemption is load-bearing", () => {
  // Without it every voided invoice becomes unwritable. This assertion is what
  // stops the exemption being removed later as "an obviously wrong special case".
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({ total: 2_470, amount_paid: 0, amount_credited: 0, amount_due: 0 }),
      status: "void",
    }).success,
    true,
  );
  // ...and the same numbers on a non-void invoice are still rejected, so the
  // exemption is narrow rather than a hole.
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({ total: 2_470, amount_paid: 0, amount_credited: 0, amount_due: 0 }),
      status: "issued",
    }).success,
    false,
  );
});

Deno.test("amount_credited is OPTIONAL, so the 962 pre-migration invoices still parse", () => {
  const { amount_credited: _drop, ...totalsWithout } = {
    ...validInvoice.totals,
    total: 1000,
    amount_paid: 600,
    amount_due: 400,
    amount_credited: undefined,
  };
  assertEquals(
    InvoiceSchema.safeParse({ ...validInvoice, totals: totalsWithout }).success,
    true,
  );
});

Deno.test("payments is REJECTED now — the strict object is what enforces the deletion", () => {
  // The inverse of the test this replaces. `payments[]` survived one beta purely
  // as parse tolerance, because a strictObject would have failed every
  // un-migrated invoice on its next write. `--drop-legacy` stripped the field
  // from all 967 prod / 968 dev invoices on 2026-08-02, so the same strictness
  // now runs the other way: an invoice cannot acquire a `payments` array again,
  // and a writer that tries gets a validation error rather than a silent second
  // settlement ledger.
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({ total: 500, amount_paid: 500, amount_due: 0 }),
      payments: [{
        uid: "0195f3a1-0000-7000-8000-000000000002",
        xero_payment_id: "xp-1",
        date: "2026-03-01T00:00:00.000-06:00",
        amount: 500,
        reference: null,
        status: "active",
      }],
    }).success,
    false,
  );
  // …and the same document without it still parses, so the rejection is about
  // `payments` and not about the fixture drifting.
  assertEquals(
    InvoiceSchema.safeParse(withTotals({ total: 500, amount_paid: 500, amount_due: 0 })).success,
    true,
  );
});
