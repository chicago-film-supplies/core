import { assert, assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { ACCEPTS_PAYMENT_STATUSES, canOperatorTransition, CreateInvoiceInput, INVOICE_STATUS_CONTRACTS, InvoiceDocLineItemSchema, InvoiceDocOrderItem, InvoiceSchema, type InvoiceStatusType, LIVE_IN_XERO_STATUSES, REACHED_XERO_STATUSES, SETTLED_STATUSES, UpdateInvoiceInput } from "../src/schemas/invoice.ts";
import { derivePaymentStatus } from "../src/utils/invoices.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

// `uid_thread` is a branded `ThreadId`; the schema walk seeds string leaves as
// `""`, which it rejects. Supply a real id, as every prod doc carries one.
const invoiceBase = { ...getInitialValues(InvoiceSchema), uid_thread: "testthread0000000001" } as Record<string, unknown>;
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
  // The pair's identity — its destination divider's uid. See the twin in
  // `tests/order.test.ts`.
  uid: "11111111-1111-4111-8111-111111111111",
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
  date: "2026-03-01T00:00:00.000-06:00",
  date_fs: mockTimestamp,
  due_date_fs: mockTimestamp,
  organization: {
    uid: "testorg1000000000000",
    name: "Acme Corp",
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
      base_cents: 50000,
      chargeable_days: 5,
      subtotal_cents: 50000,
      subtotal_discounted_cents: 50000,
      total_cents: 50000,
    },
  }],
  totals: {
    ...totalsBase,
    subtotal_cents: 50000,
    subtotal_discounted_cents: 50000,
    total_cents: 50000,
    amount_due_cents: 50000,
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
      amount_paid_cents: 25000,
      amount_due_cents: 25000,
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
        amount_cents: 1500,
      }],
      total_cents: 51500,
      amount_due_cents: 51500,
    },
  };
  assertEquals(InvoiceSchema.safeParse(doc).success, true);
});

Deno.test("CreateInvoiceInput accepts valid input", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);
});

Deno.test("CreateInvoiceInput requires at least one order", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: [],
    organization: { uid: "org10000000000000000" },
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, false);
});

Deno.test("CreateInvoiceInput accepts items with path and destination fields", () => {
  const input = {
    uid: "newinv10000000000000",
    query_by_orders: ["order100000000000000"],
    organization: { uid: "org10000000000000000" },
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Venue" },
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
          base_cents: 20000,
          formula: "fixed",
          subtotal_cents: 40000,
          subtotal_discounted_cents: 40000,
          total_cents: 40000,
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
    items: [
      { uid: "orderdiv100000000000", type: "order", name: "Order #1001" },
      { uid: "dest1000000000000000", type: "destination", name: "Venue", path: ["orderdiv100000000000"] },
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
    items: [{ uid: "order100000000000000", type: "order", name: "Order #1", quantity: 2, price: { base_cents: 1000 } }],
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
      price: { base_cents: 10000, subtotal_cents: 10000, total_cents: 10900 },
      xero_id: "550e8400-e29b-41d4-a716-446655440099",
      crms_id: 4021,
    }],
  });
  assertEquals(ok.success, true);
  const item = (ok.data as unknown as { items: Array<Record<string, unknown>> }).items[0];
  assertEquals(item.xero_id, undefined);
  assertEquals(item.crms_id, undefined);
  // The computed half of the price is stripped too — this path recomputes.
  assertEquals((item.price as Record<string, unknown>).subtotal_cents, undefined);
});

Deno.test("UpdateInvoiceInput: percent_of_total is inexpressible on an input line", () => {
  const bad = UpdateInvoiceInput.safeParse({
    version: 1,
    items: [{ uid: "item1000000000000000", type: "rental", price: { base_percent: 3, formula: "percent_of_total" } }],
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
    withTotals({ total_cents: 100000, amount_paid_cents: 40000, amount_credited_cents: 10000, amount_due_cents: 40000 }),
  );
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["totals", "amount_due_cents"]);
});

Deno.test("the identity refine accepts a fully-credited invoice", () => {
  // #1301's shape: billed 18,196 / collected 16,000 / wrote off 2,196.
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total_cents: 1_819_600, amount_paid_cents: 1_600_000, amount_credited_cents: 219_600, amount_due_cents: 0 }),
    ).success,
    true,
  );
});

Deno.test("the identity refine accepts a credit with ZERO cash — #1322's shape", () => {
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total_cents: 449_562, amount_paid_cents: 0, amount_credited_cents: 449_562, amount_due_cents: 0 }),
    ).success,
    true,
  );
});

Deno.test("the identity refine is EXACT — there is no tolerance left to tolerate", () => {
  // ⚠️ **This test replaces one that could not survive the migration**, and
  // deleting rather than converting it is the point.
  //
  // It used to read *"tolerates a half-cent, not a whole one"* and asserted
  // that `amount_paid_cents: 100_000` against a `total_cents: 100_000` parsed clean, because
  // the refine allowed `<= 0.005`. Scaled by 100 that fixture is 99,999.6
  // cents — not an integer, so it is unrepresentable as an `amount_paid_cents`
  // and `z.int()` rejects it before the refine is ever reached. A mechanical
  // ×100 pass would have produced a test that still passed, for a reason with
  // nothing to do with the identity it claims to check.
  //
  // The half-cent gap it was written to permit is now unrepresentable by
  // construction, so what is left to assert is the identity itself: exact, and
  // a one-cent gap — the smallest gap that can still exist — is rejected.
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total_cents: 100_000, amount_paid_cents: 100_000, amount_due_cents: 0 }),
    ).success,
    true,
  );
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total_cents: 100_000, amount_paid_cents: 99_999, amount_due_cents: 0 }),
    ).success,
    false,
    "a one-cent gap is a real projection defect and must not parse",
  );
  // And a non-integer cent count cannot even reach the refine.
  assertEquals(
    InvoiceSchema.safeParse(
      withTotals({ total_cents: 100_000, amount_paid_cents: 99_999.6, amount_due_cents: 0 }),
    ).success,
    false,
    "amount_paid_cents is z.int() — a fractional cent is not a representable amount",
  );
});

Deno.test("VOID is NOT exempt any more — the identity holds on all four buckets (#436)", () => {
  // The inverse of the test this replaces. That one asserted a void invoice
  // could carry `paid 0 / credited 0 / due 0` against a 247,000 total, because
  // `amount_due_cents` was FORCED to zero by the void writer while the journal
  // still folded to `total`. The exemption is what made the class invisible: an
  // invoice voided by a path that never zeroed the balance parsed exactly as
  // cleanly as one that had, and 7 prod invoices sat that way.
  //
  // A void is now a `void` settlement summing into `amount_void_cents`, so the
  // 0 is DERIVED and the status has stopped participating in the arithmetic.
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({ total_cents: 247_000, amount_paid_cents: 0, amount_credited_cents: 0, amount_due_cents: 0 }),
      status: "void",
    }).success,
    false,
    "a void invoice with no void bucket is now a projection defect, not an exempt shape",
  );

  // The shape the journal actually produces: the whole total in the void bucket.
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({
        total_cents: 247_000,
        amount_paid_cents: 0,
        amount_credited_cents: 0,
        amount_void_cents: 247_000,
        amount_due_cents: 0,
      }),
      status: "void",
    }).success,
    true,
  );

  // And `status` is not a lever on the identity in EITHER direction — the same
  // numbers parse on an issued invoice, because what balances the books is the
  // journal, not the status word. (Reaching this state on a live `issued`
  // invoice would take a void row without the status move, which is a real
  // defect the audit reports; the schema's job here is the arithmetic.)
  assertEquals(
    InvoiceSchema.safeParse({
      ...withTotals({
        total_cents: 247_000,
        amount_paid_cents: 0,
        amount_credited_cents: 0,
        amount_void_cents: 247_000,
        amount_due_cents: 0,
      }),
      status: "issued",
    }).success,
    true,
  );
});

Deno.test("amount_void is OPTIONAL, so every pre-#436 invoice still parses", () => {
  // The field postdates the corpus. A stored invoice with no void bucket at all
  // must still satisfy the identity through the other three, or the deploy that
  // drops the void exemption makes ~1,000 historical invoices unwritable.
  const { amount_void_cents: _drop, ...totalsWithout } = {
    ...validInvoice.totals,
    total_cents: 100_000,
    amount_paid_cents: 60_000,
    amount_credited_cents: 0,
    amount_due_cents: 40_000,
    amount_void_cents: undefined,
  };
  assertEquals(
    InvoiceSchema.safeParse({ ...validInvoice, totals: totalsWithout }).success,
    true,
  );
});

Deno.test("amount_credited is OPTIONAL, so the 962 pre-migration invoices still parse", () => {
  const { amount_credited_cents: _drop, ...totalsWithout } = {
    ...validInvoice.totals,
    total_cents: 100000,
    amount_paid_cents: 60000,
    amount_due_cents: 40000,
    amount_credited_cents: undefined,
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
      ...withTotals({ total_cents: 50000, amount_paid_cents: 50000, amount_due_cents: 0 }),
      payments: [{
        uid: "0195f3a1-0000-7000-8000-000000000002",
        xero_payment_id: "xp-1",
        date: "2026-03-01T00:00:00.000-06:00",
        amount_cents: 50000,
        reference: null,
        status: "active",
      }],
    }).success,
    false,
  );
  // …and the same document without it still parses, so the rejection is about
  // `payments` and not about the fixture drifting.
  assertEquals(
    InvoiceSchema.safeParse(withTotals({ total_cents: 50000, amount_paid_cents: 50000, amount_due_cents: 0 })).success,
    true,
  );
});

// ── INVOICE_STATUS_CONTRACTS ────────────────────────────────────
//
// Five hand-written status sets across four repos collapse onto this table's
// columns. The tests below assert what the `Readonly<Record<…>>` annotation
// cannot: the annotation forces every status to answer every column, but it
// says nothing about whether the ANSWERS are coherent.

Deno.test("every operator transition table row is transcribed, not imported", () => {
  // Deliberately a hand-written second statement of the same facts. Importing
  // the table and deriving the expectation from it would make this test agree
  // with the table wherever the table moved — the fixed-point trap this
  // campaign exists to remove. It is a golden: any edit here must be a
  // deliberate one, made in two places.
  const expected: Record<string, string[]> = {
    draft: ["issued", "void"],
    issued: ["void"],
    part_paid: ["void"],
    paid: ["void"],
    void: [], // terminal
  };
  for (const [from, tos] of Object.entries(expected)) {
    assertEquals(
      [...INVOICE_STATUS_CONTRACTS[from as InvoiceStatusType].operator_moves],
      tos,
      `operator_moves drifted for "${from}"`,
    );
  }
  assertEquals(Object.keys(INVOICE_STATUS_CONTRACTS).sort(), Object.keys(expected).sort());
});

Deno.test("live in Xero implies reached Xero — and the two differ on exactly `void`", () => {
  // The pair that looked like duplicates for as long as they were separate
  // constants. If they ever coincide, one of them has lost its reason to exist
  // and the collapse that was refused should be revisited deliberately.
  const live: string[] = [];
  const reached: string[] = [];
  for (const [status, c] of Object.entries(INVOICE_STATUS_CONTRACTS)) {
    if (c.live_in_xero) live.push(status);
    if (c.reached_xero) reached.push(status);
    assertEquals(!c.live_in_xero || c.reached_xero, true, `${status}: live but never reached`);
  }
  assertEquals(reached.filter((s) => !live.includes(s)), ["void"]);
});

Deno.test("a settled invoice accepts no further payment", () => {
  // `paid` and `void` are both frozen; the failure this forbids is a payment
  // recorded against a fully-settled invoice, which drives `amount_due`
  // negative and lets `derivePaymentStatus` re-derive `paid` from it — the
  // overpayment absorbed silently.
  for (const [status, c] of Object.entries(INVOICE_STATUS_CONTRACTS)) {
    assertEquals(!c.settled || !c.accepts_payment, true, `${status}: settled and still paying`);
  }
  // …and `paid` is settled while `issued`/`part_paid` are not, so the
  // implication above is not vacuously satisfied by an all-false column.
  assertEquals(INVOICE_STATUS_CONTRACTS.paid.settled, true);
  assertEquals(INVOICE_STATUS_CONTRACTS.issued.settled, false);
  assertEquals(INVOICE_STATUS_CONTRACTS.part_paid.accepts_payment, true);
});

Deno.test("`void` is terminal and nothing reaches it from itself", () => {
  assertEquals([...INVOICE_STATUS_CONTRACTS.void.operator_moves], []);
  assertEquals(canOperatorTransition("void", "issued"), false);
  assertEquals(canOperatorTransition("void", "draft"), false);
  assertEquals(canOperatorTransition("void", "paid"), false);
  assertEquals(canOperatorTransition("void", "part_paid"), false);
  assertEquals(canOperatorTransition("void", "void"), false);
});

Deno.test("canOperatorTransition answers false for a status outside the vocabulary", () => {
  // The `"voided"` class: a string that is not a member of the enum must not
  // throw on an undefined lookup, and must not read as permission either.
  assertEquals(canOperatorTransition("voided", "void"), false);
  assertEquals(canOperatorTransition("draft", "voided"), false);
  assertEquals(canOperatorTransition("", ""), false);
  // Non-vacuity: the function does say yes to something.
  assertEquals(canOperatorTransition("draft", "issued"), true);
});

Deno.test("each derived status list matches its column and none is empty", () => {
  const from = (col: "reached_xero" | "live_in_xero" | "settled" | "accepts_payment") =>
    (Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[])
      .filter((s) => INVOICE_STATUS_CONTRACTS[s][col]).sort();
  assertEquals([...REACHED_XERO_STATUSES].sort(), from("reached_xero"));
  assertEquals([...LIVE_IN_XERO_STATUSES].sort(), from("live_in_xero"));
  assertEquals([...SETTLED_STATUSES].sort(), from("settled"));
  assertEquals([...ACCEPTS_PAYMENT_STATUSES].sort(), from("accepts_payment"));
  // An empty list would silently disable whatever query consumes it — a
  // `not-in []` filter matches everything, which is how the `"voided"` defect
  // behaved. Pin the memberships that queries actually depend on.
  assertEquals([...SETTLED_STATUSES].sort(), ["paid", "void"]);
  assertEquals([...LIVE_IN_XERO_STATUSES].sort(), ["issued", "paid", "part_paid"]);
  assertEquals([...ACCEPTS_PAYMENT_STATUSES].sort(), ["issued", "part_paid"]);
  assertEquals([...REACHED_XERO_STATUSES].sort(), ["issued", "paid", "part_paid", "void"]);
});

Deno.test("derivePaymentStatus never leaves a terminal status, and never invents one", () => {
  // The status writer that legitimately moves OUTSIDE `operator_moves` — which
  // is why the column is named for the operator and not for legality. Pinned
  // here so a future reader who applies `operator_moves` to this path finds a
  // red test rather than a broken Xero void.
  assertEquals(derivePaymentStatus("draft", 500, 0), "draft");
  assertEquals(derivePaymentStatus("void", 0, 500), "void");
  assertEquals(derivePaymentStatus("issued", 0, 500), "issued");
  assertEquals(derivePaymentStatus("issued", 100, 400), "part_paid");
  assertEquals(derivePaymentStatus("issued", 500, 0), "paid");
  // `issued → part_paid` and `issued → paid` are BOTH absent from
  // `operator_moves.issued`, and both are correct here.
  assertEquals(INVOICE_STATUS_CONTRACTS.issued.operator_moves.includes("part_paid"), false);
  assertEquals(INVOICE_STATUS_CONTRACTS.issued.operator_moves.includes("paid"), false);
});

Deno.test("UpdateInvoiceInput.due_date: null is the clear verb, \"\" is still not", async (t) => {
  // manager#326 — the control cleared to `""`, which fails `chicagoStartOfDay()`,
  // so the store aborted before any request and the field showed an error
  // indicator with no message. The repair is a null arm, NOT a looser string:
  // `""` has to stay rejected or the same silent-abort path reopens for an
  // operator who types and deletes a character.
  const base = { version: 1 };
  const cases: Array<[string, unknown, boolean]> = [
    ["null clears", null, true],
    ["absent preserves", undefined, true],
    ["a Chicago start-of-day is accepted", "2026-08-23T00:00:00.000-05:00", true],
    ["empty string is rejected", "", false],
    ["a bare calendar date is rejected", "2026-08-23", false],
  ];
  for (const [label, value, expected] of cases) {
    await t.step(label, () => {
      const input = value === undefined ? base : { ...base, due_date: value };
      assertEquals(UpdateInvoiceInput.safeParse(input).success, expected);
    });
  }

  // The clear arm has to survive to the consumer as a distinguishable value —
  // `null` and "absent" mean different things on this input and a parse that
  // collapsed one into the other would make the verb unreadable.
  const cleared = UpdateInvoiceInput.safeParse({ ...base, due_date: null });
  assert(cleared.success);
  assertEquals(cleared.data.due_date, null);
  assertEquals("due_date" in cleared.data, true);
  const untouched = UpdateInvoiceInput.safeParse(base);
  assert(untouched.success);
  assertEquals(untouched.data.due_date, undefined);
});

Deno.test("Invoice.due_date is NOT nullable — the clear verb is wire-only", () => {
  // The asymmetry is deliberate and load-bearing. A cleared invoice loses both
  // `due_date` and `due_date_fs` rather than storing null, which is already a
  // reachable shape: `createInvoice` (`api-cloudrun/src/services/invoices.ts`)
  // writes neither key when no due date is supplied. Storing null instead would
  // put an explicit null on an `int64` Typesense field
  // (`schemas/typesense/invoices.ts` declares `due_date_fs` optional), which
  // nothing in either corpus has ever exercised — `translateObject` passes null
  // through verbatim and only geopoints are special-cased.
  //
  // If that decision is ever revisited, this test is the thing that has to
  // change first, and the Typesense question is what it has to answer.
  const shape = (InvoiceSchema as unknown as { _zod: { def: { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> } } })
    ._zod.def.shape;
  assertEquals(shape.due_date.safeParse(null).success, false);
  assertEquals(shape.due_date.safeParse(undefined).success, true);
  assertEquals(shape.due_date_fs.safeParse(null).success, false);
  assertEquals(shape.due_date_fs.safeParse(undefined).success, true);
});
