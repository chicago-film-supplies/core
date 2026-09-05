/**
 * Fulfillment schemas — Firestore collection: fulfillments
 *
 * Sanitized projection of an Order for the fulfillment client view.
 * Strips pricing, financial totals, invoice refs, CRM/Xero ids, notes, and
 * transaction_fee line items. Keeps destination contacts, dates, quantities,
 * and item structure.
 *
 * ⚠️ **It does NOT strip the tax axis, and this line said "tax profile" until
 * api-cloudrun#674.** `tax_profile` was deleted outright in
 * `@cfs/core@10.0.0-beta.230` (#596); what replaced it —
 * `destinations[i].jurisdiction` — is carried through verbatim, because
 * `destinations` is copied whole. So the sentence named a field that no longer
 * exists AND implied a strip that does not happen. If the jurisdiction ever
 * needs to be withheld from picker clients, that is a decision to take here,
 * not a property to assume from this header.
 *
 * Picker-editable: line items may carry `quantity_order` (server-set when
 * picker quantity diverges from order quantity) and `path_substituted_for`
 * (picker-set on substitution line items, cleared on graduation). The doc
 * carries its own `version` for optimistic concurrency on picker writes.
 */
import { z } from "zod";
import { FirestoreId, ItemUid } from "./_uid.ts";
import {
  type FirestoreTimestampType,
  type FulfillableItemType,
  FULFILLMENT_LINE_ITEM_TYPES,
  OrderDerivedOrgPath,
  type OrgPathNodeType,
  StockMethodEnum,
  type StockMethodType,
  TimestampFields,
} from "./common.ts";
import {
  DocDestination,
  type DocDestinationType,
  ORDER_STATUSES,
  type OrderStatusType,
} from "./order.ts";
// 🔴 The SAME two divider arms the order and invoice unions are built from —
// imported, not restated. Two hand-written twins stood here and were
// byte-equivalent to these (api-cloudrun#674). A copy of a divider arm is
// exactly the shape this repo has already paid for: the `uid_delivery` /
// `uid_collection` removal had to be applied to FOUR arms rather than two
// because of them, and the measured PII rationale on
// `DestinationDividerArm.name` was stranded on the definition fulfillments did
// not use.
//
// ⚠️ These are the un-annotated consts, and they have to be: a
// `z.discriminatedUnion` arm must expose `_zod.propValues` at the type level,
// which a `z.ZodType<T>` annotation erases. That is why `_dividers.ts` exists
// and is not an entrypoint — see its module header.
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";

/**
 * 🔴 **A fulfillment's status IS the order's status, so this reuses
 * `ORDER_STATUSES` rather than restating it.** `buildFulfillment` passes
 * `orderNew.status` straight through, so the copy that stood here was the
 * riskiest of the three in this module: adding a member to `ORDER_STATUSES`
 * alone would make **every** fulfillment projection write fail at runtime —
 * the order accepts the new status, the projection copies it, and this enum
 * refuses it. The two lists were byte-identical when they were merged
 * (api-cloudrun#674), which is exactly the state in which a copy looks
 * harmless.
 */
type FulfillmentOrderStatusType = OrderStatusType;
const FulfillmentOrderStatus: z.ZodType<FulfillmentOrderStatusType> = z.enum(ORDER_STATUSES);

// The list and its "why" live in `schemas/common.ts`, beside `ITEM_CONTRACTS` and the
// compile-time assertion tying it to `fulfillable`.
type FulfillmentLineItemTypeType = FulfillableItemType;

/** Line item in the fulfillment order view — no price, no financial flags. */
export interface FulfillmentLineItemType {
  uid: string;
  type: FulfillmentLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  stock_method?: StockMethodType;
  path: string[];
  /**
   * The line's own order attribution — a DENORMALISED COPY of the document's
   * identity, not an independent fact.
   *
   * A fulfillment doc has no order FK: its `uid` IS the order's uid and its
   * `number` IS the order's number. So these can only ever disagree with the
   * document by mistake, and both writers are structurally incapable of
   * emitting a foreign order — the projection copies from the one order being
   * written, and the picker path re-derives from `orders/{same uid}`.
   *
   * Optional because DIVIDERS omit both: measured 2026-09-05 across both envs,
   * 3,907 of 13,863 prod items carry neither, and 0 items disagree.
   *
   * ⚠️ Nothing READS them, so a divergence has no natural detector, and it
   * would not fail loudly: a pick sheet builds its booking key from the
   * DOCUMENT and skips a miss, so a mis-attributed line renders booking-less
   * and the section's unit total is silently short. `validateBeforeWrite`
   * asserts the agreement at write time for that reason (manager#357).
   */
  order_number?: number;
  uid_order?: string;
  /**
   * Server-set when picker quantity diverges from the order's projected
   * quantity for the same path. Carries admin's intended quantity. Picker
   * writes that include this field on any line item are rejected (400) —
   * it is server-managed.
   */
  quantity_order?: number;
  /**
   * Picker-set on substitution line items. Carries the path of the
   * substituted-for item at the moment of substitution. Cleared by the
   * projection on graduation (admin emits at the same path).
   */
  path_substituted_for?: string[];
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`.
const FulfillmentLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(FULFILLMENT_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  // Fulfillment items are a projection of order items, so this is the same
  // string; it must carry the same classification.
  name: z.string().min(1).max(100).meta({ pii: "none", column: true }),
  // Line-item text — not customer data. See `OrderDocLineItem.description`.
  // Fulfillment items are a projection of order items, so this is the same
  // string; it must carry the same classification.
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),
  quantity: z.number().int().min(0).default(0).meta({ column: true, label: "Quantity" }),
  stock_method: StockMethodEnum.optional().meta({ column: true, label: "Stock Method" }),
  path: z.array(ItemUid).default([]),
  order_number: z.int().optional().meta({ column: true, label: "Order #" }),
  uid_order: FirestoreId.optional(),
  quantity_order: z.number().int().min(0).optional(),
  path_substituted_for: z.array(ItemUid).optional(),
});

export const FulfillmentLineItem: z.ZodType<FulfillmentLineItemType> = FulfillmentLineItemInner;

/** Destination divider in the fulfillment items array. */
export interface FulfillmentDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  description: string;
}

const FulfillmentDestinationItemInner = DestinationDividerArm;

export const FulfillmentDestinationItem: z.ZodType<FulfillmentDestinationItemType> = FulfillmentDestinationItemInner;

/** Group divider in the fulfillment items array. */
export interface FulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

const FulfillmentGroupItemInner = GroupDividerArm;

export const FulfillmentGroupItem: z.ZodType<FulfillmentGroupItemType> = FulfillmentGroupItemInner;

/** Union of all item types in the fulfillment order view. */
export type FulfillmentItemType =
  | FulfillmentLineItemType
  | FulfillmentDestinationItemType
  | FulfillmentGroupItemType;

export const FulfillmentItem: z.ZodType<FulfillmentItemType> = z.discriminatedUnion("type", [
  FulfillmentLineItemInner,
  FulfillmentDestinationItemInner,
  FulfillmentGroupItemInner,
]);

/** Sanitized organization snapshot — uid and name only. */
const FulfillmentOrganization = z.strictObject({
  uid: FirestoreId.nullable(),
  path: OrderDerivedOrgPath,
});

/**
 * Sanitized order document for the fulfillment client view.
 * Mirrors the order by uid — one fulfillment doc per order.
 */
export interface Fulfillment {
  uid: string;
  number: number;
  status: FulfillmentOrderStatusType;
  organization: {
    uid: string | null;
    path: OrgPathNodeType[];
  };
  destinations: DocDestinationType[];
  items: FulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  /**
   * Optimistic-concurrency token. Bumped on every write — projection writes
   * (createOrder, updateOrder, opportunity webhook) and picker writes (PUT
   * /fulfillments/{uid}/items). Picker PUT body carries this value; server
   * 409s on mismatch. Mirrors `Order.version`.
   */
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

export const FulfillmentSchema: z.ZodType<Fulfillment> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "fulfillmentDetail" }),
  status: FulfillmentOrderStatus.meta({ column: true, label: "Status" }),
  organization: FulfillmentOrganization.meta({ label: "Organization" }),
  destinations: z.array(DocDestination).min(1),
  items: z.array(FulfillmentItem).default([]).meta({ label: "Item" }),
  // `mask` — see the note on `subject` in `order.ts`; same field, same ruling.
  subject: z.string().default("").meta({ pii: "mask", column: true, label: "Subject", linkTo: "fulfillmentDetail" }),
  reference: z.string().max(255).nullable().default(null).meta({ column: true, label: "Reference", linkTo: "fulfillmentDetail" }),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  query_by_dates: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Fulfillment",
  collection: "fulfillments",
  displayDefaults: {
    columns: ["number", "organization.path", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<Fulfillment>;
