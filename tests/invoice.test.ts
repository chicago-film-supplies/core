import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/initial.ts";
import { CreateInvoiceInput, InvoiceDocLineItemSchema, InvoiceSchema, UpdateInvoiceInput, UpdatePaymentInput } from "../src/invoice.ts";
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
  uid_order: "test-order-1",
  dates: validDocDates,
  delivery: { uid: null, address: null, instructions: null, contact: null },
  collection: { uid: null, address: null, instructions: null, contact: null },
};

const validInvoice = {
  ...invoiceBase,
  uid: "test-inv-1",
  number: 1001,
  status: "draft",
  query_by_orders: ["test-order-1"],
  number_orders: [1000],
  tax_profile: "tax_applied",
  date: "2026-03-01T00:00:00.000-06:00",
  date_fs: mockTimestamp,
  due_date_fs: mockTimestamp,
  organization: {
    uid: "test-org-1",
    name: "Acme Corp",
    tax_profile: "tax_applied",
    xero_id: null,
    billing_address: null,
  },
  destinations: [validDestination],
  items: [{
    ...lineItemBase,
    uid: "item-1",
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
  created_by: { uid: "test-user-1", name: "Test User" },
  updated_by: { uid: "test-user-1", name: "Test User" },
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

Deno.test("InvoiceSchema accepts payments", () => {
  const doc = {
    ...validInvoice,
    status: "part_paid",
    payments: [{
      uid: "pay-1",
      xero_payment_id: "xero-pay-1",
      date: "2026-03-15T00:00:00Z",
      amount: 250,
      reference: "CHK-001",
      status: "active",
    }],
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
      path: ["dest-1", "group-1"],
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
        uid_delivery: "del-1",
        uid_collection: "col-1",
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
        uid_delivery: "del-1",
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
        uid: "fee-1",
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
    uid: "new-inv-1",
    query_by_orders: ["order-1"],
    organization: { uid: "org-1" },
    tax_profile: "tax_applied",
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);
});

Deno.test("CreateInvoiceInput requires at least one order", () => {
  const input = {
    uid: "new-inv-1",
    query_by_orders: [],
    organization: { uid: "org-1" },
    tax_profile: "tax_applied",
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, false);
});

Deno.test("CreateInvoiceInput accepts items with path and destination fields", () => {
  const input = {
    uid: "new-inv-1",
    query_by_orders: ["order-1"],
    organization: { uid: "org-1" },
    tax_profile: "tax_applied",
    items: [
      { uid: "dest-1", type: "destination", name: "Venue", uid_delivery: "del-1", uid_collection: "col-1" },
      { uid: "group-1", type: "group", name: "Lighting" },
      { uid: "item-1", type: "rental", name: "Spot Light", path: ["dest-1", "group-1"] },
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
        uid_order: "order-1",
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

Deno.test("InvoiceSchema accepts full multi-order hierarchy", () => {
  const doc = {
    ...validInvoice,
    query_by_orders: ["order-1", "order-2"],
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440010",
        type: "order",
        name: "Order #1001",
        uid_order: "order-1",
        description: "",
      },
      {
        uid: "550e8400-e29b-41d4-a716-446655440001",
        type: "destination",
        name: "Main Venue",
        uid_delivery: "del-1",
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
        uid_order: "order-2",
        description: "",
      },
      {
        ...lineItemBase,
        uid: "item-2",
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
    uid: "new-inv-1",
    query_by_orders: ["order-1"],
    organization: { uid: "org-1" },
    tax_profile: "tax_applied",
    items: [
      { uid: "order-div-1", type: "order", name: "Order #1001", uid_order: "order-1" },
      { uid: "dest-1", type: "destination", name: "Venue", uid_delivery: "del-1", path: ["order-div-1"] },
      { uid: "item-1", type: "rental", name: "Spot Light", path: ["order-div-1", "dest-1"] },
    ],
  };
  assertEquals(CreateInvoiceInput.safeParse(input).success, true);
});

Deno.test("UpdateInvoiceInput requires version", () => {
  const input = { status: "issued" };
  assertEquals(UpdateInvoiceInput.safeParse(input).success, false);
  assertEquals(UpdateInvoiceInput.safeParse({ ...input, version: 1 }).success, true);
});

Deno.test("UpdatePaymentInput requires version", () => {
  assertEquals(UpdatePaymentInput.safeParse({ reference: "CHK #42" }).success, false);
  assertEquals(
    UpdatePaymentInput.safeParse({ reference: "CHK #42", version: 1 }).success,
    true,
  );
});

Deno.test("UpdatePaymentInput accepts all whitelisted fields", () => {
  const input = {
    date: "2026-04-23T00:00:00.000-05:00",
    amount: 150.25,
    reference: "wire",
    status: "active" as const,
    version: 3,
  };
  assertEquals(UpdatePaymentInput.safeParse(input).success, true);
});

Deno.test("UpdatePaymentInput rejects zero and negative amounts", () => {
  assertEquals(UpdatePaymentInput.safeParse({ amount: 0, version: 0 }).success, false);
  assertEquals(UpdatePaymentInput.safeParse({ amount: -5, version: 0 }).success, false);
});

Deno.test("UpdatePaymentInput normalizes date to Chicago offset form", () => {
  const parsed = UpdatePaymentInput.safeParse({
    date: "2026-04-23T12:00:00.000Z",
    version: 0,
  });
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data.date, "2026-04-23T00:00:00.000-05:00");
  }
});

Deno.test("UpdatePaymentInput strips unknown fields (xero_payment_id/uid/synced_at)", () => {
  const parsed = UpdatePaymentInput.safeParse({
    reference: "ok",
    xero_payment_id: "forged",
    uid: "forged",
    synced_at: "forged",
    version: 0,
  });
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals("xero_payment_id" in parsed.data, false);
    assertEquals("uid" in parsed.data, false);
    assertEquals("synced_at" in parsed.data, false);
  }
});

Deno.test("UpdatePaymentInput restricts status to active/deleted", () => {
  assertEquals(UpdatePaymentInput.safeParse({ status: "active", version: 0 }).success, true);
  assertEquals(UpdatePaymentInput.safeParse({ status: "deleted", version: 0 }).success, true);
  assertEquals(UpdatePaymentInput.safeParse({ status: "pending", version: 0 }).success, false);
});
