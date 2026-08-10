import { assertEquals } from "@std/assert";
import { getInitialValues, InvoiceDocLineItemSchema, InvoiceDocOrderItem, isInvoiceLineItem, OrderDocDestinationItem, OrderDocGroupItem } from "../src/schemas/mod.ts";
import { calculateOrderTotals, sumDocumentTotals, validateItemPaths } from "../src/utils/orders.ts";
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
  getXeroUnitAmountFromCents,
  type InvoiceDestinationPair,
  type InvoiceItem,
  type LineItem,
  type Tax,
  recomputeSettlementTotals,
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
import type {
  InvoiceDocItemType,
  FirestoreTimestampType,
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

Deno.test("syncOrderToInvoiceSelective projects synced items and carries forward invoice-only fields", () => {
  // Prev order + matching invoice item with overrides → sync branch replaces body, keeps overrides.
  const prevItem: LineItem = {
    uid: ITEM_1,
    type: "rental",
    name: "Light",
    quantity: 1,
    path: [DEST_1, ITEM_1],
    price: {
      base_cents: 10000, chargeable_days: 5, formula: "five_day_week",
      subtotal_cents: 10000, subtotal_discounted_cents: 10000, discount: null, taxes: [], total_cents: 10000,
    } as unknown as LineItem["price"],
  };
  // Deliberately a bare spread of `prevItem`: `isItemSynced` compares the two
  // field by field, so padding this out with the schema base would introduce
  // differences and push the test down the "overridden" branch it is not
  // testing.
  const invoiceItem: InvoiceDocItemType = {
    ...prevItem,
    path: [ORDER_DIV_1, DEST_1, ITEM_1],
    coa_revenue: 4100,
    xero_id: "00000000-0000-4000-8000-000000000001",
  } as InvoiceDocItemType;
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
  assertEquals(asLine(out).quantity, 3);
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
      { base_cents: 10000, chargeable_days: 5, subtotal_cents: 20000, subtotal_discounted_cents: 20000, total_cents: 20000 },
    ),
    makeItem(
      { uid: "item-2", type: "sale", name: "Tripod", quantity: 1 },
      { base_cents: 30000, formula: "fixed", subtotal_cents: 30000, subtotal_discounted_cents: 30000, total_cents: 30000 },
    ),
  ];

  const result = calculateInvoiceTotals(items, []);
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
  const result = calculateInvoiceTotals(items, []);
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
  const result = calculateInvoiceTotals(items, TAXES);
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
  const result = calculateInvoiceTotals([], []);
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
  const result = calculateInvoiceTotals(items, []);
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

Deno.test("computeInvoiceSyncStatus: a CRMS-authored line is in_sync — the corpus-wide false positive", () => {
  // `invoiceProjectionMatches` compares KEY SETS before values, so before
  // 2026-08-10 a line carrying `crms_id` had one more comparable key than its
  // projection and reported `out_of_sync` — every CRMS-authored line in the
  // corpus, with nothing thrown. Same mechanism as the documented
  // `base_percent` case in `api-cloudrun/src/services/invoices.ts`.
  const inv = baselineInvoice().map((it) =>
    it.uid === ITEM_1 ? ({ ...it, crms_id: 8812, crms_opportunity_id: 5501 } as InvoiceItem) : it
  );
  const status = computeInvoiceSyncStatus(inv, RESYNC_ORDER_ITEMS, ORDER_DIV_1);
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
    const fromInvoice = core(calculateInvoiceTotals(doc.items, TAXES) as unknown as Record<string, unknown>);
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
    const t = calculateInvoiceTotals(doc.items, TAXES);
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
