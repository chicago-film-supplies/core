import { assertEquals } from "@std/assert";
import { getInitialValues, InvoiceDocLineItemSchema, InvoiceDocOrderItem, isInvoiceLineItem, OrderDocDestinationItem, OrderDocGroupItem } from "../src/schemas/mod.ts";
import { calculateOrderTotals, computeItemPaths, sumDocumentTotals, validateItemPaths } from "../src/utils/orders.ts";
import {
  adoptOrderDividerStructure,
  buildInvoiceDestinationDivider,
  buildOrderScopedItems,
  calculateInvoiceTotals,
  carryForwardOverrides,
  computeInvoiceItemPaths,
  computeInvoiceSyncStatus,
  derivePaymentStatus,
  flattenForXero,
  getOrderScopedItems,
  getXeroUnitAmountFromCents,
  type InvoiceDestinationPair,
  type InvoiceItem,
  invoiceItemDifferences,
  invoiceItemsMatch,
  invoiceScopeDividersMatch,
  isItemSynced,
  type LineItem,
  explainInvoiceItemDifferences,
  unexplainedInvoiceItemDifferences,
  type Tax,
  projectOrderItemToInvoiceItem,
  recomputeSettlementTotals,
  removeOrderScopedDestinations,
  removeOrderScopedItems,
  resyncInvoiceLines,
  syncOrderDestinationsSelective,
  toInvoiceDestinationPair,
  syncOrderItems,
  syncOrderToInvoiceSelective,
  syncScalarWithOverride,
  validateInvoiceItemPaths,
  validateInvoiceItemUniqueness,
} from "../src/utils/invoices.ts";
import type {
  InvoiceDocItemType,
  FirestoreTimestampType,
  JurisdictionType,
  OrderDocDatesType,
  SettlementReasonType,
  SettlementTypeType,
} from "../src/schemas/mod.ts";

/** A settlement row reduced to what the totals fold reads. */
const S = (
  o: Partial<{ type: SettlementTypeType; reason: SettlementReasonType; amount_cents: number }> = {},
) => ({
  type: "payment" as SettlementTypeType,
  reason: "payment_received" as SettlementReasonType,
  amount_cents: 0,
  ...o,
});

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

const lineItemBase = getInitialValues(InvoiceDocLineItemSchema);
const priceBase = lineItemBase.price;
const orderDividerBase = getInitialValues(InvoiceDocOrderItem);
const destBase = getInitialValues(OrderDocDestinationItem);

/**
 * Narrow a doc item to its billable-line arm.
 *
 * These tests read line-only fields — `quantity`, `price`, `coa_revenue`,
 * `xero_id` — off results now typed as the full `InvoiceDocItemType` union, and
 * a divider carries none of them. The throw IS the assertion: a divider
 * arriving at one of these reads is a test failure, not something to
 * optional-chain past.
 */
function asLine(item: InvoiceDocItemType) {
  if (!isInvoiceLineItem(item)) {
    throw new Error(`expected a billable line item, got type "${item.type}"`);
  }
  return item;
}

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

const orderDivider: InvoiceDocItemType = {
  ...orderDividerBase,
  uid: ORDER_DIV_1,
  name: "Order #1001",
  uid_order: ORDER_ID_1,
} as InvoiceDocItemType;

const destItem: InvoiceDocItemType = {
  ...destBase,
  uid: DEST_1,
  type: "destination",
  name: "Main Venue",
  uid_delivery: DEL_1,
  uid_collection: null,
  path: [ORDER_DIV_1, DEST_1],
} as InvoiceDocItemType;

const lineItem1: InvoiceDocItemType = {
  ...lineItemBase,
  uid: ITEM_1,
  type: "rental",
  name: "Spot Light",
  quantity: 2,
  price: {
    ...priceBase,
    base_cents: 10000,
    chargeable_days: 5,
    subtotal_cents: 20000,
    subtotal_discounted_cents: 20000,
    total_cents: 20000,
  },
  path: [ORDER_DIV_1, DEST_1, ITEM_1],
  coa_revenue: 4100,
  tracking_category: "rentals",
} as InvoiceDocItemType;

const lineItem2: InvoiceDocItemType = {
  ...lineItemBase,
  uid: ITEM_2,
  type: "sale",
  name: "Tripod",
  quantity: 1,
  price: {
    ...priceBase,
    base_cents: 30000,
    formula: "fixed",
    subtotal_cents: 30000,
    subtotal_discounted_cents: 30000,
    total_cents: 30000,
  },
  path: [ORDER_DIV_1, DEST_1, ITEM_2],
  xero_id: "00000000-0000-4000-8000-000000000123",
} as InvoiceDocItemType;

const orderDivider2: InvoiceDocItemType = {
  ...orderDividerBase,
  uid: ORDER_DIV_2,
  name: "Order #1002",
  uid_order: ORDER_ID_2,
} as InvoiceDocItemType;

const lineItem3: InvoiceDocItemType = {
  ...lineItemBase,
  uid: ITEM_3,
  type: "rental",
  name: "Camera",
  quantity: 1,
  price: {
    ...priceBase,
    base_cents: 50000,
    chargeable_days: 5,
    subtotal_cents: 50000,
    subtotal_discounted_cents: 50000,
    total_cents: 50000,
  },
  path: [ORDER_DIV_2, ITEM_3],
} as InvoiceDocItemType;

const multiOrderInvoiceItems: InvoiceDocItemType[] = [
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
        base_cents: 10000,
        chargeable_days: 5,
        formula: "five_day_week",
        subtotal_cents: 20000,
        subtotal_discounted_cents: 20000,
        discount: null,
        taxes: [],
        total_cents: 20000,
        replacement_cents: 500000,
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
  assertEquals(priceKeys.includes("replacement"), false, `leaked price.replacement_cents: ${priceKeys.join(", ")}`);
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
  const rebuilt: InvoiceDocItemType[] = [
    { ...lineItemBase, uid: "item-1", type: "rental", name: "Light Updated", quantity: 3, path: [] },
    { ...lineItemBase, uid: "item-new", type: "sale", name: "New Item", quantity: 1, path: [] },
  ] as InvoiceDocItemType[];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000001", path: [] },
    { uid: "item-removed", type: "sale", name: "Gone", coa_revenue: 4200, path: [] },
  ];
  const result = carryForwardOverrides(rebuilt, existing);
  assertEquals(result[0].name, "Light Updated"); // rebuilt field
  assertEquals(asLine(result[0]).quantity, 3); // rebuilt field
  assertEquals(asLine(result[0]).coa_revenue, 4100); // carried forward
  assertEquals(asLine(result[0]).xero_id, "00000000-0000-4000-8000-000000000001"); // carried forward
  assertEquals(asLine(result[1]).coa_revenue, null); // new item, no override
  // `null`, not `undefined`: a real invoice line carries the schema default, and
  // the old `undefined` was an artifact of a fixture built without one.
});

// ── INVOICE_ONLY_ITEM_FIELDS: one list, six fields ──────────────
//
// `pickInvoiceOnlyFields` is module-private, so it is asserted through
// `carryForwardOverrides` — its only production consumer and the surface that
// used to hand-inline the same four conditional spreads.

/** Every invoice-only field, populated, on one existing line. */
const ALL_SIX_OVERRIDES = {
  coa_revenue: 4100,
  tracking_category: "Camera",
  xero_id: "00000000-0000-4000-8000-0000000000a1",
  xero_tracking_option_id: "00000000-0000-4000-8000-0000000000a2",
  crms_id: 8812,
  crms_opportunity_id: 5501,
} as const;

Deno.test("carryForwardOverrides carries ALL SIX invoice-only fields, not just the original four", () => {
  const rebuilt = [
    { ...lineItemBase, uid: "item-1", type: "rental", name: "Light Updated", quantity: 3, path: [] },
  ] as InvoiceDocItemType[];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", path: [], ...ALL_SIX_OVERRIDES },
  ];

  const out = carryForwardOverrides(rebuilt, existing)[0] as unknown as Record<string, unknown>;

  // The rebuilt body still wins…
  assertEquals(out.name, "Light Updated");
  assertEquals(out.quantity, 3);
  // …and every invoice-only field is carried, including the two that were
  // missing from all four hand-maintained copies of the list.
  for (const [key, value] of Object.entries(ALL_SIX_OVERRIDES)) {
    assertEquals(out[key], value, `invoice-only field "${key}" was not carried forward`);
  }
});

Deno.test("carryForwardOverrides leaves the rebuilt value alone where the existing line has no override", () => {
  // All six are schema defaults (`getInitialValues` → `null`), so "absent" on a
  // real line means `undefined`, which `pickInvoiceOnlyFields` skips. The
  // property under test is that a missing override does not CLOBBER the
  // rebuilt item — so the rebuilt values are made distinguishable.
  const rebuilt = [
    {
      ...lineItemBase,
      uid: "item-1",
      type: "rental",
      name: "Light",
      quantity: 1,
      path: [],
      crms_opportunity_id: 999,
      coa_revenue: 4200,
    },
  ] as InvoiceDocItemType[];
  // Only `crms_id` is carried; every other invoice-only key is `undefined` here.
  const existing: InvoiceItem[] = [{ uid: "item-1", type: "rental", name: "Light", path: [], crms_id: 8812 }];

  const out = carryForwardOverrides(rebuilt, existing)[0] as unknown as Record<string, unknown>;
  assertEquals(out.crms_id, 8812); // carried forward
  assertEquals(out.crms_opportunity_id, 999); // rebuilt value survives, not clobbered
  assertEquals(out.coa_revenue, 4200); // rebuilt value survives, not clobbered
});

Deno.test("fail-closed companion: the pre-2026-08-10 FOUR-field carry-forward disagrees", () => {
  // Sweeps the implementation this change replaced — four literal conditional
  // spreads — and asserts it DISAGREES. An oracle that has drifted into a
  // restatement of its implementation passes forever and proves nothing.
  const wrongCarryForward = (
    item: Record<string, unknown>,
    existing: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...item,
    ...(existing.coa_revenue !== undefined && { coa_revenue: existing.coa_revenue }),
    ...(existing.tracking_category !== undefined && { tracking_category: existing.tracking_category }),
    ...(existing.xero_id !== undefined && { xero_id: existing.xero_id }),
    ...(existing.xero_tracking_option_id !== undefined && { xero_tracking_option_id: existing.xero_tracking_option_id }),
  });

  const rebuilt = [
    { ...lineItemBase, uid: "item-1", type: "rental", name: "Light", quantity: 1, path: [] },
  ] as InvoiceDocItemType[];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", path: [], ...ALL_SIX_OVERRIDES },
  ];

  const right = carryForwardOverrides(rebuilt, existing)[0] as unknown as Record<string, unknown>;
  const wrong = wrongCarryForward(
    rebuilt[0] as unknown as Record<string, unknown>,
    existing[0] as unknown as Record<string, unknown>,
  );

  // The two CRMS fields are exactly what the old form dropped: the override is
  // discarded and the rebuilt item's schema default (`null`) stands instead —
  // which is indistinguishable from "this line has no CRMS id" downstream.
  assertEquals(right.crms_id, 8812);
  assertEquals(wrong.crms_id, null);
  assertEquals(right.crms_opportunity_id, 5501);
  assertEquals(wrong.crms_opportunity_id, null);
  assertEquals(
    JSON.stringify(right) === JSON.stringify(wrong),
    false,
    "the four-field form must not agree with the six-field one",
  );
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
  assertEquals(asLine(result[2]).quantity, 5);
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
  const invoiceItems: InvoiceDocItemType[] = [orderDivider];
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
        base_cents: 10000, chargeable_days: 5, formula: "five_day_week",
        subtotal_cents: 10000, subtotal_discounted_cents: 10000, discount: null, taxes: [], total_cents: 10000,
        replacement_cents: 500000,
      },
    },
  ];
  const result = syncOrderItems(invoiceItems, orderItems, ORDER_DIV_1);
  const lineItem = result.find((i) => i.uid === ITEM_1)!;
  const parsed = InvoiceDocLineItemSchema.safeParse(lineItem);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

Deno.test("syncOrderItems preserves order when divider not found (appends)", () => {
  const items: InvoiceDocItemType[] = [
    { ...lineItemBase, uid: "existing", type: "rental", name: "Existing Item", quantity: 1, path: ["existing"] },
  ] as InvoiceDocItemType[];
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
        base_cents: 10000, chargeable_days: 5, formula: "five_day_week",
        subtotal_cents: 10000, subtotal_discounted_cents: 10000, discount: null, taxes: [], total_cents: 10000,
        replacement_cents: 500000,
      },
    },
  ];
  const result = syncOrderToInvoiceSelective([], newOrderItems, [], ORDER_DIV_1);
  assertEquals(result.length, 1);
  const parsed = InvoiceDocLineItemSchema.safeParse(result[0]);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

/**
 * An ORDER-shaped line, order-only fields and all — `stock_method`,
 * `order_number`, `uid_order`, `price.replacement_cents`. This is what a stored
 * order line looks like, and it is the shape core#52 was about.
 */
function orderShapedLine(overrides: Partial<LineItem> = {}): LineItem {
  return {
    uid: ITEM_1,
    type: "rental",
    name: "Light",
    description: "",
    quantity: 1,
    path: [DEST_1, ITEM_1],
    stock_method: "reserve",
    order_number: 1001,
    uid_order: ORDER_ID_1,
    zero_priced: false,
    ...overrides,
    price: {
      base_cents: 10000, replacement_cents: 50000, base_percent: null, chargeable_days: 5,
      formula: "five_day_week", subtotal_cents: 10000, subtotal_discounted_cents: 10000,
      discount: null, taxes: [], total_cents: 10000,
      ...((overrides.price ?? {}) as Record<string, unknown>),
    } as unknown as LineItem["price"],
  };
}

Deno.test("syncOrderToInvoiceSelective projects synced items and carries forward invoice-only fields", () => {
  // Prev order + matching invoice item with overrides → sync branch replaces body, keeps overrides.
  //
  // ⚠️ The invoice side is `prevItem`'s PROJECTION, not a bare spread of it —
  // which is what a stored invoice actually holds, and what makes this arm
  // reachable. `isItemSynced` used to compare the order shape against the
  // invoice shape directly; `stock_method` alone made the key sets unequal, so
  // this branch was dead for every real line in the corpus and the test passed
  // only because its fixture omitted every order-only field (core#52).
  const prevItem = orderShapedLine();
  const invoiceItem: InvoiceDocItemType = {
    ...buildOrderScopedItems([prevItem], ORDER_DIV_1)[0],
    coa_revenue: 4100,
    xero_id: "00000000-0000-4000-8000-000000000001",
  } as InvoiceDocItemType;
  const newItem: LineItem = orderShapedLine({ name: "Light v2", quantity: 3 });

  const result = syncOrderToInvoiceSelective([prevItem], [newItem], [invoiceItem], ORDER_DIV_1);
  assertEquals(result.length, 1);
  const out = result[0];

  // New values from projected order item
  assertEquals(out.name, "Light v2");
  assertEquals(asLine(out).quantity, 3);
  // Carried forward from the overridden invoice item
  assertEquals((out as InvoiceItem).coa_revenue, 4100);
  assertEquals((out as InvoiceItem).xero_id, "00000000-0000-4000-8000-000000000001");
  // Projected — strict schema passes
  const parsed = InvoiceDocLineItemSchema.safeParse(out);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

// ── What the order→invoice projection carries ──────────────────
//
// Two fields joined the projection together and are treated DIFFERENTLY,
// because the comparator sees one of them and not the other. These tests exist
// to keep that asymmetry deliberate.

Deno.test("projection: `price.taxes_base` inherits, so an invoice profile revert is lossless", () => {
  // Divergence (6): the doc-level override rewrites `taxes` and never
  // `taxes_base`, so without the snapshot an invoice reverting to `tax_applied`
  // has nothing to restore from — `materializeDocumentTax` returns early and the
  // line keeps whichever override was last written.
  const prevItem = orderShapedLine();
  const withBase = orderShapedLine({
    price: {
      taxes_base: [{ uid: "chirentaltax00000001", name: "Chicago Rental Tax", rate: 15, type: "percent" }],
    } as unknown as LineItem["price"],
  });

  const result = syncOrderToInvoiceSelective(
    [prevItem],
    [withBase],
    buildOrderScopedItems([prevItem], ORDER_DIV_1),
    ORDER_DIV_1,
  );
  const price = asLine(result[0]).price as unknown as Record<string, unknown>;
  assertEquals(
    (price.taxes_base as Array<{ uid: string }>)[0].uid,
    "chirentaltax00000001",
  );
  // …and the strict invoice schema accepts it, which is the half `core` had to
  // ship before any of this could be written.
  const parsed = InvoiceDocLineItemSchema.safeParse(result[0]);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues, null, 2));
});

Deno.test("projection: an order line with NO taxes_base emits no `taxes_base` key at all", () => {
  // ⚠️ Not cosmetic, twice over. An explicit `undefined` trips
  // `validateBeforeWrite`'s no-undefined guard; and `invoicePriceDifferences`
  // compares price KEY SETS, so an unconditionally-emitted key would differ from
  // every stored invoice line written before this field existed.
  const item = orderShapedLine();
  const projected = buildOrderScopedItems([item], ORDER_DIV_1)[0];
  const price = asLine(projected).price as unknown as Record<string, unknown>;
  assertEquals("taxes_base" in price, false);
});

Deno.test("⚠️ projection: a NEW taxes_base makes a previously-synced line read OVERRIDDEN", () => {
  // THE TRANSITION HAZARD, stated as a test rather than left to be discovered.
  //
  // `invoicePriceDifferences` compares the price key sets for equality. Every stored
  // ORDER line has carried `taxes_base` since 2026-07; no stored INVOICE line
  // carries it, because the projection dropped it until now. So on the first
  // deploy after this change, an untouched pair differs by exactly one key and
  // `isItemSynced` says "overridden".
  //
  // That is self-locking: `syncOrderToInvoiceSelective` only REPLACES a line it
  // considers synced, so a line failing this check can never be rewritten to
  // acquire the field. It clears only by backfilling `taxes_base` onto the
  // stored invoice lines — tracked in the convergence plan's §4.3b, sequenced
  // with the api-cloudrun pin bump.
  //
  // Prod exposure is bounded: 0 draft invoices, and the order→invoice mirror
  // skips settled/paid/void. The visible effect is the sync badge, which reads
  // every invoice unconditionally.
  const orderLine = orderShapedLine({
    price: {
      taxes_base: [{ uid: "chirentaltax00000001", name: "Chicago Rental Tax", rate: 15, type: "percent" }],
    } as unknown as LineItem["price"],
  });
  // A stored invoice line as it exists TODAY: same row, written by the old
  // projection, so it has no `taxes_base`.
  const storedInvoiceLine = buildOrderScopedItems([orderShapedLine()], ORDER_DIV_1)[0];

  assertEquals(
    isItemSynced(orderLine, storedInvoiceLine as InvoiceItem, ORDER_DIV_1),
    false,
    "if this ever returns true the hazard is gone — delete this test and the backfill with it",
  );

  // The discriminating half: once the stored line carries the snapshot, the same
  // pair is synced again. Without this, the assertion above would pass against a
  // comparator that had broken outright.
  const backfilled = buildOrderScopedItems([orderLine], ORDER_DIV_1)[0];
  assertEquals(isItemSynced(orderLine, backfilled as InvoiceItem, ORDER_DIV_1), true);
});

Deno.test("projection: `coa_revenue` inherits but changes NO sync verdict", () => {
  // The other half of the asymmetry. `coa_revenue` is projected too — an order
  // line that carries one should hand it to the invoice rather than leaving
  // `undefined` for `calculateInvoiceTotals` to read as "taxable" while the
  // stored per-line taxes say otherwise. But it is in INVOICE_ONLY_ITEM_FIELDS,
  // so `invoiceItemsMatch` filters it out of both key sets and adding it to the
  // projection cannot flip a verdict — unlike `price.taxes_base`, which is
  // nested inside `price` and therefore compared.
  const orderLine = orderShapedLine({ coa_revenue: 4000 });
  const storedInvoiceLine = buildOrderScopedItems([orderShapedLine()], ORDER_DIV_1)[0];
  assertEquals(
    isItemSynced(orderLine, storedInvoiceLine as InvoiceItem, ORDER_DIV_1),
    true,
    "coa_revenue is invoice-owned — it must not participate in the sync verdict",
  );

  // It still reaches the projected item, and the invoice's own value still wins.
  const projected = buildOrderScopedItems([orderLine], ORDER_DIV_1)[0];
  assertEquals((projected as InvoiceItem).coa_revenue, 4000);

  const overridden = { ...storedInvoiceLine, coa_revenue: 4100 } as InvoiceDocItemType;
  const synced = syncOrderToInvoiceSelective(
    [orderShapedLine()],
    [orderLine],
    [overridden],
    ORDER_DIV_1,
  );
  assertEquals(
    (synced[0] as InvoiceItem).coa_revenue,
    4100,
    "carryForwardOverrides re-applies the invoice's own COA over the projected one",
  );
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
      { base_cents: 10000, chargeable_days: 5, subtotal_cents: 20000, subtotal_discounted_cents: 20000, total_cents: 20000 },
    ),
    makeItem(
      { uid: "item-2", type: "sale", name: "Tripod", quantity: 1 },
      { base_cents: 30000, formula: "fixed", subtotal_cents: 30000, subtotal_discounted_cents: 30000, total_cents: 30000 },
    ),
  ];

  const result = calculateInvoiceTotals(items, [], []);
  assertEquals(result.subtotal_cents, 50000);
  assertEquals(result.subtotal_discounted_cents, 50000);
  assertEquals(result.discount_amount_cents, 0);
  assertEquals(result.total_cents, 50000);
  assertEquals(result.amount_paid_cents, 0);
  assertEquals(result.amount_due_cents, 50000);
  assertEquals(result.taxes, []);
  assertEquals(result.transaction_fees, []);
});

Deno.test("calculateInvoiceTotals applies discount", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base_cents: 10000, chargeable_days: 5, discount: { type: "percent", rate: 10, amount_cents: 1000 }, subtotal_cents: 10000, subtotal_discounted_cents: 9000, total_cents: 9000 },
    ),
  ];
  const result = calculateInvoiceTotals(items, [], []);
  assertEquals(result.subtotal_cents, 10000);
  assertEquals(result.subtotal_discounted_cents, 9000);
  assertEquals(result.discount_amount_cents, 1000);
  assertEquals(result.total_cents, 9000);
});

Deno.test("calculateInvoiceTotals with taxes", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base_cents: 10000, chargeable_days: 5, taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount_cents: 1500 }], subtotal_cents: 10000, subtotal_discounted_cents: 10000, total_cents: 11500 },
    ),
  ];
  const result = calculateInvoiceTotals(items, TAXES, []);
  assertEquals(result.subtotal_cents, 10000);
  assertEquals(result.total_cents, 11500);
  assertEquals(result.taxes.length, 1);
  assertEquals(result.taxes[0].name, "Chicago Rental Tax");
  assertEquals(result.taxes[0].amount_cents, 1500);
});

Deno.test("calculateInvoiceTotals with payments reduces amount_due", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base_cents: 100000, formula: "fixed", subtotal_cents: 100000, subtotal_discounted_cents: 100000, total_cents: 100000 },
    ),
  ];
  // The "deleted" row is now an appended reverser rather than a status flag, so
  // the do/undo pair nets to zero arithmetically instead of being filtered out.
  const settlements = [
    S({ amount_cents: 400_00 }),
    S({ amount_cents: 100_00 }),
    S({ type: "payment_reversal", reason: "correction", amount_cents: 100_00 }),
    S({ amount_cents: 200_00 }),
  ];
  const result = calculateInvoiceTotals(items, [], settlements);
  assertEquals(result.total_cents, 100000);
  assertEquals(result.amount_paid_cents, 60000);
  assertEquals(result.amount_credited_cents, 0);
  assertEquals(result.amount_due_cents, 40000);
});

Deno.test("calculateInvoiceTotals with empty items returns zeros", () => {
  const result = calculateInvoiceTotals([], [], []);
  assertEquals(result.subtotal_cents, 0);
  assertEquals(result.subtotal_discounted_cents, 0);
  assertEquals(result.discount_amount_cents, 0);
  assertEquals(result.total_cents, 0);
  assertEquals(result.amount_paid_cents, 0);
  assertEquals(result.amount_due_cents, 0);
});

Deno.test("calculateInvoiceTotals with transaction fee", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base_cents: 10000, formula: "fixed", subtotal_cents: 10000, subtotal_discounted_cents: 10000, total_cents: 10000 },
    ),
    // An ordinary line item — `percent_of_total` is what makes it a fee.
    makeItem(
      { uid: "fee-1", type: "transaction_fee", name: "Credit Card Fee" },
      { base_cents: 0, base_percent: 3, formula: "percent_of_total" },
    ),
  ];
  const result = calculateInvoiceTotals(items, [], []);
  assertEquals(result.subtotal_cents, 10000);
  assertEquals(result.transaction_fees.length, 1);
  assertEquals(result.transaction_fees[0].name, "Credit Card Fee");
  assertEquals(result.transaction_fees[0].amount_cents, 300);
  assertEquals(result.total_cents, 10300);
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

// ── recomputeSettlementTotals ───────────────────────────────────
// The behavioural core lives in `tests/settlements.test.ts`; these three are the
// direct successors of the `recomputePaymentTotals` cases, kept so the migration
// of each is visible.

Deno.test("recomputeSettlementTotals nets a reversal pair to zero", () => {
  const result = recomputeSettlementTotals(100_000, [
    S({ amount_cents: 400_00 }),
    S({ amount_cents: 100_00 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 100_00 }),
    S({ amount_cents: 200_00 }),
  ]);
  assertEquals(result.amount_paid_cents, 60000);
  assertEquals(result.amount_due_cents, 40000);
});

Deno.test("recomputeSettlementTotals with no settlements", () => {
  const result = recomputeSettlementTotals(50_000, []);
  assertEquals(result.amount_paid_cents, 0);
  assertEquals(result.amount_credited_cents, 0);
  assertEquals(result.amount_due_cents, 50000);
});

Deno.test("recomputeSettlementTotals with zero total goes negative, not clamped", () => {
  const result = recomputeSettlementTotals(0, [S({ amount_cents: 50_00 })]);
  assertEquals(result.amount_paid_cents, 5000);
  assertEquals(result.amount_due_cents, -5000);
});

// ── getXeroUnitAmountFromCents ─────────────────────────────���────────────

// ⚠️ **CENTS IN, DOLLARS OUT.** The parameter is CFS storage (integer cents);
// the return is Xero's wire format, which did not change when CFS's storage
// did. Every fixture below therefore scales its FIRST argument by 100 and
// leaves its expectation alone — the opposite of every other conversion in this
// file, and exactly why the function was renamed rather than edited in place.

Deno.test("getXeroUnitAmountFromCents divides subtotal by quantity", () => {
  assertEquals(getXeroUnitAmountFromCents(50_000, 2), 250);
});

Deno.test("getXeroUnitAmountFromCents returns 0 for zero quantity", () => {
  assertEquals(getXeroUnitAmountFromCents(50_000, 0), 0);
});

Deno.test("getXeroUnitAmountFromCents handles fractional result", () => {
  // $100.00 over 3 units is $33.33/unit, and Xero will bill $99.99. The residual
  // is real money in someone else's ledger and is absorbed through DiscountRate.
  assertEquals(getXeroUnitAmountFromCents(10_000, 3), 33.33);
});

Deno.test("getXeroUnitAmountFromCents rounds a negative tie AWAY from zero, unlike the divide it replaced", () => {
  // `currency(-0.05).divide(2)` is -0.02: JS `Math.round(-2.5)` goes toward +∞,
  // so the magnitude shrinks. A credit and its matching charge then differ by a
  // cent, which is the asymmetry `roundDivHalfAwayFromZero` exists to prevent.
  assertEquals(getXeroUnitAmountFromCents(-5, 2), -0.03);
  assertEquals(getXeroUnitAmountFromCents(5, 2), 0.03);
  assertEquals(getXeroUnitAmountFromCents(-10_001, 2), -50.01);
  assertEquals(getXeroUnitAmountFromCents(-1, 2), -0.01);
  // Symmetry as a property, not three examples.
  for (const [c, q] of [[5, 2], [10_001, 2], [25, 2], [1_918_115, 10]] as const) {
    assertEquals(
      getXeroUnitAmountFromCents(-c, q),
      -getXeroUnitAmountFromCents(c, q),
      `${c}c/${q}`,
    );
  }
});

Deno.test("getXeroUnitAmountFromCents matches exact rational arithmetic over 500k lines", () => {
  // The oracle is structurally distinct from the implementation: a single
  // reduced fraction, rounded by the DEFINITION (floor, then compare the
  // doubled remainder) rather than by the `(2n+d)/2d` identity the
  // implementation uses. A BigInt oracle that mirrors the implementation's own
  // decomposition can only ever agree with it — core#48.
  //
  // The oracle takes CENTS and returns DOLLARS, matching the function under
  // test on both sides of the boundary.
  const exact = (subtotalCents: number, quantity: number): number => {
    if (!quantity) return 0;
    const num = BigInt(subtotalCents) * 10_000n;
    const den = BigInt(Math.round(quantity * 10_000));
    const negative = num < 0n;
    const magnitude = negative ? -num : num;
    const floor = magnitude / den;
    const remainder = magnitude % den;
    const rounded = 2n * remainder >= den ? floor + 1n : floor;
    return Number(negative ? -rounded : rounded) / 100;
  };

  let seed = 777;
  // `seed >>> 8`, NOT `seed % n` on the raw seed. This LCG's low bit strictly
  // alternates (odd multiplier, odd increment), so a modulus that is even makes
  // the parity of every same-position draw a CONSTANT. The first version of
  // this sweep did exactly that and reported 0 disagreements over 500k — not
  // because the forms agree, but because it could not generate an odd cent
  // count and therefore never reached a single half-cent tie.
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };

  let checked = 0, oddCents = 0, ties = 0, wrong = 0;
  for (let i = 0; i < 500_000; i++) {
    const cents = rand(20_000_000) - 10_000_000;
    const quantity = rand(50) + 1;
    if (cents % 2 !== 0) oddCents++;
    if (2 * (Math.abs(cents) % quantity) === quantity) ties++;
    if (getXeroUnitAmountFromCents(cents, quantity) !== exact(cents, quantity)) wrong++;
    checked++;
  }
  assertEquals(checked, 500_000, "the sweep must actually have run");
  assertEquals(wrong, 0, `${wrong} of 500,000 lines disagree with exact rational arithmetic`);
  // Domain coverage, asserted separately from correctness — this is the
  // assertion whose absence hid the tie case entirely.
  assertEquals(oddCents > 100_000, true, `only ${oddCents} draws had an odd cent count`);
  assertEquals(ties > 1_000, true, `only ${ties} draws landed on an exact half-cent tie`);
});

Deno.test("…and currency.js's divide DOES disagree — the fail-closed companion", () => {
  // Measured: 18,437 of the same 500,000 lines, every one of them a negative
  // subtotal at an exact half-cent tie. currency.js was never wrong about
  // positive money here; it is wrong about the sign convention, which is why
  // this was invisible until the corpus could produce a negative tie.
  const currencyDivide = (subtotal: number, quantity: number): number => {
    if (!quantity) return 0;
    const cents = Math.round(subtotal * 100);
    return Math.round(cents / quantity) / 100; // what currency.js.divide does
  };
  const exact = (subtotal: number, quantity: number): number => {
    const num = BigInt(Math.round(subtotal * 100)) * 10_000n;
    const den = BigInt(Math.round(quantity * 10_000));
    const negative = num < 0n;
    const magnitude = negative ? -num : num;
    const floor = magnitude / den;
    const rounded = 2n * (magnitude % den) >= den ? floor + 1n : floor;
    return Number(negative ? -rounded : rounded) / 100;
  };

  let seed = 777;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  let wrong = 0;
  for (let i = 0; i < 500_000; i++) {
    const subtotal = (rand(20_000_000) - 10_000_000) / 100;
    const quantity = rand(50) + 1;
    if (currencyDivide(subtotal, quantity) !== exact(subtotal, quantity)) wrong++;
  }
  // Asserted as "disagrees", reported as a count. Asserting the remembered
  // 18,437 would mean tuning the corpus until it reproduced a number, which is
  // fitting rather than testing.
  assertEquals(wrong > 0, true, "the replaced form must be seen to fail somewhere");
  console.log(`  currency.js divide: ${wrong} of 500,000 lines wrong`);
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
    jurisdiction?: JurisdictionType | null;
  } = {},
) {
  return {
    dates: NO_DOC_DATES,
    delivery: { uid: deliveryUid, address: null, instructions: overrides.delivery?.instructions ?? null, contact: null },
    collection: { uid: collectionUid, address: null, instructions: overrides.collection?.instructions ?? null, contact: null },
    customer_collecting: overrides.customer_collecting ?? false,
    customer_returning: overrides.customer_returning ?? false,
    jurisdiction: overrides.jurisdiction ?? null,
  };
}

Deno.test("syncOrderDestinationsSelective adds new pairs tagged with uid_order", () => {
  const prev = [makePair("d1", "c1")];
  const next = [makePair("d1", "c1"), makePair("d2", "c2")];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1") }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 2);
  assertEquals(result[1].delivery.uid, "d2");
  assertEquals(result[1].uid_order, "o1");
});

Deno.test("syncOrderDestinationsSelective replaces synced pairs with new order data", () => {
  const prev = [makePair("d1", "c1", { delivery: { instructions: "old" } })];
  const next = [makePair("d1", "c1", { delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { delivery: { instructions: "old" } }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].delivery.instructions, "new");
});

Deno.test("syncOrderDestinationsSelective keeps overridden pairs (invoice differs from prev)", () => {
  const prev = [makePair("d1", "c1", { delivery: { instructions: "orig" } })];
  const next = [makePair("d1", "c1", { delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { delivery: { instructions: "manual edit" } }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
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
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
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
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result.length, 2);
  assertEquals(result[1].delivery.instructions, "manual edit");
});

// ── api-cloudrun#663: the loop-2 path where `prev` is MISSING ──────
//
// 🔴 **Ten tests exercised this function and every loop-2 test supplied a
// DEFINED `prev`.** The path below — an invoice pair whose key names no pair on
// the order, in either version — was untested, which is how it reached
// production. Prod 2026-08-24: 239 of 989 invoice pairs are in this state.
//
// ⚠️ The point of the pair of tests is the ASYMMETRY, not the drop. `prev ===
// undefined` means KEEP in loop 1 and DROP in loop 2, so both are asserted
// here, adjacently, where a future edit to one has to look at the other.

Deno.test("syncOrderDestinationsSelective: prev MISSING + still on the order ⇒ loop 1 KEEPS the invoice pair", () => {
  // The order has this key now but did NOT have it before, so `prev` is
  // undefined. Loop 1 falls to "Overridden (or prev missing) — keep".
  const prev: ReturnType<typeof makePair>[] = [];
  const next = [makePair("d1", "c1", { jurisdiction: "chicago" })];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1", { jurisdiction: "rantoul" }) },
  ];
  const { destinations, dropped } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(destinations.length, 1);
  assertEquals(destinations[0].jurisdiction, "rantoul", "the invoice's own value survives");
  assertEquals(dropped.length, 0);
});

Deno.test("syncOrderDestinationsSelective: prev MISSING + NOT on the order ⇒ loop 2 DROPS it, and says so", () => {
  // Same `prev === undefined`, opposite outcome — the invoice pair names a key
  // the order carries in neither version, so nothing is ever compared to it.
  const prev: ReturnType<typeof makePair>[] = [];
  const next = [makePair("d1", "c1")];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o1", ...makePair("d-other", "c-other", { jurisdiction: "rantoul" }) },
  ];
  const { destinations, dropped } = syncOrderDestinationsSelective(prev, next, invoice, "o1");

  assertEquals(destinations.length, 1, "the unmatched invoice pair is gone");
  assertEquals(destinations[0].delivery.uid, "d1");

  assertEquals(dropped.length, 1);
  assertEquals(dropped[0].reason, "key_names_no_order_pair");
  assertEquals(dropped[0].delivery_uid, "d-other");
  assertEquals(dropped[0].jurisdiction, "rantoul", "the value that priced its lines");
  assertEquals(dropped[0].uid_order, "o1");
});

Deno.test("syncOrderDestinationsSelective: an ORDINARY removal reports a different reason", () => {
  // `prev` exists and matches, so the order genuinely deleted a pair the
  // invoice had not edited. Same drop, different event — and a caller that
  // treated the two alike would warn on every legitimate deletion.
  const prev = [makePair("d1", "c1"), makePair("d2", "c2")];
  const next = [makePair("d1", "c1")];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o1", ...makePair("d2", "c2") },
  ];
  const { dropped } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(dropped.length, 1);
  assertEquals(dropped[0].reason, "removed_from_order");
  assertEquals(dropped[0].jurisdiction, null);
});

Deno.test("syncOrderDestinationsSelective: a dropped pair from ANOTHER order is never reported", () => {
  // Out-of-scope pairs pass through untouched, so they cannot be dropped and
  // must not appear in the report — a warn naming another order's pair would
  // send an operator to the wrong document.
  const prev = [makePair("d1", "c1")];
  const next = [makePair("d1", "c1")];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o2", ...makePair("d9", "c9", { jurisdiction: "rantoul" }) },
  ];
  const { destinations, dropped } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(destinations.length, 2);
  assertEquals(dropped.length, 0);
});

Deno.test("syncOrderDestinationsSelective leaves out-of-scope (other-order) pairs untouched", () => {
  const prev = [makePair("d1", "c1")];
  const next: ReturnType<typeof makePair>[] = [];
  const invoice: InvoiceDestinationPair[] = [
    { uid_order: "o1", ...makePair("d1", "c1") },
    { uid_order: "o2", ...makePair("dX", "cX") },
  ];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
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

/**
 * The sync context every `computeInvoiceSyncStatus` call needs (api-cloudrun#481).
 *
 * `NO_EXPLANATIONS` is the deliberate default for the pre-existing tests: an
 * EMPTY tax map plus a LIVE order, so no explainer can fire and every assertion
 * below still measures the raw comparison it was written to measure. A context
 * that quietly explained things away would rewrite those tests without touching
 * them.
 */
const NO_EXPLANATIONS = { taxNameByUid: new Map<string, string>(), orderFrozen: false };

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
    base_cents: 10000, chargeable_days: 5, formula: "five_day_week",
    subtotal_cents: 20000, subtotal_discounted_cents: 20000, discount: null, taxes: [], total_cents: 20000, replacement_cents: 500000,
  },
} as unknown as LineItem;
const RESYNC_LINE_B: LineItem = {
  uid: ITEM_2, type: "sale", name: "Tripod", quantity: 1, path: [DEST_1, ITEM_2],
  stock_method: "reserve", order_number: 1001, uid_order: ORDER_ID_1, zero_priced: false,
  price: {
    base_cents: 30000, chargeable_days: null, formula: "fixed",
    subtotal_cents: 30000, subtotal_discounted_cents: 30000, discount: null, taxes: [], total_cents: 30000, replacement_cents: 0,
  },
} as unknown as LineItem;
const RESYNC_ORDER_ITEMS: LineItem[] = [RESYNC_DEST, RESYNC_LINE_A, RESYNC_LINE_B];

const KEY_DEST = [ORDER_DIV_1, DEST_1].join("/");
const KEY_A = [ORDER_DIV_1, DEST_1, ITEM_1].join("/");
const KEY_B = [ORDER_DIV_1, DEST_1, ITEM_2].join("/");

// In-sync invoice baseline: order divider + the exact projection of the order.
function baselineInvoice(): InvoiceDocItemType[] {
  return [orderDivider, ...buildOrderScopedItems(RESYNC_ORDER_ITEMS, ORDER_DIV_1)];
}

// Order where line A grew from qty 2 → 9 (invoice not yet resynced).
function changedOrderItems(): LineItem[] {
  const priceA = (RESYNC_LINE_A as unknown as { price: Record<string, unknown> }).price;
  return [
    RESYNC_DEST,
    { ...RESYNC_LINE_A, quantity: 9, price: { ...priceA, subtotal_cents: 90000, subtotal_discounted_cents: 90000, total_cents: 90000 } } as unknown as LineItem,
    RESYNC_LINE_B,
  ];
}

Deno.test("computeInvoiceSyncStatus: all lines in_sync when invoice matches the order projection", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), RESYNC_ORDER_ITEMS, ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_DEST), "in_sync");
  assertEquals(status.get(KEY_A), "in_sync");
  assertEquals(status.get(KEY_B), "in_sync");
});

Deno.test("computeInvoiceSyncStatus: only the changed line is out_of_sync", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), changedOrderItems(), ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_A), "out_of_sync"); // qty changed on the order
  assertEquals(status.get(KEY_B), "in_sync"); // untouched
});

Deno.test("computeInvoiceSyncStatus: invoice-only overrides do not count as drift", () => {
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000abc" } as InvoiceItem) : it
  );
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_A), "in_sync"); // coa_revenue / xero_id excluded from comparison
});

Deno.test("computeInvoiceSyncStatus: a CRMS-authored line is in_sync — the corpus-wide false positive", () => {
  // `invoiceProjectionMatches` compares KEY SETS before values, so before
  // 2026-08-10 a line carrying `crms_id` had one more comparable key than its
  // projection and reported `out_of_sync` — every CRMS-authored line in the
  // corpus, with nothing thrown. Same mechanism as the documented
  // `base_percent` case in `api-cloudrun/src/services/invoices.ts`.
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, crms_id: 8812, crms_opportunity_id: 5501 } as InvoiceItem) : it
  );
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_A), "in_sync");
  assertEquals(status.get(KEY_B), "in_sync"); // sibling without the field, unaffected
});

Deno.test("fail-closed companion: excluding only the original four still reports out_of_sync", () => {
  // Executes the pre-fix exclusion list for real against the same corpus shape,
  // so the assertion above cannot quietly become a restatement of the code.
  const FOUR = new Set(["coa_revenue", "tracking_category", "xero_id", "xero_tracking_option_id"]);
  const comparableKeys = (it: Record<string, unknown>, exclude: ReadonlySet<string>) =>
    Object.keys(it).filter((k) => !exclude.has(k));

  const projected = buildOrderScopedItems(RESYNC_ORDER_ITEMS, ORDER_DIV_1)
    .find((i) => i.uid === ITEM_1)! as unknown as Record<string, unknown>;
  const stored = { ...projected, crms_id: 8812 };

  // Under the old four-field list the key sets differ → `out_of_sync`.
  assertEquals(
    comparableKeys(stored, FOUR).length === comparableKeys(projected, FOUR).length,
    false,
    "the four-field exclusion must still mismatch — otherwise this companion proves nothing",
  );
  // Under the six-field list they agree, which is what the test above observes.
  const SIX = new Set([...FOUR, "crms_id", "crms_opportunity_id"]);
  assertEquals(comparableKeys(stored, SIX).length, comparableKeys(projected, SIX).length);
});

Deno.test("computeInvoiceSyncStatus: order line missing from the invoice is out_of_sync", () => {
  const inv = baselineInvoice().filter((it) => it.uid !== ITEM_2);
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_B), "out_of_sync");
});

Deno.test("computeInvoiceSyncStatus: invoice line the order dropped is out_of_sync", () => {
  const status = computeInvoiceSyncStatus(baselineInvoice(), [RESYNC_DEST, RESYNC_LINE_A], ORDER_DIV_1, NO_EXPLANATIONS);
  assertEquals(status.get(KEY_B), "out_of_sync");
});

Deno.test("resyncInvoiceLines per-line: re-projects only the targeted line, sibling untouched", () => {
  const result = resyncInvoiceLines(baselineInvoice(), changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const a = result.find((i) => i.uid === ITEM_1)!;
  const b = result.find((i) => i.uid === ITEM_2)!;
  assertEquals(asLine(a).quantity, 9); // snapped to the order
  assertEquals(asLine(b).quantity, 1); // sibling untouched
  assertEquals((asLine(a).price as { subtotal_cents: number }).subtotal_cents, 90000);
});

Deno.test("resyncInvoiceLines per-line: carries forward invoice-only override fields", () => {
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, coa_revenue: 4100, xero_id: "00000000-0000-4000-8000-000000000abc" } as InvoiceDocItemType) : it
  );
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const a = asLine(result.find((i) => i.uid === ITEM_1)!);
  assertEquals(a.quantity, 9); // body snapped to the order
  assertEquals(a.coa_revenue, 4100); // override preserved
  assertEquals(a.xero_id, "00000000-0000-4000-8000-000000000abc");
});

Deno.test("resyncInvoiceLines per-line: an untargeted overridden line is left as-is", () => {
  const inv = baselineInvoice().map((it) => (it.uid === ITEM_2 ? { ...it, quantity: 7 } : it));
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  assertEquals(asLine(result.find((i) => i.uid === ITEM_2)!).quantity, 7); // override kept
});

Deno.test("resyncInvoiceLines per-line: a target the order dropped is left untouched (not removed)", () => {
  const result = resyncInvoiceLines(baselineInvoice(), [RESYNC_DEST, RESYNC_LINE_A], ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_2]]);
  assertEquals(result.find((i) => i.uid === ITEM_2) !== undefined, true);
});

Deno.test("resyncInvoiceLines whole: snaps every scoped line back to the order, discarding overrides", () => {
  const inv = baselineInvoice().map((it) => (it.uid === ITEM_2 ? { ...it, quantity: 7 } : it));
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1);
  assertEquals(asLine(result.find((i) => i.uid === ITEM_1)!).quantity, 9); // order value
  assertEquals(asLine(result.find((i) => i.uid === ITEM_2)!).quantity, 1); // override discarded
});

Deno.test("resyncInvoiceLines: leaves other order dividers' scopes untouched", () => {
  const inv = [...baselineInvoice(), orderDivider2, lineItem3];
  const result = resyncInvoiceLines(inv, changedOrderItems(), ORDER_DIV_1, [[ORDER_DIV_1, DEST_1, ITEM_1]]);
  const l3 = result.find((i) => i.uid === ITEM_3)!;
  assertEquals(asLine(l3).quantity, 1);
  assertEquals(l3.path, [ORDER_DIV_2, ITEM_3]);
});

// ── Item 2: the shared totals fold ──────────────────────────────
//
// `calculateOrderTotals` and `calculateInvoiceTotals` were ~35 byte-identical
// lines each; both now delegate to `sumDocumentTotals`. The extraction is only
// output-identical if the ONE structural difference between the two bodies —
// the invoice path's `flattenForXero` prefilter — is arithmetically inert.
//
// That was argued in prose (dividers are `kind: "divider"`, every divider has
// `pricing: "none"`, every predicate in the fold gates on `pricing`) and
// nothing ran it. Prose is exactly the shape this campaign keeps finding
// wrong, so it runs now.

interface SweepDoc {
  items: InvoiceItem[];
  dividers: number;
}

/** Seeded LCG — same generator as `orders.test.ts`, so runs are reproducible. */
function sweepDocs(count: number): SweepDoc[] {
  let seed = 424_242_424;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // High bits, not low: this LCG's low bit strictly alternates, so `% n` on
    // an even `n` freezes the parity of every same-position draw.
    return (seed >>> 8) % n;
  };
  const PRE_TAX = ["rental", "sale", "service", "surcharge"] as const;
  const TAX_UIDS = ["chi-rental-tax", "chi-sales-tax"] as const;

  const docs: SweepDoc[] = [];
  for (let d = 0; d < count; d++) {
    const items: InvoiceItem[] = [];
    let dividers = 0;
    // Every doc opens with an order divider, so the prefilter always has
    // something to drop and the two paths are never trivially equal.
    items.push({ uid: `o-${d}`, type: "order", name: `Order ${d}`, path: [] } as InvoiceItem);
    dividers++;
    const lines = 1 + rand(6);
    for (let i = 0; i < lines; i++) {
      if (rand(4) === 0) {
        items.push({
          uid: `dv-${d}-${i}`,
          type: rand(2) === 0 ? "destination" : "group",
          name: "Divider",
          path: [],
        } as InvoiceItem);
        dividers++;
        continue;
      }
      if (rand(8) === 0) {
        items.push(makeItem({ uid: `f-${d}-${i}`, type: "transaction_fee", quantity: 1 }, {
          formula: "percent_of_total",
          // A PERCENTAGE (0–6%), in its own field. Drawing this into
          // `base_cents` is the 100× D1 exists to prevent, and it would make
          // every fee in the corpus a dollar amount instead of a rate.
          base_cents: 0,
          base_percent: rand(600) / 100,
        }));
        continue;
      }
      const withDiscount = rand(3) !== 0;
      items.push(makeItem({ uid: `l-${d}-${i}`, type: PRE_TAX[rand(4)], quantity: 1 + rand(9) }, {
        base_cents: rand(200_000),
        chargeable_days: rand(40),
        formula: rand(2) === 0 ? "five_day_week" : "fixed",
        taxes: rand(2) === 0 ? [] : [{ uid: TAX_UIDS[rand(2)] }],
        ...(withDiscount
          ? {
            discount: rand(2) === 0
              ? { type: "percent", rate: rand(1_000_000) / 10_000, amount_cents: 0 }
              : { type: "flat", rate: rand(20_000) / 100, amount_cents: 0 },
          }
          : {}),
      }));
    }
    docs.push({ items, dividers });
  }
  return docs;
}

const DOC_SWEEP = sweepDocs(20_000);

/** The six fields both documents compute identically. */
const core = (t: Record<string, unknown>) =>
  JSON.stringify([
    t.discount_amount_cents,
    t.subtotal_cents,
    t.subtotal_discounted_cents,
    t.taxes,
    t.transaction_fees,
    t.total_cents,
  ]);

Deno.test("order and invoice totals agree on their six shared fields over 20k random documents", () => {
  let disagreements = 0;
  let first: string | null = null;
  for (const doc of DOC_SWEEP) {
    const fromOrder = core(calculateOrderTotals(doc.items, TAXES) as unknown as Record<string, unknown>);
    const fromInvoice = core(calculateInvoiceTotals(doc.items, TAXES, []) as unknown as Record<string, unknown>);
    const fromCore = core(sumDocumentTotals(doc.items, TAXES) as unknown as Record<string, unknown>);
    if (fromOrder !== fromInvoice || fromOrder !== fromCore) {
      disagreements++;
      first ??= `order ${fromOrder}\ninvoice ${fromInvoice}\ncore ${fromCore}`;
    }
  }
  assertEquals(disagreements, 0, first ?? "");
});

Deno.test("…and the sweep is not vacuous — dividers, discounts, taxes, fees and money are all present", () => {
  // A corpus of empty documents would satisfy the equality above and prove
  // nothing. Each of these is a precondition of the claim being tested, so each
  // is asserted rather than assumed.
  let dropped = 0;
  let discounted = 0;
  let taxed = 0;
  let feed = 0;
  let nonZero = 0;
  for (const doc of DOC_SWEEP) {
    if (flattenForXero(doc.items).length < doc.items.length) dropped++;
    const t = calculateInvoiceTotals(doc.items, TAXES, []);
    if (t.discount_amount_cents !== 0) discounted++;
    if (t.taxes.length > 0) taxed++;
    if (t.transaction_fees.length > 0) feed++;
    if (t.total_cents !== 0) nonZero++;
  }
  assertEquals(dropped, DOC_SWEEP.length, "every doc must have a divider for the prefilter to drop");
  assertEquals(discounted > 0, true, "no discounted document in the corpus");
  assertEquals(taxed > 0, true, "no taxed document in the corpus");
  assertEquals(feed > 0, true, "no transaction-fee document in the corpus");
  assertEquals(nonZero > 0, true, "every document totalled zero");
  console.log(
    `  ${DOC_SWEEP.length} docs: ${discounted} discounted, ${taxed} taxed, ` +
      `${feed} with fees, ${nonZero} non-zero`,
  );
});

Deno.test("…and a prefilter that drops a PRICEABLE type DOES disagree — the equality can fail", () => {
  // Fail-closed companion. The equality above holds because `flattenForXero`
  // only removes `pricing: "none"` members; a filter that reaches one line
  // further must break it. Without this, a `flattenForXero` that had quietly
  // started dropping billable lines would still pass the test above on a corpus
  // that happened to contain none.
  let disagreements = 0;
  for (const doc of DOC_SWEEP) {
    const overFiltered = doc.items.filter((i) => i.type !== "service");
    if (
      core(sumDocumentTotals(doc.items, TAXES) as unknown as Record<string, unknown>) !==
        core(sumDocumentTotals(overFiltered, TAXES) as unknown as Record<string, unknown>)
    ) disagreements++;
  }
  assertEquals(
    disagreements > 0,
    true,
    "dropping every `service` line changed no document's totals — the corpus has stopped discriminating",
  );
  console.log(`  over-filtering changes ${disagreements} of ${DOC_SWEEP.length} documents`);
});

Deno.test("validateInvoiceItemPaths still recomputes at INVOICE depth after the collapse", () => {
  // `validateItemPaths` and `validateInvoiceItemPaths` now share one body
  // parameterised on the recompute — which is precisely the shape that could
  // hand invoice items the ORDER hierarchy and silently drop every `order`
  // divider from every path. A doc whose paths are correct at invoice depth and
  // WRONG at order depth is what tells the two apart.
  const items: InvoiceItem[] = [
    { ...orderDivider, path: [ORDER_DIV_1] } as InvoiceItem,
    { ...destItem, path: [ORDER_DIV_1, DEST_1] } as InvoiceItem,
    makeItem({ uid: ITEM_1, type: "rental", path: [ORDER_DIV_1, DEST_1, ITEM_1] }),
  ];
  assertEquals(validateInvoiceItemPaths(items), []);
  // The same array judged at ORDER depth: `order` is not one of
  // `ORDER_ITEM_LEVELS`, so the divider opens no level and every row beneath it
  // loses that leading segment. Asserted on the expected path rather than an
  // issue count — a count says only "something differs", and what matters is
  // WHICH segment goes missing.
  const atOrderDepth = validateItemPaths(items);
  assertEquals(atOrderDepth.length > 0, true, "order depth agreed with invoice depth");
  assertEquals(atOrderDepth.find((i) => i.uid === ITEM_1)?.expected, [DEST_1, ITEM_1]);
});

// ══════════════════════════════════════════════════════════════════
// invoiceItemsMatch — the one comparator (api-cloudrun#480, core#52)
// ══════════════════════════════════════════════════════════════════

const GROUP_1 = "00000000-0000-4000-8000-0000000009a1";
const GROUP_2 = "00000000-0000-4000-8000-0000000009a2";

/** The projection of `RESYNC_LINE_A`, i.e. what a native invoice stores. */
function projectedLineA(): InvoiceItem {
  return buildOrderScopedItems([RESYNC_LINE_A], ORDER_DIV_1)[0] as InvoiceItem;
}

/** The pre-2026-08-10 comparison, executed for real. @see the companions below. */
function blobComparison(expected: InvoiceItem, current: InvoiceItem): boolean {
  const INVOICE_ONLY = new Set([
    "coa_revenue", "tracking_category", "xero_id", "xero_tracking_option_id", "crms_id", "crms_opportunity_id",
  ]);
  const keys = (it: InvoiceItem) => Object.keys(it).filter((k) => !INVOICE_ONLY.has(k));
  const e = expected as unknown as Record<string, unknown>;
  const c = current as unknown as Record<string, unknown>;
  const eKeys = keys(expected);
  const cKeys = keys(current);
  if (eKeys.length !== cKeys.length) return false;
  const cSet = new Set(cKeys);
  for (const k of eKeys) if (!cSet.has(k)) return false;
  for (const k of eKeys) if (JSON.stringify(e[k]) !== JSON.stringify(c[k])) return false;
  return true;
}

Deno.test("invoiceItemsMatch: an absent nullable price key equals an explicit null", () => {
  // The projection emits `base_percent: null`; a stored CRMS line omits the key.
  // `InvoiceDocItemPriceSchema` declares it `.nullable().optional()` and blesses
  // BOTH encodings, so a comparator that separates them is reporting a
  // difference the schema says does not exist.
  const expected = projectedLineA();
  const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  delete stored.price.base_percent;
  assertEquals(invoiceItemsMatch(expected, stored as unknown as InvoiceItem), true);

  // Both encodings really are legal — probed, not asserted from memory.
  assertEquals(InvoiceDocLineItemSchema.safeParse(expected).success, true);
  assertEquals(InvoiceDocLineItemSchema.safeParse(stored).success, true);
});

Deno.test("fail-closed companion: the old JSON-blob price comparison DISAGREES", () => {
  // Executes the pre-fix comparison for real against the same pair, so the
  // assertion above cannot quietly become a restatement of the new code.
  const expected = projectedLineA();
  const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  delete stored.price.base_percent;
  assertEquals(
    blobComparison(expected, stored as unknown as InvoiceItem),
    false,
    "the blob comparison must still fail — otherwise this companion proves nothing",
  );
});

Deno.test("invoiceItemsMatch: a stored unknown price key still reports a mismatch", () => {
  // `discount_percent` was once the dominant cause on prod — 8,015 of 8,978
  // paired lines — and was never excluded here: the field was removed from the
  // schema and the corpus (api-cloudrun#480) rather than policed by an exclusion
  // list. The key is gone, so this now guards the general rule that outlived it:
  // a stored key the projection does not emit is a mismatch, whatever it is.
  // Keep it stated with a key no schema declares — pointing it at a live field
  // would make it a duplicate of some other test the day that field changes.
  const expected = projectedLineA();
  const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  stored.price.legacy_unknown_key = 0;
  assertEquals(invoiceItemsMatch(expected, stored as unknown as InvoiceItem), false);
});

Deno.test("invoiceItemsMatch: key ORDER inside price is not a difference", () => {
  // A projection emits keys in source order; a Firestore map comes back sorted.
  // `JSON.stringify` is key-order sensitive, so the blob form called two deeply
  // equal prices different — a second, silent contributor to the same badge.
  const expected = projectedLineA();
  const price = (expected as unknown as { price: Record<string, unknown> }).price;
  const reordered = Object.fromEntries(Object.entries(price).reverse());
  const stored = { ...expected, price: reordered } as unknown as InvoiceItem;
  assertEquals(invoiceItemsMatch(expected, stored), true);
  assertEquals(
    JSON.stringify(price) === JSON.stringify(reordered),
    false,
    "the reordering must actually change the blob — otherwise this proves nothing",
  );
});

Deno.test("invoiceItemsMatch: a real value change on any compared price key still mismatches", () => {
  const expected = projectedLineA();
  for (const [k, v] of Object.entries((expected as unknown as { price: Record<string, unknown> }).price)) {
    const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
    // Move the value to something genuinely different, whatever its type.
    stored.price[k] = typeof v === "number" ? v + 1 : v === null ? 7 : Array.isArray(v) ? [{ uid: "x" }] : "changed";
    assertEquals(
      invoiceItemsMatch(expected, stored as unknown as InvoiceItem),
      false,
      `price.${k} changed and the comparator still called it in_sync`,
    );
  }
  // …and a non-price key too, so the structural branch has not swallowed the rest.
  assertEquals(invoiceItemsMatch(expected, { ...expected, quantity: 99 } as InvoiceItem), false);
});

// ══════════════════════════════════════════════════════════════════
// invoiceItemDifferences — the comparator's substrate (api-cloudrun#481)
// ══════════════════════════════════════════════════════════════════

/**
 * The comparator EXACTLY as it stood before `invoiceItemDifferences` existed,
 * executed for real.
 *
 * ⚠️ Asserting `invoiceItemsMatch(a,b) === (invoiceItemDifferences(a,b).length
 * === 0)` would prove nothing — the boolean is now DEFINED as that emptiness, so
 * the two agree by construction. A behaviour-preservation claim needs an oracle
 * that is not the implementation, which is what this is.
 */
function legacyItemsMatch(expected: InvoiceItem, current: InvoiceItem): boolean {
  const INVOICE_ONLY = new Set([
    "coa_revenue", "tracking_category", "xero_id", "xero_tracking_option_id", "crms_id", "crms_opportunity_id",
  ]);
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => JSON.stringify(k) + ":" + stable(x)).join(",") + "}";
  };
  const pricesMatch = (e0: unknown, c0: unknown): boolean => {
    const norm = (p: unknown): Record<string, unknown> | null => {
      if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        out[k] = v;
      }
      return out;
    };
    const e1 = norm(e0), c1 = norm(c0);
    if (e1 === null || c1 === null) return stable(e0) === stable(c0);
    const ks = Object.keys(e1);
    if (ks.length !== Object.keys(c1).length) return false;
    for (const k of ks) {
      if (!(k in c1)) return false;
      if (stable(e1[k]) !== stable(c1[k])) return false;
    }
    return true;
  };
  const comparable = (it: InvoiceItem) => {
    const rec = it as unknown as Record<string, unknown>;
    return Object.keys(rec).filter((k) => !INVOICE_ONLY.has(k) && rec[k] !== undefined);
  };
  const eKeys = comparable(expected), cKeys = comparable(current);
  if (eKeys.length !== cKeys.length) return false;
  const cSet = new Set(cKeys);
  for (const k of eKeys) if (!cSet.has(k)) return false;
  const e = expected as unknown as Record<string, unknown>;
  const c = current as unknown as Record<string, unknown>;
  for (const k of eKeys) {
    if (k === "price") {
      if (!pricesMatch(e[k], c[k])) return false;
      continue;
    }
    if (stable(e[k]) !== stable(c[k])) return false;
  }
  return true;
}

/** Every mutation the sweep below applies, as (label, mutate) pairs. */
function mutations(): Array<[string, (it: InvoiceItem) => InvoiceItem]> {
  const withPrice = (fn: (p: Record<string, unknown>) => void) => (it: InvoiceItem): InvoiceItem => {
    const next = structuredClone(it) as unknown as { price: Record<string, unknown> };
    fn(next.price);
    return next as unknown as InvoiceItem;
  };
  return [
    ["unchanged", (it) => structuredClone(it)],
    ["quantity changed", (it) => ({ ...it, quantity: 99 } as InvoiceItem)],
    ["name changed", (it) => ({ ...it, name: "Something else" } as InvoiceItem)],
    ["price.total_cents changed", withPrice((p) => { p.total_cents = 12345; })],
    ["price.taxes changed", withPrice((p) => { p.taxes = [{ uid: "x", name: "T", rate: 9, amount_cents: 1 }]; })],
    ["price.base_percent dropped (absent ≡ null)", withPrice((p) => { delete p.base_percent; })],
    ["price.chargeable_days nulled", withPrice((p) => { p.chargeable_days = null; })],
    ["an unknown price key added", withPrice((p) => { p.legacy_unknown_key = 0; })],
    ["price key order reversed", (it) => {
      const p = (it as unknown as { price: Record<string, unknown> }).price;
      return { ...it, price: Object.fromEntries(Object.entries(p).reverse()) } as unknown as InvoiceItem;
    }],
    ["a top-level key dropped", (it) => {
      const next = structuredClone(it) as unknown as Record<string, unknown>;
      delete next.description;
      return next as unknown as InvoiceItem;
    }],
    ["a top-level key added", (it) => ({ ...it, unexpected_key: 1 } as unknown as InvoiceItem)],
    ["invoice-only fields set", (it) => ({
      ...it,
      coa_revenue: 4100,
      xero_id: "00000000-0000-4000-8000-000000000abc",
      crms_id: 55,
    } as unknown as InvoiceItem)],
    ["price replaced by a non-object", (it) => ({ ...it, price: 7 } as unknown as InvoiceItem)],
  ];
}

Deno.test("invoiceItemDifferences: empty EXACTLY when the pre-refactor comparator agreed", () => {
  const expected = projectedLineA();
  for (const [label, mutate] of mutations()) {
    const current = mutate(expected);
    assertEquals(
      invoiceItemDifferences(expected, current).length === 0,
      legacyItemsMatch(expected, current),
      `"${label}": the differences form disagrees with the comparator it replaced`,
    );
  }
});

Deno.test("invoiceItemDifferences: names the field, and only the field, that differs", () => {
  const expected = projectedLineA();
  assertEquals(invoiceItemDifferences(expected, expected), []);
  assertEquals(invoiceItemDifferences(expected, { ...expected, quantity: 99 } as InvoiceItem), ["quantity"]);

  const priced = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  priced.price.total_cents = 12345;
  assertEquals(invoiceItemDifferences(expected, priced as unknown as InvoiceItem), ["price.total_cents"]);
});

Deno.test("invoiceItemDifferences: a key the CURRENT line carries and the projection does not is named", () => {
  // The count check this replaced could see that the key sets differed but not
  // which key it was — and a histogram exists to answer exactly that. Both
  // directions, because only one of them was ever iterated.
  const expected = projectedLineA();
  const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  stored.price.legacy_unknown_key = 0;
  assertEquals(invoiceItemDifferences(expected, stored as unknown as InvoiceItem), ["price.legacy_unknown_key"]);

  const extra = { ...expected, unexpected_key: 1 } as unknown as InvoiceItem;
  assertEquals(invoiceItemDifferences(expected, extra), ["unexpected_key"]);
});

Deno.test("invoiceItemDifferences: an invoice-only override is never a difference", () => {
  const expected = projectedLineA();
  const overridden = {
    ...expected,
    coa_revenue: 4100,
    xero_id: "00000000-0000-4000-8000-000000000abc",
    crms_id: 55,
  } as unknown as InvoiceItem;
  assertEquals(invoiceItemDifferences(expected, overridden), []);
});

Deno.test("invoiceItemDifferences: every compared price key is reachable, none collapse into `price`", () => {
  // The bare `price` member is the non-object fallback ONLY. If a real key
  // change reported `price`, a histogram would bucket the whole money surface
  // into one bar and say nothing.
  const expected = projectedLineA();
  for (const [k, v] of Object.entries((expected as unknown as { price: Record<string, unknown> }).price)) {
    const stored = structuredClone(expected) as unknown as { price: Record<string, unknown> };
    stored.price[k] = typeof v === "number" ? v + 1 : v === null ? 7 : Array.isArray(v) ? [{ uid: "x" }] : "changed";
    assertEquals(
      invoiceItemDifferences(expected, stored as unknown as InvoiceItem),
      [`price.${k}`],
      `price.${k} changed and the differences form did not name it`,
    );
  }
  // …and the fallback still reports the bare field when `price` is not an object.
  assertEquals(invoiceItemDifferences(expected, { ...expected, price: 7 } as unknown as InvoiceItem), ["price"]);
});

Deno.test("projectOrderItemToInvoiceItem: the export IS what the sync path compares against", () => {
  // The whole reason it is exported (api-cloudrun#481): a probe comparing an
  // invoice line to `projectOrderItemToInvoiceItem(orderLine)` must be asking
  // the same question the badge asks. If these two ever diverged, every probe
  // and audit built on the export would be measuring something else.
  for (const orderItem of RESYNC_ORDER_ITEMS) {
    assertEquals(
      projectOrderItemToInvoiceItem(orderItem, ORDER_DIV_1),
      buildOrderScopedItems([orderItem], ORDER_DIV_1)[0],
      `projection drifted from buildOrderScopedItems for ${orderItem.type}`,
    );
  }
});

Deno.test("isItemSynced: an ORDER-shaped line matches its own projection — core#52", () => {
  // The regression the whole draft mirror rested on. `stock_method` is required
  // on a stored order line and rejected by the strict invoice line schema, so
  // comparing the two shapes directly could never agree and the mirror
  // propagated additions only — never an edit, never a removal.
  const orderLine = orderShapedLine();
  const invoiceLine = buildOrderScopedItems([orderLine], ORDER_DIV_1)[0] as InvoiceItem;
  assertEquals(isItemSynced(orderLine, invoiceLine, ORDER_DIV_1), true);
  // The fixture is not vacuous: it really does carry the order-only fields.
  assertEquals(typeof (orderLine as unknown as Record<string, unknown>).stock_method, "string");
  assertEquals(
    typeof (orderLine.price as unknown as Record<string, unknown>).replacement_cents,
    "number",
  );
});

Deno.test("fail-closed companion: comparing the two SHAPES directly still disagrees", () => {
  const orderLine = orderShapedLine();
  const invoiceLine = buildOrderScopedItems([orderLine], ORDER_DIV_1)[0] as InvoiceItem;
  assertEquals(
    blobComparison(orderLine as unknown as InvoiceItem, invoiceLine),
    false,
    "the un-projected comparison must still fail — otherwise core#52 was never real",
  );
});

Deno.test("isItemSynced: a genuine override is still detected", () => {
  const orderLine = orderShapedLine();
  const overridden = {
    ...buildOrderScopedItems([orderLine], ORDER_DIV_1)[0],
    name: "Operator renamed this",
  } as InvoiceItem;
  assertEquals(isItemSynced(orderLine, overridden, ORDER_DIV_1), false);
});

// ══════════════════════════════════════════════════════════════════
// adoptOrderDividerStructure / invoiceScopeDividersMatch
// ══════════════════════════════════════════════════════════════════

/** An order carrying a group divider the CRMS invoice tree omits. */
function groupedOrderItems(): LineItem[] {
  return computeItemPaths([
    { ...RESYNC_DEST, path: [] },
    { uid: GROUP_1, type: "group", name: "Lighting", description: "", path: [] } as LineItem,
    { ...RESYNC_LINE_A, path: [] } as LineItem,
    { ...RESYNC_LINE_B, path: [] } as LineItem,
  ]);
}

/** The flat, divider-less shape the CRMS invoice webhook produces today. */
function flatInvoiceScope(): InvoiceDocItemType[] {
  return computeInvoiceItemPaths([
    orderDivider,
    ...buildOrderScopedItems(
      [{ ...RESYNC_LINE_A, path: [] } as LineItem, { ...RESYNC_LINE_B, path: [] } as LineItem],
      ORDER_DIV_1,
    ),
  ]);
}

Deno.test("adoptOrderDividerStructure: an aligned pair is a structural no-op", () => {
  const before = computeInvoiceItemPaths(
    [orderDivider, ...buildOrderScopedItems(groupedOrderItems(), ORDER_DIV_1)],
  );
  const { items, ambiguous } = adoptOrderDividerStructure(before, groupedOrderItems(), ORDER_DIV_1);
  assertEquals(ambiguous, []);
  assertEquals(items, before);
});

Deno.test("adoptOrderDividerStructure: a flat invoice gains the order's dividers and nothing else moves", () => {
  const order = groupedOrderItems();
  const before = flatInvoiceScope();
  const { items } = adoptOrderDividerStructure(before, order, ORDER_DIV_1);

  // The order's whole divider skeleton is now present, by uid and by path.
  assertEquals(invoiceScopeDividersMatch(before as InvoiceItem[], order, ORDER_DIV_1), false);
  assertEquals(invoiceScopeDividersMatch(items as InvoiceItem[], order, ORDER_DIV_1), true);

  // Not one line was added, removed, re-priced, re-named or re-quantified.
  const lineKey = (its: InvoiceDocItemType[]) =>
    its.filter((it) => isInvoiceLineItem(it))
      .map((it) => JSON.stringify({ ...it, path: undefined }))
      .sort();
  assertEquals(lineKey(items), lineKey(before));

  // …and the result is a fixed point of the normalizer the caller runs next.
  assertEquals(validateInvoiceItemPaths(computeInvoiceItemPaths(items)), []);
  assertEquals(validateInvoiceItemPaths(items), []);
  assertEquals(validateInvoiceItemUniqueness(items), []);
  assertEquals(items.find((it) => it.uid === ITEM_1)?.path, [ORDER_DIV_1, DEST_1, GROUP_1, ITEM_1]);
});

Deno.test("adoptOrderDividerStructure: an invoice-only line is KEPT, at the root of the scope", () => {
  const order = groupedOrderItems();
  const custom = makeItem({
    uid: "custom-00000000-0000-4000-8000-00000000c001",
    type: "sale",
    name: "Rush fee",
    path: [ORDER_DIV_1, "custom-00000000-0000-4000-8000-00000000c001"],
  }) as unknown as InvoiceDocItemType;
  const before = [...flatInvoiceScope(), custom];
  const { items } = adoptOrderDividerStructure(before, order, ORDER_DIV_1);

  const kept = items.find((it) => it.uid === custom.uid);
  assertEquals(kept?.path, [ORDER_DIV_1, custom.uid]);
  // Structurally aligned even so — an invoice-only line is LINE-level drift.
  assertEquals(invoiceScopeDividersMatch(items as InvoiceItem[], order, ORDER_DIV_1), true);
});

Deno.test("invoiceScopeDividersMatch: compares divider paths, NOT all paths", () => {
  // ⚠️ The criterion this test pins. Full path-set equality would never go green
  // — 15 of the 102 prod pairs carrying a custom line carry a legitimate
  // invoice-only one, so the path sets differ forever while the tree shapes
  // agree perfectly.
  const order = groupedOrderItems();
  const custom = makeItem({
    uid: "custom-00000000-0000-4000-8000-00000000c002",
    type: "sale",
    name: "Invoice-only",
    path: [ORDER_DIV_1, "custom-00000000-0000-4000-8000-00000000c002"],
  }) as unknown as InvoiceDocItemType;
  const { items } = adoptOrderDividerStructure([...flatInvoiceScope(), custom], order, ORDER_DIV_1);

  assertEquals(invoiceScopeDividersMatch(items as InvoiceItem[], order, ORDER_DIV_1), true);
  // The companion: full path-set equality DOES fail on the same pair, which is
  // why it is the wrong criterion rather than a stricter one.
  const invoicePaths = new Set(
    items.filter((it) => it.type !== "order").map((it) => it.path.slice(1).join("/")),
  );
  const orderPaths = new Set(order.map((it) => (it.path ?? []).join("/")));
  assertEquals(
    invoicePaths.size === orderPaths.size && [...orderPaths].every((p) => invoicePaths.has(p)),
    false,
    "full path-set equality must still fail here — otherwise the ⚠️ above is moot",
  );
});

Deno.test("invoiceScopeDividersMatch: a missing group, and a divider at the wrong depth, both fail", () => {
  const order = groupedOrderItems();
  assertEquals(invoiceScopeDividersMatch(flatInvoiceScope() as InvoiceItem[], order, ORDER_DIV_1), false);

  // Same divider uids, wrong nesting — the group hung off the order divider
  // rather than the destination. A uid-set check would call this aligned.
  const wrongDepth = [
    orderDivider,
    { uid: DEST_1, type: "destination", name: "Main Venue", description: "", uid_delivery: DEL_1, uid_collection: null, path: [ORDER_DIV_1, DEST_1] },
    { uid: GROUP_1, type: "group", name: "Lighting", description: "", path: [ORDER_DIV_1, GROUP_1] },
  ] as unknown as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(wrongDepth, order, ORDER_DIV_1), false);
});

Deno.test("adoptOrderDividerStructure: an existing divider row keeps its own fields", () => {
  // 112 prod invoices hold a destination divider whose uid_delivery points at a
  // different `destinations` doc than the order's. That is benign staleness the
  // badge should keep showing — a STRUCTURAL repair must not quietly overwrite
  // it, so an existing row is re-pathed and never re-cloned.
  const order = groupedOrderItems();
  const staleDest = {
    uid: DEST_1, type: "destination", name: "Main Venue", description: "",
    uid_delivery: DEL_9, uid_collection: COL_9, path: [ORDER_DIV_1, DEST_1],
  } as unknown as InvoiceDocItemType;
  const { items } = adoptOrderDividerStructure([...flatInvoiceScope(), staleDest], order, ORDER_DIV_1);
  const dest = items.find((it) => it.uid === DEST_1) as unknown as Record<string, unknown>;
  assertEquals(dest.uid_delivery, DEL_9, "the invoice's own (stale) ref was overwritten");
  assertEquals(dest.path, [ORDER_DIV_1, DEST_1]);
});

Deno.test("adoptOrderDividerStructure: a repeated uid is reported as ambiguous, not silently paired", () => {
  // `uid` is NOT a row identity — it repeats within one document on 18% of prod
  // orders — so the k-th-occurrence pairing is a guess and says so.
  const order = computeItemPaths([
    { ...RESYNC_DEST, path: [] },
    { uid: GROUP_1, type: "group", name: "A", description: "", path: [] } as LineItem,
    { ...RESYNC_LINE_A, path: [] } as LineItem,
    { uid: GROUP_2, type: "group", name: "B", description: "", path: [] } as LineItem,
    { ...RESYNC_LINE_A, path: [] } as LineItem,
  ]);
  const flat = computeInvoiceItemPaths([
    orderDivider,
    ...buildOrderScopedItems(
      [{ ...RESYNC_LINE_A, path: [] } as LineItem, { ...RESYNC_LINE_A, path: [] } as LineItem],
      ORDER_DIV_1,
    ),
  ]);
  const { items, ambiguous } = adoptOrderDividerStructure(flat, order, ORDER_DIV_1);
  assertEquals(ambiguous, [{ uid: ITEM_1, invoiceOccurrences: 2, orderOccurrences: 2 }]);
  // It still pairs k-th to k-th, so both copies land under their own group.
  assertEquals(items.filter((it) => it.uid === ITEM_1).map((it) => it.path), [
    [ORDER_DIV_1, DEST_1, GROUP_1, ITEM_1],
    [ORDER_DIV_1, DEST_1, GROUP_2, ITEM_1],
  ]);
});

Deno.test("adoptOrderDividerStructure: an order line the invoice does not bill is NOT added", () => {
  const order = groupedOrderItems();
  const onlyA = computeInvoiceItemPaths([
    orderDivider,
    ...buildOrderScopedItems([{ ...RESYNC_LINE_A, path: [] } as LineItem], ORDER_DIV_1),
  ]);
  const { items } = adoptOrderDividerStructure(onlyA, order, ORDER_DIV_1);
  assertEquals(items.some((it) => it.uid === ITEM_2), false);
  // Structurally aligned — the absent line is line-level drift, reported by
  // computeInvoiceSyncStatus, not a structural gap.
  assertEquals(invoiceScopeDividersMatch(items as InvoiceItem[], order, ORDER_DIV_1), true);
  assertEquals(
    computeInvoiceSyncStatus(items as InvoiceItem[], order, ORDER_DIV_1, NO_EXPLANATIONS).get(KEY_B_GROUPED),
    "out_of_sync",
  );
});

const KEY_B_GROUPED = [ORDER_DIV_1, DEST_1, GROUP_1, ITEM_2].join("/");

Deno.test("adoptOrderDividerStructure: reads a parent from a PRE-NORMALIZED path too", () => {
  // The CRMS invoice webhook calls this while its items still carry the raw
  // ancestry chain — `[principalUid]` for an accessory, `[]` for a top-level
  // line — because `computeInvoiceItemPaths` runs afterwards. A `path.at(-2)`
  // parent read answers `undefined` for both and would drop every invoice-only
  // accessory to the root of the scope.
  const order = groupedOrderItems();
  const principalUid = ITEM_1;
  const accessoryUid = "custom-00000000-0000-4000-8000-00000000c003";
  const preNormalized: InvoiceDocItemType[] = [
    ...buildOrderScopedItems([{ ...RESYNC_LINE_A, path: [] } as LineItem], ORDER_DIV_1)
      .map((it) => ({ ...it, path: [] })),
    makeItem({ uid: accessoryUid, type: "sale", name: "Bulb", path: [principalUid] }) as unknown as InvoiceDocItemType,
  ];
  const { items } = adoptOrderDividerStructure(preNormalized, order, ORDER_DIV_1);
  assertEquals(
    items.find((it) => it.uid === accessoryUid)?.path,
    [ORDER_DIV_1, DEST_1, GROUP_1, principalUid, accessoryUid],
    "the invoice-only accessory lost its principal",
  );
  // Still a fixed point of the normalizer the webhook runs next.
  const normalized = computeInvoiceItemPaths([orderDivider, ...items]);
  assertEquals(validateInvoiceItemPaths(normalized), []);
  assertEquals(validateInvoiceItemUniqueness(normalized), []);
});

// ══════════════════════════════════════════════════════════════════
// unexplainedInvoiceItemDifferences — badge only the UNEXPLAINED (#481)
// ══════════════════════════════════════════════════════════════════
//
// The badge and `audit-draft-invoice-mirror.ts` were two comparators kept in
// agreement by hand. The audit compared money and then EXPLAINED the difference;
// the badge had no explainers, so it reported 8,792 prod lines of which the audit
// called 0 real. These tests pin the three arms and — more importantly — the
// cases each arm must NOT cover.

const TAX_CHI = "00000000-0000-4000-8000-00000000ta01"; // Chicago Rental, v1 @ 9%
const TAX_CHI_V2 = "00000000-0000-4000-8000-00000000ta02"; // Chicago Rental, v2 @ 15%
const TAX_OTHER = "00000000-0000-4000-8000-00000000ta03"; // a genuinely different tax

const TAX_NAMES = new Map([
  [TAX_CHI, "Chicago Rental Tax"],
  [TAX_CHI_V2, "Chicago Rental Tax"],
  [TAX_OTHER, "Chicago Sales Tax"],
]);
const FROZEN = { taxNameByUid: TAX_NAMES, orderFrozen: true };
const LIVE = { taxNameByUid: TAX_NAMES, orderFrozen: false };

/** A line taxed by `uid` at `rate`, collecting `amount` cents, totalling accordingly. */
function taxedLine(uid: string, rate: number, amount: number): InvoiceItem {
  const base = projectedLineA();
  const price = (base as unknown as { price: Record<string, unknown> }).price;
  return {
    ...base,
    price: {
      ...price,
      taxes: [{ uid, name: "t", rate, type: "percent", amount_cents: amount }],
      total_cents: (price.subtotal_discounted_cents as number) + amount,
    },
  } as unknown as InvoiceItem;
}

/** The differences, then the residue after explanation — the real call shape. */
function residue(expected: InvoiceItem, current: InvoiceItem, ctx: typeof FROZEN): string[] {
  return unexplainedInvoiceItemDifferences(expected, current, invoiceItemDifferences(expected, current), ctx);
}

Deno.test("#481 date-version: same tax NAME, different version, on a FROZEN order — explained", () => {
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = taxedLine(TAX_CHI, 9, 1800);
  // Both the tax rows AND the total differ — the total only because the tax did.
  assertEquals(invoiceItemDifferences(expected, current), ["price.taxes", "price.total_cents"]);
  assertEquals(residue(expected, current, FROZEN), []);
});

Deno.test("🔴 #481 date-version REQUIRES a frozen order — the same difference on a LIVE order is drift", () => {
  // The tightening. Both writers now resolve a tax by name at the delivery date,
  // so this difference is expected history on a frozen order and a genuine
  // regression on a live one. The audit only OBSERVED that all 5,119 prod lines
  // sat on frozen orders; requiring it is what stops the explanation covering a
  // case it was never true of.
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = taxedLine(TAX_CHI, 9, 1800);
  assertEquals(residue(expected, current, LIVE), ["price.taxes", "price.total_cents"]);
});

Deno.test("🔴 #481 a genuinely DIFFERENT tax is never explained, frozen or not", () => {
  // Different names, so the version story cannot apply. This is the arm that
  // stops "explain the tax dimension" from collapsing into "ignore tax".
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = taxedLine(TAX_OTHER, 10, 2050);
  assertEquals(residue(expected, current, FROZEN), ["price.taxes", "price.total_cents"]);
});

Deno.test("🔴 #481 an UNKNOWN tax uid is its own name — never explained away", () => {
  // A uid missing from the map must not collide with another missing one, or two
  // unrelated unknown taxes would explain each other.
  const expected = taxedLine("00000000-0000-4000-8000-0000000missA", 15, 3000);
  const current = taxedLine("00000000-0000-4000-8000-0000000missB", 9, 1800);
  assertEquals(residue(expected, current, FROZEN).length > 0, true);
});

Deno.test("#481 zero-money: tax rows differ but neither side collects a cent — explained", () => {
  const expected = taxedLine(TAX_CHI_V2, 15, 0);
  const current = taxedLine(TAX_OTHER, 10, 0);
  assertEquals(residue(expected, current, LIVE), []); // no freeze needed: $0 is $0
});

Deno.test("#481 coa: the invoice untaxes a line the order does not — explained", () => {
  const expected = { ...taxedLine(TAX_CHI_V2, 15, 3000) } as unknown as Record<string, unknown>;
  delete expected.coa_revenue; // the order line carries none
  const current = { ...taxedLine(TAX_CHI_V2, 15, 0), coa_revenue: 6000 } as unknown as InvoiceItem;
  (current as unknown as { price: Record<string, unknown> }).price.taxes = [];
  const exp = expected as unknown as InvoiceItem;
  assertEquals(residue(exp, current, LIVE), []);
});

Deno.test("🔴 #481 total_cents is covered ONLY when it moved by exactly the tax delta", () => {
  // A tax difference necessarily moves the total, so refusing to cover it would
  // leave every explained line red for a consequence of the thing just explained.
  // Covering it unconditionally would hide a real total divergence behind an
  // unrelated tax one. Exact integer cents — there is no tolerance to choose.
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = taxedLine(TAX_CHI, 9, 1800);
  (current as unknown as { price: Record<string, unknown> }).price.total_cents = 999_999;
  assertEquals(residue(expected, current, FROZEN), ["price.total_cents"]);
});

Deno.test("🔴 #481 a subtotal difference is NEVER explained — the money is the finding", () => {
  // Prod order #765 <-> invoice #2162: CRMS holds $429.00 + $43.97, the order
  // agrees, and the invoice line carries $222.97 and no tax — issued, pushed to
  // Xero and PAID. A repriceability gate would have hidden it because the invoice
  // is frozen; explaining rather than gating is what keeps it red.
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = taxedLine(TAX_CHI, 9, 1800);
  (current as unknown as { price: Record<string, unknown> }).price.subtotal_discounted_cents = 22_297;
  const left = residue(expected, current, FROZEN);
  assertEquals(left.includes("price.subtotal_discounted_cents"), true, `stayed: ${left.join(", ")}`);
});

Deno.test("#481 a line with NO tax difference is passed through untouched", () => {
  const expected = taxedLine(TAX_CHI_V2, 15, 3000);
  const current = { ...taxedLine(TAX_CHI_V2, 15, 3000), name: "renamed" } as InvoiceItem;
  assertEquals(residue(expected, current, FROZEN), ["name"]);
});

Deno.test("#481 an identical pair explains to nothing, in every context", () => {
  const line = taxedLine(TAX_CHI_V2, 15, 3000);
  for (const ctx of [FROZEN, LIVE, NO_EXPLANATIONS]) {
    assertEquals(residue(line, line, ctx), []);
  }
});

Deno.test("#481 computeInvoiceSyncStatus goes GREEN on an explained line and RED on a real one", () => {
  // The end-to-end shape: the explainers have to reach the badge, not just exist.
  const inv = baselineInvoice();
  const taxed = inv.map((it) =>
    it.uid === ITEM_1
      ? ({
        ...it,
        price: {
          ...(it as unknown as { price: Record<string, unknown> }).price,
          taxes: [{ uid: TAX_CHI, name: "t", rate: 9, type: "percent", amount_cents: 0 }],
        },
      } as unknown as InvoiceItem)
      : it
  );
  // The order projection carries no taxes; the invoice carries one collecting $0.
  assertEquals(
    computeInvoiceSyncStatus(taxed, RESYNC_ORDER_ITEMS, ORDER_DIV_1, FROZEN).get(KEY_A),
    "in_sync",
  );
  assertEquals(
    computeInvoiceSyncStatus(taxed, changedOrderItems(), ORDER_DIV_1, FROZEN).get(KEY_A),
    "out_of_sync", // quantity moved — nothing explains that
  );
});

Deno.test("🔴 #481 no arm may fire when the tax ROWS agree — the 171-line cross-check finding", () => {
  // Every arm is a statement about a tax-row difference. Without this gate the
  // zero-money arm is trivially true on any untaxed line (both sides collect
  // nothing) and goes on to "explain" an unrelated `taxes_base` difference that
  // contains no tax question. Found by the audit cross-check on its first prod
  // run: 171 lines where core fired an arm and the audit, which classifies only
  // once the rows disagree, called the two identical.
  const expected = taxedLine(TAX_CHI_V2, 15, 0);
  const current = structuredClone(expected) as unknown as { price: Record<string, unknown> };
  current.price.taxes_base = [{ uid: TAX_OTHER, name: "t", rate: 10, type: "percent" }];
  const cur = current as unknown as InvoiceItem;

  assertEquals(invoiceItemDifferences(expected, cur), ["price.taxes_base"]);
  const verdict = explainInvoiceItemDifferences(expected, cur, invoiceItemDifferences(expected, cur), FROZEN);
  assertEquals(verdict.arms, [], "an arm fired with no tax-row difference to explain");
  assertEquals(verdict.unexplained, ["price.taxes_base"]);
});

// ── Destination pair: jurisdiction is level 1 of the tax precedence ──

Deno.test("syncOrderDestinationsSelective carries jurisdiction onto a NEW invoice pair", () => {
  // The projection enumerates what it TAKES, so a forgotten key drops the
  // field. It surfaces immediately — which is the failure mode a projection is
  // allowed to have, unlike the equality check below.
  const prev: ReturnType<typeof makePair>[] = [];
  const next = [makePair("d1", "c1", { jurisdiction: "frankfort" })];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, [], "o1");
  assertEquals(result.length, 1);
  assertEquals(result[0].jurisdiction, "frankfort");
});

Deno.test("syncOrderDestinationsSelective carries a CHANGED jurisdiction on an unedited pair", () => {
  const prev = [makePair("d1", "c1", { jurisdiction: "chicago" })];
  const next = [makePair("d1", "c1", { jurisdiction: "frankfort" })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { jurisdiction: "chicago" }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result[0].jurisdiction, "frankfort");
});

Deno.test("syncOrderDestinationsSelective PRESERVES an invoice-side jurisdiction edit", () => {
  // 🔴 The silent-data-loss case. If the sync takes the order's value here, the
  // operator's override is gone — no error, no log, a wrong tax rate.
  //
  // ⚠️ This used to be phrased as *"pairsMatch SEES jurisdiction"*, and the
  // MECHANISM changed while the property did not (api-cloudrun#630 step A2/A3):
  // `pairsMatch` now skips `INVOICE_OVERRIDABLE_PAIR_FIELDS`, and
  // `carryOverridablePairFields` reconciles them with `syncScalarWithOverride`.
  // The test is stated against the exported function rather than the private
  // comparator so it survives that swap — which is the whole reason it was
  // rewritten instead of deleted.
  const prev = [makePair("d1", "c1", { jurisdiction: "chicago" })];
  const next = [makePair("d1", "c1", { jurisdiction: "chicago" })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { jurisdiction: "rantoul" }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result[0].jurisdiction, "rantoul");
});

Deno.test("a jurisdiction override does NOT freeze the rest of the pair", () => {
  // ⭐ The behaviour api-cloudrun#630 step A2 adds, and nothing pinned it before.
  // Under the old whole-pair `pairsMatch`, setting a jurisdiction made the pair
  // "overridden" and froze address, contact, instructions,
  // customer_collecting/returning and dates on every later order edit — so the
  // manager's read-only "charge window from order #NNNN" went silently stale.
  //
  // This is the items mechanism applied to pairs: an owned edit is invisible to
  // the comparator, so the row keeps tracking its source.
  const prev = [makePair("d1", "c1", { jurisdiction: "chicago", delivery: { instructions: "old" } })];
  const next = [makePair("d1", "c1", { jurisdiction: "chicago", delivery: { instructions: "new" }, customer_collecting: true })];
  const invoice: InvoiceDestinationPair[] = [{
    uid_order: "o1",
    ...makePair("d1", "c1", { jurisdiction: "rantoul", delivery: { instructions: "old" } }),
  }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result[0].jurisdiction, "rantoul", "the owned field is still the override");
  assertEquals(result[0].delivery.instructions, "new", "…and everything else resumed syncing");
  assertEquals(result[0].customer_collecting, true);
});

Deno.test("an INHERITED pair still accepts the order's changed jurisdiction — the nullish trap", () => {
  // 🔴 The A3 defect a `pickInvoiceOnlyFields`-shaped "present on the invoice
  // wins" carry would ship. The two documents spell "asserts nothing"
  // differently: `buildDestinationPair` DELETES the key on the order side, while
  // `toInvoiceDestinationPair` normalizes it to `null` on the invoice side. So
  // an inherited-and-unedited invoice pair carries `jurisdiction: null`, which
  // is `!== undefined` — a presence test would take that null over the order's
  // real value and pin every synced invoice to null forever.
  //
  // `syncScalarWithOverride` with `?? null` on all three arms is what makes the
  // two spellings ONE state.
  const { jurisdiction: _absentOnOrder, ...prevNoKey } = makePair("d1", "c1");
  const prev = [prevNoKey as ReturnType<typeof makePair>];
  const next = [makePair("d1", "c1", { jurisdiction: "frankfort" })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { jurisdiction: null }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result[0].jurisdiction, "frankfort");
});

Deno.test("an owned-field edit does not keep a pair the ORDER deleted", () => {
  // The other side of the same change, stated so it is a decision rather than a
  // side effect: an override on an invoice-owned field is a statement about the
  // field, not a claim that the destination still exists. Under the old
  // whole-pair freeze this pair survived its own deletion.
  const prev = [makePair("d1", "c1", { jurisdiction: "chicago" })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...makePair("d1", "c1", { jurisdiction: "rantoul" }) }];
  const { destinations: result } = syncOrderDestinationsSelective(prev, [], invoice, "o1");
  assertEquals(result.length, 0);
});

Deno.test("pairsMatch: null, undefined and absent jurisdiction are ONE state", () => {
  // All three spell "assert nothing, ask the next level", and a corpus
  // mid-migration holds every spelling. Reading one as an edit would freeze the
  // WHOLE pair as overridden and stop it syncing — the check is all-or-nothing.
  const withNull = makePair("d1", "c1", { jurisdiction: null });
  const { jurisdiction: _dropped, ...withAbsent } = makePair("d1", "c1");
  const prev = [withNull];
  const next = [makePair("d1", "c1", { delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...withAbsent } as InvoiceDestinationPair];
  const { destinations: result } = syncOrderDestinationsSelective(prev, next, invoice, "o1");
  assertEquals(result[0].delivery.instructions, "new", "absent must not read as an override of null");
});

Deno.test("pairsMatch is insensitive to KEY ORDER", () => {
  // One side of the comparison is a stored document (Firestore returns map keys
  // sorted) and the other may be freshly built (insertion order). A raw
  // JSON.stringify would report two identical pairs as different, freeze the
  // pair as overridden, and silently stop syncing it.
  const built = makePair("d1", "c1", { jurisdiction: "chicago" });
  const reordered = Object.fromEntries(
    Object.keys(built).sort().map((k) => [k, (built as Record<string, unknown>)[k]]),
  ) as ReturnType<typeof makePair>;
  const next = [makePair("d1", "c1", { jurisdiction: "chicago", delivery: { instructions: "new" } })];
  const invoice: InvoiceDestinationPair[] = [{ uid_order: "o1", ...reordered }];
  const { destinations: result } = syncOrderDestinationsSelective([built], next, invoice, "o1");
  assertEquals(result[0].delivery.instructions, "new");
});

Deno.test("toInvoiceDestinationPair carries EVERY field of the pair, by construction", () => {
  // The ratchet the five hand-written projections could not provide: a field
  // added to the order pair reaches the invoice pair without anyone editing a
  // list. Compares KEY SETS, so a new field fails this the moment it exists.
  const pair = makePair("d1", "c1", { jurisdiction: "rantoul" });
  const projected = toInvoiceDestinationPair("o1", pair);
  assertEquals(
    Object.keys(projected).sort(),
    ["uid_order", ...Object.keys(pair)].sort(),
    "the projection must carry every key of the source pair, plus uid_order",
  );
  assertEquals(projected.uid_order, "o1");
  assertEquals(projected.jurisdiction, "rantoul");
});

Deno.test("toInvoiceDestinationPair normalizes nullish to null — Firestore refuses undefined", () => {
  const { jurisdiction: _absent, ...noJurisdiction } = makePair("d1", "c1");
  const projected = toInvoiceDestinationPair("o1", noJurisdiction as ReturnType<typeof makePair>);
  for (const [key, value] of Object.entries(projected)) {
    assertEquals(value === undefined, false, `${key} is undefined — Firestore will refuse the write`);
  }
});

Deno.test("syncOrderDestinationsSelective never emits an UNDEFINED field", () => {
  // 🔴 Firestore refuses `undefined` outright — the write fails, it does not
  // drop the key — so a projection that spells `jurisdiction: pair.jurisdiction`
  // from a pair that has no such key breaks every invoice write. Caught in
  // api-cloudrun by `scanForUndefined` on six CRMS invoice tests; this is the
  // same defect one layer up, where it is cheap to see.
  const { jurisdiction: _absent, ...noJurisdiction } = makePair("d1", "c1");
  const { destinations: result } = syncOrderDestinationsSelective(
    [],
    [noJurisdiction as ReturnType<typeof makePair>],
    [],
    "o1",
  );
  assertEquals(result.length, 1);
  for (const [key, value] of Object.entries(result[0])) {
    assertEquals(value === undefined, false, `${key} is undefined — Firestore will refuse the write`);
  }
  // An ABSENT key stays absent, which Firestore accepts and which the schema
  // declares optional. The defect was only ever an explicitly-present
  // `undefined`; minting a `null` here would write a decision nobody made.
  assertEquals("jurisdiction" in result[0], false);
});
