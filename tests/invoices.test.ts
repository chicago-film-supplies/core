import { assertEquals } from "@std/assert";
import { getInitialValues, InvoiceDocLineItemSchema, InvoiceDocOrderItem, OrderDocDestinationItem, OrderDocGroupItem } from "../src/schemas/mod.ts";
import {
  buildInvoiceDestinationDivider,
  buildOrderScopedItems,
  calculateInvoiceTotals,
  carryForwardOverrides,
  computeInvoiceItemPaths,
  computeInvoiceSyncStatus,
  derivePaymentStatus,
  flattenForXero,
  getOrderScopedItems,
  getXeroUnitAmount,
  type InvoiceDestinationPair,
  type InvoiceItem,
  type LineItem,
  type Tax,
  recomputePaymentTotals,
  removeOrderScopedDestinations,
  removeOrderScopedItems,
  resyncInvoiceLines,
  syncObjectWithOverride,
  syncOrderDestinationsSelective,
  syncOrderItems,
  syncOrderToInvoiceSelective,
  syncScalarWithOverride,
  validateInvoiceItemPaths,
  validateInvoiceItemUniqueness,
} from "../src/utils/invoices.ts";
import type { FirestoreTimestampType, OrderDocDatesType } from "../src/schemas/mod.ts";

// Invoice destination pairs require per-destination dates; these sync helpers
// don't read them, so a zeroed doc-dates object satisfies the type.
const TS0 = { seconds: 0, nanoseconds: 0 } as FirestoreTimestampType;
const NO_DOC_DATES: OrderDocDatesType = {
  delivery_start: null, delivery_start_fs: TS0,
  delivery_end: null, delivery_end_fs: TS0,
  collection_start: null, collection_start_fs: TS0,
  collection_end: null, collection_end_fs: TS0,
  charge_start: null, charge_start_fs: TS0,
  charge_end: null, charge_end_fs: TS0,
  days_active: null, days_charged: null,
};

// ── Schema bases ────────────────────────────────────────────────

const lineItemBase = getInitialValues(InvoiceDocLineItemSchema) as Record<string, unknown>;
const priceBase = (lineItemBase as { price: Record<string, unknown> }).price;
const orderDividerBase = getInitialValues(InvoiceDocOrderItem) as Record<string, unknown>;

function makeItem(
  overrides: Partial<InvoiceItem> = {},
  priceOverrides: Record<string, unknown> = {},
): InvoiceItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      ...priceOverrides,
    },
  } as unknown as InvoiceItem;
}

// ── Valid id fixtures ───────────────────────────────────────────
// The strict Firestore-uid validators (@cfs/core/schemas _uid.ts) require:
//   - order/dest/group DIVIDER uids → UUID (OrderDocDestinationItem.uid /
//     OrderDocGroupItem.uid are z.uuid(); order divider uid is ItemUid, which
//     also accepts a UUID).
//   - line-item uids + every path[] segment → ItemUid (FirestoreId | uuid | custom-).
//   - uid_order / uid_delivery / uid_collection refs → FirestoreId ([A-Za-z0-9]{20}).
// Deterministic literals are preferred here: these are pure unit tests with no
// Firestore / parallel-DB collisions, so fixed valid ids stay readable.

// Order divider uids (ItemUid — UUID form).
const ORDER_DIV_1 = "00000000-0000-4000-8000-00000000d101";
const ORDER_DIV_2 = "00000000-0000-4000-8000-00000000d102";
// Destination divider uids (z.uuid()).
const DEST_1 = "00000000-0000-4000-8000-0000000de501";
const DEST_2 = "00000000-0000-4000-8000-0000000de502";
const DEST_9 = "00000000-0000-4000-8000-0000000de509";
// FirestoreId refs ([A-Za-z0-9]{20}).
const ORDER_ID_1 = "Order000000000000001";
const ORDER_ID_2 = "Order000000000000002";
const DEL_1 = "Delivery000000000001";
const DEL_2 = "Delivery000000000002";
const DEL_9 = "Delivery000000000009";
const DEL_10 = "Delivery000000000010";
const COL_1 = "Collection0000000001";
const COL_9 = "Collection0000000009";
// Line-item uids (ItemUid — FirestoreId form).
const ITEM_1 = "Item0000000000000001";
const ITEM_2 = "Item0000000000000002";
const ITEM_3 = "Item0000000000000003";
const ITEM_NEW = "ItemNew0000000000001";

// ── Test data ───────────────────────────────────────────────────

const orderDivider: InvoiceItem = {
  ...orderDividerBase,
  uid: ORDER_DIV_1,
  name: "Order #1001",
  uid_order: ORDER_ID_1,
} as InvoiceItem;

const destItem: InvoiceItem = {
  uid: DEST_1,
  type: "destination",
  name: "Main Venue",
  uid_delivery: DEL_1,
  uid_collection: null,
  path: [ORDER_DIV_1, DEST_1],
};

const lineItem1: InvoiceItem = {
  ...lineItemBase,
  uid: ITEM_1,
  type: "rental",
  name: "Spot Light",
  quantity: 2,
  price: {
    ...priceBase,
    base: 100,
    chargeable_days: 5,
    subtotal: 200,
    subtotal_discounted: 200,
    total: 200,
  },
  path: [ORDER_DIV_1, DEST_1, ITEM_1],
  coa_revenue: 4100,
  tracking_category: "rentals",
} as InvoiceItem;

const lineItem2: InvoiceItem = {
  ...lineItemBase,
  uid: ITEM_2,
  type: "sale",
  name: "Tripod",
  quantity: 1,
  price: {
    ...priceBase,
    base: 300,
    formula: "fixed",
    subtotal: 300,
    subtotal_discounted: 300,
    total: 300,
  },
  path: [ORDER_DIV_1, DEST_1, ITEM_2],
  xero_id: "00000000-0000-4000-8000-000000000123",
} as InvoiceItem;

const orderDivider2: InvoiceItem = {
  ...orderDividerBase,
  uid: ORDER_DIV_2,
  name: "Order #1002",
  uid_order: ORDER_ID_2,
} as InvoiceItem;

const lineItem3: InvoiceItem = {
  ...lineItemBase,
  uid: ITEM_3,
  type: "rental",
  name: "Camera",
  quantity: 1,
  price: {
    ...priceBase,
    base: 500,
    chargeable_days: 5,
    subtotal: 500,
    subtotal_discounted: 500,
    total: 500,
  },
  path: [ORDER_DIV_2, ITEM_3],
} as InvoiceItem;

const multiOrderInvoiceItems: InvoiceItem[] = [
  orderDivider,
  destItem,
  lineItem1,
  lineItem2,
  orderDivider2,
  lineItem3,
];

// ── flattenForXero ──────────────────────────────────────────────

Deno.test("flattenForXero removes destination, group, and order dividers", () => {
  const items: LineItem[] = [
    { type: "order", uid: "o1", name: "Order", path: [] },
    { type: "destination", uid: "d1", name: "Venue", path: [] },
    { type: "group", uid: "g1", name: "Lighting", path: [] },
    { type: "rental", uid: "i1", name: "Light", quantity: 1, path: [] },
    { type: "sale", uid: "i2", name: "Tripod", quantity: 1, path: [] },
  ];
  const result = flattenForXero(items);
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "i1");
  assertEquals(result[1].uid, "i2");
});

// ── getOrderScopedItems ─────────────────────────────────────────

Deno.test("getOrderScopedItems returns divider and children for order-div-1", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, ORDER_DIV_1);
  assertEquals(result.length, 4); // divider + dest + 2 line items
  assertEquals(result[0].uid, ORDER_DIV_1);
  assertEquals(result[1].uid, DEST_1);
  assertEquals(result[2].uid, ITEM_1);
  assertEquals(result[3].uid, ITEM_2);
});

Deno.test("getOrderScopedItems returns divider and children for order-div-2", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, ORDER_DIV_2);
  assertEquals(result.length, 2); // divider + 1 line item
  assertEquals(result[0].uid, ORDER_DIV_2);
  assertEquals(result[1].uid, ITEM_3);
});

Deno.test("getOrderScopedItems returns empty for unknown divider", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, "nonexistent");
  assertEquals(result.length, 0);
});

// ── removeOrderScopedItems ──────────────────────────────────────

Deno.test("removeOrderScopedItems removes order-div-1 scope, keeps order-div-2", () => {
  const result = removeOrderScopedItems(multiOrderInvoiceItems, ORDER_DIV_1);
  assertEquals(result.length, 2); // order-div-2 + item-3
  assertEquals(result[0].uid, ORDER_DIV_2);
  assertEquals(result[1].uid, ITEM_3);
});

Deno.test("removeOrderScopedItems removes order-div-2 scope, keeps order-div-1", () => {
  const result = removeOrderScopedItems(multiOrderInvoiceItems, ORDER_DIV_2);
  assertEquals(result.length, 4); // order-div-1 + dest + 2 line items
});

// ── buildOrderScopedItems ───────────────────────────────────────

Deno.test("buildOrderScopedItems prepends order divider uid to path", () => {
  const orderItems: LineItem[] = [
    { uid: "dest-1", type: "destination", name: "Venue", path: ["dest-1"] },
    { uid: "item-1", type: "rental", name: "Light", path: ["dest-1", "item-1"] },
    { uid: "item-2", type: "rental", name: "Camera", path: ["dest-1", "item-2"] },
  ];
  const result = buildOrderScopedItems(orderItems, "order-div-1");
  assertEquals(result[0].path, ["order-div-1", "dest-1"]);
  assertEquals(result[1].path, ["order-div-1", "dest-1", "item-1"]);
  assertEquals(result[2].path, ["order-div-1", "dest-1", "item-2"]);
});

Deno.test("buildOrderScopedItems projects order-only fields off line items", () => {
  // Order line item carrying every order-only field — must NOT leak to invoice shape.
  const orderItems: LineItem[] = [
    {
      uid: ITEM_1,
      type: "rental",
      name: "Light",
      quantity: 2,
      path: [DEST_1, ITEM_1],
      stock_method: "reserve",
      order_number: 1001,
      uid_order: ORDER_ID_1,
      zero_priced: false,
      uid_delivery: DEL_1,
      uid_collection: COL_1,
      // @ts-expect-error — inclusion_type not on LineItem type, but exists at runtime on OrderDocLineItem
      inclusion_type: "mandatory",
      price: {
        base: 100,
        chargeable_days: 5,
        formula: "five_day_week",
        subtotal: 200,
        subtotal_discounted: 200,
        discount: null,
        taxes: [],
        total: 200,
        replacement: 5000,
      },
    },
  ];
  const [projected] = buildOrderScopedItems(orderItems, ORDER_DIV_1);

  // Projected item passes strict invoice line-item schema — rejects any leaked key.
  const result = InvoiceDocLineItemSchema.safeParse(projected);
  assertEquals(result.success, true, JSON.stringify(result.success ? {} : result.error.issues, null, 2));

  // Projected price passes — rejects leaked `replacement`.
  const keys = Object.keys(projected).sort();
  assertEquals(
    keys.includes("stock_method") || keys.includes("order_number") || keys.includes("uid_order") ||
      keys.includes("inclusion_type") || keys.includes("zero_priced") || keys.includes("uid_delivery") ||
      keys.includes("uid_collection"),
    false,
    `leaked keys present: ${keys.join(", ")}`,
  );
  const priceKeys = Object.keys((projected as unknown as { price: Record<string, unknown> }).price);
  assertEquals(priceKeys.includes("replacement"), false, `leaked price.replacement: ${priceKeys.join(", ")}`);
});

Deno.test("buildOrderScopedItems preserves destination shape via OrderDocDestinationItem", () => {
  const destUid = crypto.randomUUID();
  const orderItems: LineItem[] = [
    {
      uid: destUid,
      type: "destination",
      name: "Main Venue",
      description: "first stop",
      uid_delivery: DEL_1,
      uid_collection: null,
      path: [destUid],
    },
  ];
  const [projected] = buildOrderScopedItems(orderItems, ORDER_DIV_1);
  const result = OrderDocDestinationItem.safeParse(projected);
  assertEquals(result.success, true, JSON.stringify(result.success ? {} : result.error.issues, null, 2));
});

Deno.test("buildOrderScopedItems preserves group shape via OrderDocGroupItem", () => {
  const groupUid = crypto.randomUUID();
  const orderItems: LineItem[] = [
    {
      uid: groupUid,
      type: "group",
      name: "Lighting",
      description: "",
      path: [DEST_1, groupUid],
    },
  ];
  const [projected] = buildOrderScopedItems(orderItems, ORDER_DIV_1);
  const result = OrderDocGroupItem.safeParse(projected);
  assertEquals(result.success, true, JSON.stringify(result.success ? {} : result.error.issues, null, 2));
});

// ── carryForwardOverrides ───────────────────────────────────────

Deno.test("carryForwardOverrides preserves coa_revenue and xero_id from existing items", () => {
  const rebuilt: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light Updated", quantity: 3, path: [] },
    { uid: "item-new", type: "sale", name: "New Item", quantity: 1, path: [] },
  ];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000001", path: [] },
    { uid: "item-removed", type: "sale", name: "Gone", coa_revenue: 4200, path: [] },
  ];
  const result = carryForwardOverrides(rebuilt, existing);
  assertEquals(result[0].name, "Light Updated"); // rebuilt field
  assertEquals(result[0].quantity, 3); // rebuilt field
  assertEquals(result[0].coa_revenue, 4100); // carried forward
  assertEquals(result[0].xero_id, "00000000-0000-4000-8000-000000000001"); // carried forward
  assertEquals(result[1].coa_revenue, undefined); // new item, no override
});

// ── syncOrderItems ──────────────────────────────────────────────

Deno.test("syncOrderItems replaces scoped items and carries forward overrides", () => {
  const newOrderItems: LineItem[] = [
    { uid: DEST_1, type: "destination", name: "Venue Renamed", path: [DEST_1] },
    { uid: ITEM_1, type: "rental", name: "Spot Light v2", quantity: 5, path: [DEST_1, ITEM_1] },
    { uid: ITEM_NEW, type: "service", name: "Setup Fee", quantity: 1, path: [DEST_1, ITEM_NEW] },
  ];

  const result = syncOrderItems(multiOrderInvoiceItems, newOrderItems, ORDER_DIV_1);

  // Order divider preserved
  assertEquals(result[0].uid, ORDER_DIV_1);
  assertEquals(result[0].type, "order");

  // Rebuilt items have prepended path
  assertEquals(result[1].path, [ORDER_DIV_1, DEST_1]);
  assertEquals(result[1].name, "Venue Renamed");

  assertEquals(result[2].path, [ORDER_DIV_1, DEST_1, ITEM_1]);
  assertEquals(result[2].name, "Spot Light v2");
  assertEquals(result[2].quantity, 5);
  assertEquals((result[2] as InvoiceItem).coa_revenue, 4100); // carried forward

  assertEquals(result[3].path, [ORDER_DIV_1, DEST_1, ITEM_NEW]);
  assertEquals(result[3].name, "Setup Fee");

  // Order-div-2 items untouched
  assertEquals(result[4].uid, ORDER_DIV_2);
  assertEquals(result[5].uid, ITEM_3);

  // item-2 (Tripod) was removed from order → gone from invoice
  const tripod = result.find((i) => i.uid === ITEM_2);
  assertEquals(tripod, undefined);
});

Deno.test("syncOrderItems projects order-only fields off new items (strict schema passes)", () => {
  // Invoice has a clean divider but no scoped items yet — sync will take the "new item" path.
  const invoiceItems: InvoiceItem[] = [orderDivider];
  const orderItems: LineItem[] = [
    {
      uid: DEST_1,
      type: "destination",
      name: "Venue",
      uid_delivery: DEL_1,
      uid_collection: null,
      description: "",
      path: [DEST_1],
    },
    {
      uid: ITEM_1,
      type: "rental",
      name: "Light",
      quantity: 1,
      path: [DEST_1, ITEM_1],
      stock_method: "reserve",
      order_number: 1001,
      uid_order: ORDER_ID_1,
      zero_priced: false,
      // @ts-expect-error — inclusion_type not on LineItem type
      inclusion_type: "mandatory",
      price: {
        base: 100, chargeable_days: 5, formula: "five_day_week",
        subtotal: 100, subtotal_discounted: 100, discount: null, taxes: [], total: 100,
        replacement: 5000,
      },
    },
  ];
  const result = syncOrderItems(invoiceItems, orderItems, ORDER_DIV_1);
  const lineItem = result.find((i) => i.uid === ITEM_1)!;
  const parsed = InvoiceDocLineItemSchema.safeParse(lineItem);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

Deno.test("syncOrderItems preserves order when divider not found (appends)", () => {
  const items: InvoiceItem[] = [
    { uid: "existing", type: "rental", name: "Existing Item", quantity: 1, path: ["existing"] },
  ];
  const orderItems: LineItem[] = [
    { uid: "new-item", type: "sale", name: "New", quantity: 1, path: ["new-item"] },
  ];
  const result = syncOrderItems(items, orderItems, "unknown-divider");
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "existing");
  assertEquals(result[1].path, ["unknown-divider", "new-item"]);
});

// ── syncOrderToInvoiceSelective ─────────────────────────────────

Deno.test("syncOrderToInvoiceSelective projects new items to invoice-line-item shape", () => {
  // No prev order, no current invoice items — everything takes the "new item" branch.
  const newOrderItems: LineItem[] = [
    {
      uid: ITEM_1,
      type: "rental",
      name: "Light",
      quantity: 1,
      path: [DEST_1, ITEM_1],
      stock_method: "reserve",
      order_number: 1001,
      uid_order: ORDER_ID_1,
      zero_priced: false,
      price: {
        base: 100, chargeable_days: 5, formula: "five_day_week",
        subtotal: 100, subtotal_discounted: 100, discount: null, taxes: [], total: 100,
        replacement: 5000,
      },
    },
  ];
  const result = syncOrderToInvoiceSelective([], newOrderItems, [], ORDER_DIV_1);
  assertEquals(result.length, 1);
  const parsed = InvoiceDocLineItemSchema.safeParse(result[0]);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

Deno.test("syncOrderToInvoiceSelective projects synced items and carries forward invoice-only fields", () => {
  // Prev order + matching invoice item with overrides → sync branch replaces body, keeps overrides.
  const prevItem: LineItem = {
    uid: ITEM_1,
    type: "rental",
    name: "Light",
    quantity: 1,
    path: [DEST_1, ITEM_1],
    price: {
      base: 100, chargeable_days: 5, formula: "five_day_week",
      subtotal: 100, subtotal_discounted: 100, discount: null, taxes: [], total: 100,
    } as unknown as LineItem["price"],
  };
  const invoiceItem: InvoiceItem = {
    ...prevItem,
    path: [ORDER_DIV_1, DEST_1, ITEM_1],
    coa_revenue: 4100,
    xero_id: "00000000-0000-4000-8000-000000000001",
  } as InvoiceItem;
  const newItem: LineItem = {
    ...prevItem,
    name: "Light v2",
    quantity: 3,
    // Order-only fields must NOT survive into invoice item.
    stock_method: "reserve",
    order_number: 1001,
    uid_order: ORDER_ID_1,
  };

  const result = syncOrderToInvoiceSelective([prevItem], [newItem], [invoiceItem], ORDER_DIV_1);
  assertEquals(result.length, 1);
  const out = result[0];

  // New values from projected order item
  assertEquals(out.name, "Light v2");
  assertEquals(out.quantity, 3);
  // Carried forward from the overridden invoice item
  assertEquals((out as InvoiceItem).coa_revenue, 4100);
  assertEquals((out as InvoiceItem).xero_id, "00000000-0000-4000-8000-000000000001");
  // Projected — strict schema passes
  const parsed = InvoiceDocLineItemSchema.safeParse(out);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

// ── calculateInvoiceTotals ─────────────────────────────────────

const TAXES: Tax[] = [
  { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" },
  { uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.25, type: "percent" },
];

Deno.test("calculateInvoiceTotals computes totals from billable items only", () => {
  const items: InvoiceItem[] = [
    { uid: "order-div", type: "order", name: "Order #1", path: [] },
    { uid: "dest", type: "destination", name: "Venue", path: [] },
    { uid: "group", type: "group", name: "Lighting", path: [] },
    makeItem(
      { uid: "item-1", type: "rental", name: "Spot Light", quantity: 2 },
      { base: 100, chargeable_days: 5, subtotal: 200, subtotal_discounted: 200, total: 200 },
    ),
    makeItem(
      { uid: "item-2", type: "sale", name: "Tripod", quantity: 1 },
      { base: 300, formula: "fixed", subtotal: 300, subtotal_discounted: 300, total: 300 },
    ),
  ];

  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 500);
  assertEquals(result.subtotal_discounted, 500);
  assertEquals(result.discount_amount, 0);
  assertEquals(result.total, 500);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 500);
  assertEquals(result.taxes, []);
  assertEquals(result.transaction_fees, []);
});

Deno.test("calculateInvoiceTotals applies discount", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, chargeable_days: 5, discount: { type: "percent", rate: 10, amount: 10 }, subtotal: 100, subtotal_discounted: 90, total: 90 },
    ),
  ];
  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 90);
  assertEquals(result.discount_amount, 10);
  assertEquals(result.total, 90);
});

Deno.test("calculateInvoiceTotals with taxes", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, chargeable_days: 5, taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount: 15 }], subtotal: 100, subtotal_discounted: 100, total: 115 },
    ),
  ];
  const result = calculateInvoiceTotals(items, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.total, 115);
  assertEquals(result.taxes.length, 1);
  assertEquals(result.taxes[0].name, "Chicago Rental Tax");
  assertEquals(result.taxes[0].amount, 15);
});

Deno.test("calculateInvoiceTotals with payments reduces amount_due", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 1000, formula: "fixed", subtotal: 1000, subtotal_discounted: 1000, total: 1000 },
    ),
  ];
  const payments = [
    { amount: 400, status: "active" },
    { amount: 100, status: "deleted" },
    { amount: 200, status: "active" },
  ];
  const result = calculateInvoiceTotals(items, [], payments);
  assertEquals(result.total, 1000);
  assertEquals(result.amount_paid, 600);
  assertEquals(result.amount_due, 400);
});

Deno.test("calculateInvoiceTotals with empty items returns zeros", () => {
  const result = calculateInvoiceTotals([], []);
  assertEquals(result.subtotal, 0);
  assertEquals(result.subtotal_discounted, 0);
  assertEquals(result.discount_amount, 0);
  assertEquals(result.total, 0);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 0);
});

Deno.test("calculateInvoiceTotals with transaction fee", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, formula: "fixed", subtotal: 100, subtotal_discounted: 100, total: 100 },
    ),
    // An ordinary line item — `percent_of_total` is what makes it a fee.
    makeItem(
      { uid: "fee-1", type: "transaction_fee", name: "Credit Card Fee" },
      { base: 3, formula: "percent_of_total" },
    ),
  ];
  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 100);
  assertEquals(result.transaction_fees.length, 1);
  assertEquals(result.transaction_fees[0].name, "Credit Card Fee");
  assertEquals(result.transaction_fees[0].amount, 3);
  assertEquals(result.total, 103);
});

// ── derivePaymentStatus ─────────────────────────────────────────

Deno.test("derivePaymentStatus passes through draft", () => {
  assertEquals(derivePaymentStatus("draft", 0, 1000), "draft");
});

Deno.test("derivePaymentStatus passes through void", () => {
  assertEquals(derivePaymentStatus("void", 500, 500), "void");
});

Deno.test("derivePaymentStatus returns paid when amount_due <= 0", () => {
  assertEquals(derivePaymentStatus("issued", 1000, 0), "paid");
});

Deno.test("derivePaymentStatus returns part_paid when some paid", () => {
  assertEquals(derivePaymentStatus("issued", 500, 500), "part_paid");
});

Deno.test("derivePaymentStatus returns issued when nothing paid", () => {
  assertEquals(derivePaymentStatus("issued", 0, 1000), "issued");
});

// ── recomputePaymentTotals ──────────────────────────────────────

Deno.test("recomputePaymentTotals sums active payments only", () => {
  const payments = [
    { amount: 400, status: "active" },
    { amount: 100, status: "deleted" },
    { amount: 200, status: "active" },
  ];
  const result = recomputePaymentTotals(1000, payments);
  assertEquals(result.amount_paid, 600);
  assertEquals(result.amount_due, 400);
});

Deno.test("recomputePaymentTotals with no payments", () => {
  const result = recomputePaymentTotals(500, []);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 500);
});

Deno.test("recomputePaymentTotals with zero total", () => {
  const result = recomputePaymentTotals(0, [{ amount: 50, status: "active" }]);
  assertEquals(result.amount_paid, 50);
  assertEquals(result.amount_due, -50);
});

// ── getXeroUnitAmount ─────────────────────────────���────────────

Deno.test("getXeroUnitAmount divides subtotal by quantity", () => {
  assertEquals(getXeroUnitAmount(500, 2), 250);
});

Deno.test("getXeroUnitAmount returns 0 for zero quantity", () => {
  assertEquals(getXeroUnitAmount(500, 0), 0);
});

Deno.test("getXeroUnitAmount handles fractional result", () => {
  assertEquals(getXeroUnitAmount(100, 3), 33.33);
});

// ── computeInvoiceItemPaths ────────────────────────────────────

Deno.test("computeInvoiceItemPaths computes paths within order scopes", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    makeItem({ uid: "p1", path: [] }),
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["od-1"]);
  assertEquals(result[1].path, ["od-1", "dest-1"]);
  assertEquals(result[2].path, ["od-1", "dest-1", "p1"]);
  assertEquals(result[3].path, ["od-1", "dest-1", "p2"]);
});

Deno.test("computeInvoiceItemPaths handles multiple order scopes", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue A", path: [] },
    makeItem({ uid: "p1", path: [] }),
    { ...orderDividerBase, uid: "od-2", name: "Order #2", type: "order", uid_order: "o2" } as InvoiceItem,
    { uid: "dest-2", type: "destination", name: "Venue B", path: [] },
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["od-1"]);
  assertEquals(result[1].path, ["od-1", "dest-1"]);
  assertEquals(result[2].path, ["od-1", "dest-1", "p1"]);
  assertEquals(result[3].path, ["od-2"]);
  assertEquals(result[4].path, ["od-2", "dest-2"]);
  assertEquals(result[5].path, ["od-2", "dest-2", "p2"]);
});

Deno.test("computeInvoiceItemPaths preserves component ancestry", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    makeItem({ uid: "parent", path: [] }),
    makeItem({ uid: "child", path: ["parent"] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[2].path, ["od-1", "dest-1", "parent"]);
  assertEquals(result[3].path, ["od-1", "dest-1", "parent", "child"]);
});

Deno.test("computeInvoiceItemPaths produces unique keys for siblings", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    makeItem({ uid: "item-A", path: [] }),
    makeItem({ uid: "item-B", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  const keyA = result[2].path.join("/");
  const keyB = result[3].path.join("/");
  assertEquals(keyA !== keyB, true);
});

Deno.test("computeInvoiceItemPaths does not mutate input items", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    makeItem({ uid: "p1", path: [] }),
  ];
  const original = items[2];
  const result = computeInvoiceItemPaths(items);
  assertEquals(original.path, []);
  assertEquals(result[2].path, ["od-1", "dest-1", "p1"]);
});

// ── computeInvoiceItemPaths: the no-divider branch (D1) ────────
// A CRMS invoice with no matching CFS order carries no `order` divider.
// This branch used to be the identity function — it returned the INPUT objects
// by reference with whatever path they arrived with (`[]` in practice), and the
// write guard, defined as "path equals what this function produces", called
// that clean. 28 prod invoices / 79 items sat in that hole.

Deno.test("computeInvoiceItemPaths normalizes an invoice with no order divider", () => {
  const items: InvoiceItem[] = [
    makeItem({ uid: "p1", path: [] }),
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["p1"]);
  assertEquals(result[1].path, ["p2"]);
  // And the guard now agrees, rather than agreeing with the hole.
  assertEquals(validateInvoiceItemPaths(result), []);
});

Deno.test("computeInvoiceItemPaths flags a no-divider invoice whose paths are empty", () => {
  // The 78 prod items of the 79: path [] on a divider-less invoice.
  const items: InvoiceItem[] = [makeItem({ uid: "p1", path: [] })];
  assertEquals(validateInvoiceItemPaths(items), [
    { index: 0, uid: "p1", path: [], expected: ["p1"] },
  ]);
});

Deno.test("computeInvoiceItemPaths appends self on a no-divider invoice carrying an ancestor", () => {
  // Prod invoice 2117's shape: the 1 item of the 79 whose path was non-empty
  // but did not end in its own uid.
  const items: InvoiceItem[] = [
    makeItem({ uid: "parent", path: [] }),
    makeItem({ uid: "child", path: ["parent"] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["parent"]);
  assertEquals(result[1].path, ["parent", "child"]);
});

Deno.test("computeInvoiceItemPaths normalizes items before the first order divider", () => {
  const items: InvoiceItem[] = [
    makeItem({ uid: "loose", path: [] }),
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    makeItem({ uid: "p1", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["loose"]);
  assertEquals(result[1].path, ["od-1"]);
  assertEquals(result[2].path, ["od-1", "dest-1"]);
  assertEquals(result[3].path, ["od-1", "dest-1", "p1"]);
});

Deno.test("computeInvoiceItemPaths returns fresh items on the no-divider branch", () => {
  // The docblock promised "a fresh array of fresh items… safe to pass a Solid
  // store proxy"; on this branch it used to return the inputs themselves.
  const items: InvoiceItem[] = [makeItem({ uid: "p1", path: [] })];
  const original = items[0];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0] === original, false);
  assertEquals(original.path, []);
  assertEquals(result[0].path, ["p1"]);
});

Deno.test("computeInvoiceItemPaths is idempotent on a no-divider invoice", () => {
  const items: InvoiceItem[] = [
    makeItem({ uid: "parent", path: [] }),
    makeItem({ uid: "child", path: ["parent"] }),
    makeItem({ uid: "other", path: [] }),
  ];
  const once = computeInvoiceItemPaths(items);
  const twice = computeInvoiceItemPaths(once);
  assertEquals(twice.map((it) => it.path), once.map((it) => it.path));
  assertEquals(twice.map((it) => it.uid), once.map((it) => it.uid));
});

// ── computeInvoiceItemPaths: the divider hierarchy ─────────────
// `computeInvoiceItemPaths` is `computeItemPaths` at invoice depth — the
// invoice hierarchy is the order hierarchy with `order` prepended. These pin
// the level rule ("a divider closes every level at or below its own") that
// used to be split between a hardcoded `currentGroupUid = null` and a separate
// scope-slicing wrapper.

Deno.test("an order divider closes the destination and group above it", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue A", path: [] },
    { uid: "grp-1", type: "group", name: "G1", path: [] },
    makeItem({ uid: "p1", path: [] }),
    // A new order divider must reset BOTH deeper levels, not just the group.
    { ...orderDividerBase, uid: "od-2", name: "Order #2", type: "order", uid_order: "o2" } as InvoiceItem,
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[3].path, ["od-1", "dest-1", "grp-1", "p1"]);
  assertEquals(result[4].path, ["od-2"]);
  assertEquals(result[5].path, ["od-2", "p2"]);
});

Deno.test("a destination closes the group but not the order divider", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue A", path: [] },
    { uid: "grp-1", type: "group", name: "G1", path: [] },
    { uid: "dest-2", type: "destination", name: "Venue B", path: [] },
    makeItem({ uid: "p1", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[3].path, ["od-1", "dest-2"]);
  // grp-1 is gone from the prefix; od-1 survives.
  assertEquals(result[4].path, ["od-1", "dest-2", "p1"]);
});

Deno.test("a destination before the first order divider carries no order prefix", () => {
  const items: InvoiceItem[] = [
    { uid: "dest-1", type: "destination", name: "Loose", path: [] },
    makeItem({ uid: "p1", path: [] }),
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[0].path, ["dest-1"]);
  assertEquals(result[1].path, ["dest-1", "p1"]);
  assertEquals(result[2].path, ["od-1"]);
  assertEquals(result[3].path, ["od-1", "p2"]);
});

Deno.test("component ancestry nests under the full invoice divider prefix", () => {
  const items: InvoiceItem[] = [
    { ...orderDividerBase, uid: "od-1", name: "Order #1", type: "order", uid_order: "o1" } as InvoiceItem,
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    { uid: "grp-1", type: "group", name: "G1", path: [] },
    makeItem({ uid: "kit", path: [] }),
    makeItem({ uid: "part", path: ["kit"] }),
  ];
  const result = computeInvoiceItemPaths(items);
  assertEquals(result[3].path, ["od-1", "dest-1", "grp-1", "kit"]);
  assertEquals(result[4].path, ["od-1", "dest-1", "grp-1", "kit", "part"]);
  assertEquals(validateInvoiceItemPaths(result), []);
});

// ── Top-level field sync helpers ────────────────────────────────

function makePair(
  deliveryUid: string,
  collectionUid: string,
  overrides: {
    delivery?: { instructions?: string | null };
    collection?: { instructions?: string | null };
    customer_collecting?: boolean;
    customer_returning?: boolean;
  } = {},
) {
  return {
    dates: NO_DOC_DATES,
    delivery: { uid: deliveryUid, address: null, instructions: overrides.delivery?.instructions ?? null, contact: null },
    collection: { uid: collectionUid, address: null, instructions: overrides.collection?.instructions ?? null, contact: null },
    customer_collecting: overrides.customer_collecting ?? false,
    customer_returning: overrides.customer_returning ?? false,
  };
}

Deno.test("syncOrderDestinationsSelective adds new pairs tagged with uid_order", () => {
  const prev = [makePair("d1", "c1")];
  const next = [makePair("d1", "c1"), makePair("d2", "c2")];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1") }];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 2);
  assertEquals(result[1].delivery.uid, "d2");
  assertEquals(result[1].uid_order, "o1");
});

Deno.test("syncOrderDestinationsSelective replaces synced pairs with new order data", () => {
  const prev = [makePair("d1", "c1", { delivery: { instructions: "old" } })];
  const next = [makePair("d1", "c1", { delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { delivery: { instructions: "old" } }) }];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].delivery.instructions, "new");
});

Deno.test("syncOrderDestinationsSelective keeps overridden pairs (invoice differs from prev)", () => {
  const prev = [makePair("d1", "c1", { delivery: { instructions: "orig" } })];
  const next = [makePair("d1", "c1", { delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { delivery: { instructions: "manual edit" } }) }];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].delivery.instructions, "manual edit");
});

Deno.test("syncOrderDestinationsSelective drops removed pairs when not overridden", () => {
  const prev = [makePair("d1", "c1"), makePair("d2", "c2")];
  const next = [makePair("d1", "c1")];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o1", ...makePair("d2", "c2") },
  ];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].delivery.uid, "d1");
});

Deno.test("syncOrderDestinationsSelective keeps removed pairs when overridden", () => {
  const prev = [makePair("d1", "c1"), makePair("d2", "c2", { delivery: { instructions: "orig" } })];
  const next = [makePair("d1", "c1")];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o1", ...makePair("d2", "c2", { delivery: { instructions: "manual edit" } }) },
  ];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 2);
  assertEquals(result[1].delivery.instructions, "manual edit");
});

Deno.test("syncOrderDestinationsSelective leaves out-of-scope (other-order) pairs untouched", () => {
  const prev = [makePair("d1", "c1")];
  const next: ReturnType<typeof makePair>[] = [];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o2", ...makePair("dX", "cX") },
  ];
  const result = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].uid_order, "o2");
  assertEquals(result[0].delivery.uid, "dX");
});

Deno.test("removeOrderScopedDestinations filters by uid_order", () => {
  const dests: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o2", ...makePair("d2", "c2") },
  ];
  const result = removeOrderScopedDestinations(dests, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].uid_order, "o2");
});

Deno.test("syncScalarWithOverride replaces when invoice matches prev", () => {
  assertEquals(syncScalarWithOverride("foo", "bar", "foo"), "bar");
  assertEquals(syncScalarWithOverride(null, "new", null), "new");
  assertEquals(syncScalarWithOverride(undefined, "new", undefined), "new");
});

Deno.test("syncScalarWithOverride keeps invoice when it differs from prev", () => {
  assertEquals(syncScalarWithOverride("foo", "bar", "manual"), "manual");
  assertEquals(syncScalarWithOverride(null, "new", "manual"), "manual");
});

Deno.test("syncObjectWithOverride respects keys subset", () => {
  const prev = { uid: "org1", name: "A", tax_profile: "applied" };
  const next = { uid: "org1", name: "B", tax_profile: "applied" };
  const invoice = { uid: "org1", name: "A", tax_profile: "exempt" };
  // Keys-subset match on (uid, name): prev.name === invoice.name → replace.
  const result = syncObjectWithOverride(prev, next, invoice, ["uid", "name"]);
  assertEquals(result, next);
});

Deno.test("syncObjectWithOverride keeps invoice when compared subset diverges", () => {
  const prev = { uid: "org1", name: "A" };
  const next = { uid: "org1", name: "B" };
  const invoice = { uid: "org1", name: "manual" };
  const result = syncObjectWithOverride(prev, next, invoice, ["uid", "name"]);
  assertEquals(result, invoice);
});

// ── validateInvoiceItemPaths ────────────────────────────────────

// Start each test from a baseline normalized through computeInvoiceItemPaths so
// the test fixture's bare order divider path doesn't mask injected mismatches.
const cleanInvoiceItems: InvoiceItem[] = computeInvoiceItemPaths(multiOrderInvoiceItems);

Deno.test("validateInvoiceItemPaths returns [] for items just produced by computeInvoiceItemPaths", () => {
  assertEquals(validateInvoiceItemPaths(cleanInvoiceItems), []);
});

Deno.test("validateInvoiceItemPaths flags items missing the order divider prefix", () => {
  // Line item under order-div-1 written without the divider in its path.
  const items = cleanInvoiceItems.map((it, i) =>
    i === 2 ? { ...it, path: [DEST_1, ITEM_1] } : it
  );
  const issues = validateInvoiceItemPaths(items);
  assertEquals(issues.length, 1);
  assertEquals(issues[0], {
    index: 2,
    uid: ITEM_1,
    path: [DEST_1, ITEM_1],
    expected: [ORDER_DIV_1, DEST_1, ITEM_1],
  });
});

Deno.test("validateInvoiceItemPaths flags stale structural uids inside an order scope", () => {
  // Item carries a leaked structural uid ("dest-2") from a sibling destination
  // (synthesized inline for this test) it briefly passed through.
  const staleDest: InvoiceItem = {
    uid: DEST_2,
    type: "destination",
    name: "Other Venue",
    uid_delivery: DEL_2,
    uid_collection: null,
    path: [ORDER_DIV_1, DEST_2],
  };
  const items: InvoiceItem[] = [
    cleanInvoiceItems[0], // order-div-1
    cleanInvoiceItems[1], // dest-1
    staleDest,
    { ...cleanInvoiceItems[2], path: [ORDER_DIV_1, DEST_1, DEST_2, ITEM_1] },
  ];
  const issues = validateInvoiceItemPaths(items);
  assertEquals(issues.length, 1);
  // After staleDest, the line item's current destination is dest-2 — so the
  // recomputed path drops both stale dest-1 and the duplicate dest-2 segment.
  assertEquals(issues[0], {
    index: 3,
    uid: ITEM_1,
    path: [ORDER_DIV_1, DEST_1, DEST_2, ITEM_1],
    expected: [ORDER_DIV_1, DEST_2, ITEM_1],
  });
});

Deno.test("validateInvoiceItemPaths does not mutate input items", () => {
  const items = cleanInvoiceItems.map((it, i) =>
    i === 2 ? { ...it, path: ["bogus"] } : it
  );
  const before = items[2].path.slice();
  validateInvoiceItemPaths(items);
  assertEquals(items[2].path, before);
});

// ── validateInvoiceItemUniqueness ──────────────────────────────

Deno.test("validateInvoiceItemUniqueness returns [] for clean multi-order invoice", () => {
  // Same-uid line in two different order divider scopes is allowed.
  assertEquals(validateInvoiceItemUniqueness(multiOrderInvoiceItems), []);
});

Deno.test("validateInvoiceItemUniqueness flags duplicates within one order divider's scope", () => {
  const items: InvoiceItem[] = [
    orderDivider,
    {
      uid: "g1",
      type: "group",
      name: "G1",
      description: "",
      path: [ORDER_DIV_1, "g1"],
    } as InvoiceItem,
    makeItem({ uid: "P", path: [ORDER_DIV_1, "g1", "P"] }),
    makeItem({ uid: "P", path: [ORDER_DIV_1, "g1", "P"] }),
  ];
  const issues = validateInvoiceItemUniqueness(items);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].uid, "P");
  assertEquals(issues[0].parentUid, "g1");
});

Deno.test("validateInvoiceItemUniqueness allows same product in two different order scopes", () => {
  // Same product line inside order divider 1 and order divider 2 — not a violation.
  const items: InvoiceItem[] = [
    orderDivider,
    makeItem({ uid: "P", path: [ORDER_DIV_1, "P"] }),
    orderDivider2,
    makeItem({ uid: "P", path: [ORDER_DIV_2, "P"] }),
  ];
  assertEquals(validateInvoiceItemUniqueness(items), []);
});

// ── buildInvoiceDestinationDivider ──────────────────────────────

Deno.test("buildInvoiceDestinationDivider maps fields and defaults path to []", () => {
  const divider = buildInvoiceDestinationDivider({
    uid: DEST_9,
    name: "Warehouse",
    uid_delivery: DEL_9,
    uid_collection: COL_9,
  });
  assertEquals(divider.type, "destination");
  assertEquals(divider.uid, DEST_9);
  assertEquals(divider.name, "Warehouse");
  assertEquals(divider.description, "");
  assertEquals((divider as { uid_delivery?: string | null }).uid_delivery, DEL_9);
  assertEquals((divider as { uid_collection?: string | null }).uid_collection, COL_9);
  assertEquals(divider.path, []);
});

Deno.test("buildInvoiceDestinationDivider nulls missing collection, accepts explicit path, matches schema", () => {
  // The webhook leaves path [] and lets computeInvoiceItemPaths assign it; the
  // order-projection caller passes the scoped path directly — both must validate.
  // A real order destination always carries a delivery uid; uid_collection may be null.
  // OrderDocDestinationItem validates `uid` as a UUID, so use a real one.
  const destUid = crypto.randomUUID();
  const divider = buildInvoiceDestinationDivider({ uid: destUid, name: "Venue", uid_delivery: DEL_10 }, [ORDER_DIV_1, destUid]);
  assertEquals((divider as { uid_collection?: string | null }).uid_collection, null); // omitted → defaulted to null
  assertEquals(divider.path, [ORDER_DIV_1, destUid]);
  const parsed = OrderDocDestinationItem.safeParse(divider);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

// ── resyncInvoiceLines + computeInvoiceSyncStatus ───────────────

// Raw order items (order-root-relative paths, order-only fields present) that
// project cleanly into the invoice divider scope via buildOrderScopedItems.
const RESYNC_DEST: LineItem = {
  uid: DEST_1, type: "destination", name: "Main Venue",
  uid_delivery: DEL_1, uid_collection: null, description: "", path: [DEST_1],
};
const RESYNC_LINE_A: LineItem = {
  uid: ITEM_1, type: "rental", name: "Spot Light", quantity: 2, path: [DEST_1, ITEM_1],
  stock_method: "reserve", order_number: 1001, uid_order: ORDER_ID_1, zero_priced: false,
  price: {
    base: 100, chargeable_days: 5, formula: "five_day_week",
    subtotal: 200, subtotal_discounted: 200, discount: null, taxes: [], total: 200, replacement: 5000,
  },
} as unknown as LineItem;
const RESYNC_LINE_B: LineItem = {
  uid: ITEM_2, type: "sale", name: "Tripod", quantity: 1, path: [DEST_1, ITEM_2],
  stock_method: "reserve", order_number: 1001, uid_order: ORDER_ID_1, zero_priced: false,
  price: {
    base: 300, chargeable_days: null, formula: "fixed",
    subtotal: 300, subtotal_discounted: 300, discount: null, taxes: [], total: 300, replacement: 0,
  },
} as unknown as LineItem;
const RESYNC_ORDER_ITEMS: LineItem[] = [RESYNC_DEST, RESYNC_LINE_A, RESYNC_LINE_B];

const KEY_DEST = [ORDER_DIV_1, DEST_1].join("/");
const KEY_A = [ORDER_DIV_1, DEST_1, ITEM_1].join("/");
const KEY_B = [ORDER_DIV_1, DEST_1, ITEM_2].join("/");

// In-sync invoice baseline: order divider + the exact projection of the order.
function baselineInvoice(): InvoiceItem[] {
  return [orderDivider, ...buildOrderScopedItems(RESYNC_ORDER_ITEMS, ORDER_DIV_1)];
}

// Order where line A grew from qty 2 → 9 (invoice not yet resynced).
function changedOrderItems(): LineItem[] {
  const priceA = (RESYNC_LINE_A as unknown as { price: Record<string, unknown> }).price;
  return [
    RESYNC_DEST,
    { ...RESYNC_LINE_A, quantity: 9, price: { ...priceA, subtotal: 900, subtotal_discounted: 900, total: 900 } } as unknown as LineItem,
    RESYNC_LINE_B,
  ];
}

Deno.test("computeInvoiceSyncStatus: all lines in_sync when invoice matches the order projection", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), RESYNC_ORDER_ITEMS, ORDER_DIV_1);
  assertEquals(status.get(KEY_DEST), "in_sync");
  assertEquals(status.get(KEY_A), "in_sync");
  assertEquals(status.get(KEY_B), "in_sync");
});

Deno.test("computeInvoiceSyncStatus: only the changed line is out_of_sync", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), changedOrderItems(), ORDER_DIV_1);
  assertEquals(status.get(KEY_A), "out_of_sync"); // qty changed on the order
  assertEquals(status.get(KEY_B), "in_sync"); // untouched
});

Deno.test("computeInvoiceSyncStatus: invoice-only overrides do not count as drift", () => {
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000abc" } as InvoiceItem) : it
  );
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1);
  assertEquals(status.get(KEY_A), "in_sync"); // coa_revenue / xero_id excluded from comparison
});

Deno.test("computeInvoiceSyncStatus: order line missing from the invoice is out_of_sync", () => {
  const inv = baselineInvoice().filter((it) => it.uid !== ITEM_2);
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1);
  assertEquals(status.get(KEY_B), "out_of_sync");
});

Deno.test("computeInvoiceSyncStatus: invoice line the order dropped is out_of_sync", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), [RESYNC_DEST, RESYNC_LINE_A], ORDER_DIV_1);
  assertEquals(status.get(KEY_B), "out_of_sync");
});

Deno.test("resyncInvoiceLines per-line: re-projects only the targeted line, sibling untouched", () => {
  const result = resyncInvoiceLines(baselineInvoice(), changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const a = result.find((i) => i.uid === ITEM_1)!;
  const b = result.find((i) => i.uid === ITEM_2)!;
  assertEquals(a.quantity, 9); // snapped to the order
  assertEquals(b.quantity, 1); // sibling untouched
  assertEquals((a.price as { subtotal: number }).subtotal, 900);
});

Deno.test("resyncInvoiceLines per-line: carries forward invoice-only override fields", () => {
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000abc" } as InvoiceItem) : it
  );
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const a = result.find((i) => i.uid === ITEM_1) as InvoiceItem;
  assertEquals(a.quantity, 9); // body snapped to the order
  assertEquals(a.coa_revenue, 4100); // override preserved
  assertEquals(a.xero_id, "00000000-0000-4000-8000-000000000abc");
});

Deno.test("resyncInvoiceLines per-line: an untargeted overridden line is left as-is", () => {
  const inv = baselineInvoice().map((it) => (it.uid === ITEM_2 ? { ...it, quantity: 7 } : it));
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  assertEquals(result.find((i) => i.uid === ITEM_2)!.quantity, 7); // override kept
});

Deno.test("resyncInvoiceLines per-line: a target the order dropped is left untouched (not removed)", () => {
  const result = resyncInvoiceLines(baselineInvoice(), [RESYNC_DEST, RESYNC_LINE_A], ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_2]]);
  assertEquals(result.find((i) => i.uid === ITEM_2) !== undefined, true);
});

Deno.test("resyncInvoiceLines whole: snaps every scoped line back to the order, discarding overrides", () => {
  const inv = baselineInvoice().map((it) => (it.uid === ITEM_2 ? { ...it, quantity: 7 } : it));
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1);
  assertEquals(result.find((i) => i.uid === ITEM_1)!.quantity, 9); // order value
  assertEquals(result.find((i) => i.uid === ITEM_2)!.quantity, 1); // override discarded
});

Deno.test("resyncInvoiceLines: leaves other order dividers' scopes untouched", () => {
  const inv = [...baselineInvoice(), orderDivider2, lineItem3];
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const l3 = result.find((i) => i.uid === ITEM_3)!;
  assertEquals(l3.quantity, 1);
  assertEquals(l3.path, [ORDER_DIV_2, ITEM_3]);
});
