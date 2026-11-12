/**
 * Purchase receipt schemas — Firestore collection: `purchase-receipts`.
 *
 * The CUSTODY document of the payable side: what a supplier actually sent, the
 * twin of the fulfillment (`schemas/fulfillment.ts`), which is what the
 * warehouse actually did for an order (one-document-model ruling 37, 7a C9).
 *
 * | | receivable | payable |
 * |---|---|---|
 * | initiator | `orders` | `purchases` |
 * | custody | `fulfillments` (id = order id) | `purchase-receipts` (id = purchase id) |
 *
 * ## It mirrors the fulfillment field for field
 *
 * - `uid` and `number` ARE the purchase's, as a fulfillment's are its order's;
 * - `status` IS the purchase's status, so it reuses `PURCHASE_STATUSES` rather
 *   than restating it (the fulfillment reuses `ORDER_STATUSES` for the same
 *   reason: a member added to one list alone would fail every projection write);
 * - `supplier` stands where the fulfillment's `organization` does — the
 *   purchase's `{ uid, name }`, taken whole;
 * - `destinations` are the purchase's own pair schema, so the three arguments to
 *   the merge are already in the receipt's shape;
 * - `reference`, the three `query_by_*` mirrors, `version`, the actors and the
 *   timestamps are the fulfillment's;
 * - `items` are the purchase's CUSTODY rows (its `sale` and `rental` rows, kit
 *   headers included) and its dividers, at order depth, each line carrying a
 *   physical `quantity` and the purchase's `quantity_ordered`.
 *
 * No price: money is not a receiving concern, exactly as it is not a picking one.
 * A `service` or `replacement` purchase line moves no custody, so it has no row.
 *
 * ## The receiver owns the row's quantity, and nothing writes the receipt from the bookings
 *
 * The direction is the outbound one (conformance on the 7a spec: the draft's
 * "bookings project into the receipt" was a second upstream, a new pattern). A
 * short or extra delivery is a receipt-row EDIT, as a short pick is a
 * fulfillment-row edit; the inbound bookings reconcile from the receipt, and the
 * custody steps act on the bookings through the inbound lever. The purchase →
 * receipt cascade is a three-way merge over {@link PurchaseReceipt}'s shared
 * fields (`purchaseReceiptSharedFields`, `utils/shared-fields.ts`), with the
 * custody keep at booking grain.
 *
 * ⚠️ **`number`, `status` and `reference` classify as homonyms and the merge
 * skips them**: the purchase tags them `propagate: false` because a BILL's
 * number, status and reference are its own. On a receipt all three are genuine
 * copies of the purchase's, so the writer sets them unconditionally, as
 * `stageOrderFulfillmentSync` does a fulfillment's `number` and `status`.
 *
 * Why a row exists that the purchase does not carry is ONE classifier,
 * `receiptRowSources` (`utils/purchase-receipts.ts`).
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  checkZeroPricedAmount,
  checkZeroPricedComponents,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { checkDestinationJoin, checkLeadingDivider } from "./order.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { LineItemCore } from "./_items.ts";
import {
  type PurchaseDestination,
  PurchaseDestinationSchema,
  PURCHASE_PRODUCT_ITEM_TYPES,
  type PurchaseProductItemTypeType,
  PURCHASE_STATUSES,
  type PurchaseStatusType,
} from "./purchase.ts";

/** A receipt line — one custody row of the purchase, with no price. */
export interface PurchaseReceiptLineItemType {
  /** The purchase line's uid: its product's, as on the purchase (ruling 12). Not a row identity; `path` is. */
  uid: string;
  /** `sale` (a Buy) or `rental` (a Subrent): the only purchase lines that move custody. */
  type: PurchaseProductItemTypeType;
  name: string;
  description: string;
  /**
   * The PHYSICAL count: what the supplier sent for this row. The receiver owns
   * it, as the picker owns a fulfillment row's, so a short or extra delivery is
   * an edit here and a later purchase edit does not reach an edited row.
   */
  quantity: number;
  /** @see `LineItemCore.zero_priced` (`schemas/_items.ts`). */
  zero_priced: boolean | null;
  /** @see `LineItemCore.quantity_per_parent` (`schemas/_items.ts`). */
  quantity_per_parent?: number | null;
  /** The purchase line's path — the row identity, at order depth. */
  path: string[];
  /**
   * The PURCHASE's quantity for this row, server-set on every line, as a
   * fulfillment row's `quantity_ordered` is the order's.
   *
   * - a number: the purchase's line at this path. `0` is a KEPT row — the
   *   purchase closed the line while its units were held (ruling 47, which keeps
   *   the inbound booking) — and is unambiguous, because a purchase line is
   *   never stored at 0.
   * - `null`: the purchase has no line here — a supplier sent something the PO
   *   lacks (ruling 35).
   *
   * A conflict is the COMPARISON `quantity !== quantity_ordered`, never the
   * field's presence. Required-nullable: there is no legacy population.
   */
  quantity_ordered: number | null;
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`.
const PurchaseReceiptLineItemInner = z.strictObject({
  type: z.enum(PURCHASE_PRODUCT_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...LineItemCore,
  quantity_ordered: z.int().min(0).nullable(),
  // Vacuous at this grain, as on the fulfillment: no `price`, so it returns
  // early. Attached so the custody grains read identically.
}).superRefine(checkZeroPricedAmount);

export const PurchaseReceiptLineItem: z.ZodType<PurchaseReceiptLineItemType> = PurchaseReceiptLineItemInner;

/** Destination divider in a receipt's items array — the purchase's own divider arm. */
export interface PurchaseReceiptDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  description: string;
}

/** Group divider in a receipt's items array — the purchase's own divider arm. */
export interface PurchaseReceiptGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

/** Any row of a receipt's `items[]`. */
export type PurchaseReceiptItemType =
  | PurchaseReceiptLineItemType
  | PurchaseReceiptDestinationItemType
  | PurchaseReceiptGroupItemType;

export const PurchaseReceiptItem: z.ZodType<PurchaseReceiptItemType> = z
  // The destination arm FIRST, as on the fulfillment: `getTestDoc` builds the
  // first arm, and a receipt leads with its destination divider.
  .discriminatedUnion("type", [
    DestinationDividerArm,
    PurchaseReceiptLineItemInner,
    GroupDividerArm,
  ]);

/**
 * Narrows a receipt row to a line (excludes the two dividers).
 *
 * ⚠️ Not a key-presence test: the decision is the row's TYPE, as
 * `isFulfillmentLineItem`'s is.
 */
export function isPurchaseReceiptLineItem(item: PurchaseReceiptItemType): item is PurchaseReceiptLineItemType {
  return item.type === "sale" || item.type === "rental";
}

/** A purchase receipt: the custody projection of one purchase, keyed by its uid. */
export interface PurchaseReceipt {
  /** The purchase's uid. One receipt per purchase. */
  uid: string;
  /** The purchase's number. */
  number: number;
  /** The purchase's status. */
  status: PurchaseStatusType;
  /** The purchase's supplier, `{ uid, name }`. */
  supplier: UidNameRefType;
  destinations: PurchaseDestination[];
  items: PurchaseReceiptItemType[];
  /** The purchase's `subject`, merged per field as a fulfillment's is its order's. */
  subject: string;
  /** The purchase's reference. */
  reference: string | null;
  /**
   * When this receipt is next due — the earliest of its open legs: a unit still
   * to ARRIVE is due at its pair's `delivery_start`, a subrent unit held for
   * SEND-BACK at its pair's `collection_start` (the hire end; `collection_end`
   * is supply's). `null` once the purchase is complete or canceled, or when no
   * pair states the date. The fulfillment's `due_at`, on the payable side, so
   * one custody page sorts both (ruling 29). Derived by `deriveReceiptDueAt`
   * (`utils/purchase-receipts.ts`) from the purchase and its inbound bookings.
   */
  due_at: string | null;
  /** The `Timestamp` mirror of {@link due_at}, from the same pair. */
  due_at_fs: FirestoreTimestampType | null;
  /**
   * The stores this receipt's units come to or sit in: the purchase's store,
   * then every store its inbound bookings name (`receiptQueryByUidStore`). For
   * a store-scoped "what's arriving here" list (owner, 2026-11-11).
   */
  query_by_uid_store: string[];
  /** The products this receipt carries (its line rows' uids), for reverse lookup. */
  query_by_items: string[];
  /** Every contact a pair's endpoint names (`buildQueryByContacts`, `utils/orders.ts`). */
  query_by_contacts: string[];
  /** The Chicago days a pair's windows touch (`buildQueryByDates`, `utils/orders.ts`). */
  query_by_dates: string[];
  /** Optimistic-concurrency token, bumped on every write — projection writes and receiver writes. */
  version: number;
  /** The actor of the purchase write that projected it. */
  created_by: ActorRefType | null;
  /** The receiver, or the actor of the PURCHASE edit whose projection wrote it, as on the fulfillment. */
  updated_by: ActorRefType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

export const PurchaseReceiptSchema: z.ZodType<PurchaseReceipt> = z.strictObject({
  uid: FirestoreId,
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseDetail" }),
  status: z.enum(PURCHASE_STATUSES).meta({ column: true, label: "Status" }),
  supplier: UidNameRef.meta({ label: "Supplier" }),
  destinations: z.array(PurchaseDestinationSchema).min(1).meta({ label: "Destination" }),
  items: z.array(PurchaseReceiptItem).min(1).meta({ label: "Item" }).superRefine(checkZeroPricedComponents),
  subject: z.string().meta({ pii: "mask", column: true, label: "Subject", linkTo: "purchaseDetail" }),
  reference: z.string().max(200).nullable().meta({ column: true, label: "Reference" }),
  // Bare `.nullable()`: a new collection has no corpus to forgive, so a writer
  // that omits the key fails rather than storing an absence (unlike the
  // fulfillment's catalogued `.default(null)`).
  due_at: chicagoInstant().meta({ column: true, label: "Due", serverSortVia: "due_at_fs" }).nullable(),
  // Never a column — an `_fs` mirror is `due_at` under the Timestamp encoding.
  due_at_fs: FirestoreTimestamp.nullable(),
  query_by_uid_store: z.array(FirestoreId),
  query_by_items: z.array(z.string()),
  query_by_contacts: z.array(z.string()),
  query_by_dates: z.array(z.string()),
  version: z.int().min(0).default(0),
  // `propagate: false`, as on the fulfillment: the purchase's actor authored the
  // PO, this one the receipt.
  created_by: ActorRef.nullable().meta({ column: true, label: "Created By", propagate: false }),
  updated_by: ActorRef.nullable().meta({ column: true, label: "Updated By", propagate: false }),
  ...TimestampFields,
}).superRefine(checkDestinationJoin).superRefine(checkLeadingDivider("purchase_receipt")).meta({
  title: "Purchase Receipt",
  collection: "purchase-receipts",
  displayDefaults: {
    columns: ["number", "supplier.name", "subject", "status", "due_at"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<PurchaseReceipt>;
