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
  checkZeroPricedAmount,
  isLineItemType,
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
import { LineItemCore } from "./_items.ts";

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
  /**
   * Was this line included at no charge as part of its parent product?
   *
   * ⭐ **Mirrored from `OrderDocLineItemType.zero_priced`** so a fulfillment
   * line carries the same fact as the order line it is projected from
   * (`manager#421`). A fulfillment has no `price` — money is not a warehouse
   * concern — so this is NOT a price field: it says the line moves with its
   * parent, which is a picking fact as much as a billing one.
   *
   * ⚠️ Same shape as the order's, `.nullable().optional()` — see the invoice
   * twin's docblock for why matching rather than tightening is the point.
   */
  zero_priced?: boolean | null;
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
  // The six shared fields, one instance each, from `_items.ts`. Every one of
  // them is a no-op for this grain — fulfillment already carried the canonical
  // declarations — which is the point: it is a projection of an order item, so
  // it must not be possible for it to accept something the order refuses.
  uid: LineItemCore.uid,
  type: z.enum(FULFILLMENT_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  name: LineItemCore.name,
  description: LineItemCore.description,
  quantity: LineItemCore.quantity,
  stock_method: StockMethodEnum.optional().meta({ column: true, label: "Stock Method" }),
  zero_priced: LineItemCore.zero_priced,
  path: LineItemCore.path,
  order_number: z.int().optional().meta({ column: true, label: "Order #" }),
  uid_order: FirestoreId.optional(),
  quantity_order: z.number().int().min(0).optional(),
  path_substituted_for: z.array(ItemUid).optional(),
  // 🔴 Attached to the **Inner** const so `FulfillmentItem`'s discriminated union
  // below enforces it, matching `order.ts` and (since 2026-09-09) `invoice.ts`.
  // ⚠️ It is VACUOUS at this grain and that is deliberate rather than an
  // oversight: a fulfillment line carries no `price`, so `checkZeroPricedAmount`
  // returns early (`schemas/common.ts`). It is attached anyway so all three
  // grains read identically — a reader comparing them should not have to work
  // out whether the absence here is a decision or a gap.
}).superRefine(checkZeroPricedAmount);

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

// ── Input schemas ────────────────────────────────────────────────
//
// 🔴 **This grain had NO input schema until core#97, and the picker PUT
// validated its request body against the DOCUMENT schema
// (`FulfillmentLineItem`).** That is a real divergence from the other two
// grains, not a naming gap:
//
// | grain | stored | input |
// |---|---|---|
// | order | `OrderDocLineItemInner` — `z.strictObject` | `OrderItemLineInner` — `z.object` |
// | invoice | `InvoiceDocLineItemInner` — `z.strictObject` | `InvoiceItemInputLineInner` — `z.object` |
// | fulfillment | `FulfillmentLineItemInner` — `z.strictObject` | *the same object* |
//
// Two things followed from it. The picker boundary **rejected** an undeclared
// key where the other two **strip** it, against this package's own rule that an
// input is a `z.object` "so extra properties are silently stripped rather than
// rejected". And the object MODE decides who deploys first — `z.strictObject`
// means the SENDER must stop first — so a tightening of the stored line item
// silently put the manager on the REFINE row, where the same change on an order
// or an invoice line would not.
//
// ⭐ **The field list is MEASURED from the service, not chosen.** Every body
// field `updateFulfillmentItems` reads: `uid` (23 sites), `path` (19),
// `path_substituted_for` (10), `quantity` (5), and `quantity_order` (1, only to
// refuse it). Everything else on a stored line — `type`, `name`, `description`,
// `stock_method`, `order_number`, `uid_order`, `zero_priced` — is re-derived
// server-side from the order item, the replacement product or the catalog
// component entry, so the body's copy was read and discarded. The service says
// it in its own words: *"the picker owns `quantity` and the addressing, the
// server owns every descriptive field."*
//
// 🔴 **Deriving that list by eye is the one way this change can do harm**, and
// the invoice grain already has the scar: `InvoiceItemInputLineInner` is a
// `z.object`, so a field missing from the input channel is STRIPPED, the write
// succeeds, and the value is simply gone from the stored document —
// `path_substituted_for` did exactly that, which is why
// `tests/invoice.test.ts` carries an arm named *"the INPUT schema accepts it, or
// every PUT drops it"*. The fulfillment twin of that arm is in
// `tests/fulfillment.test.ts`.

/**
 * One picker-editable line in a `PUT /fulfillments/{uid}/items` body.
 *
 * ⚠️ **`quantity_order` is declared here even though the API always refuses it,
 * and that is load-bearing rather than sloppy.** It is the divergence marker
 * between the picker's count and the order's — `mergeLineItem` stamps the
 * ORDER's quantity onto it when the two disagree — so a client structurally
 * cannot compute it, and `updateFulfillmentItems` throws
 * *"quantity_order is server-managed"* for any body carrying it.
 *
 * 🔴 **Omitting it here would DELETE that 400.** A `z.object` strips an
 * undeclared key, so the service would never see the field and would answer 200
 * while silently ignoring what the client asserted — the exact silent-acceptance
 * class this whole block exists to close. Declaring it keeps the key intact
 * through the parse so the service's check still fires.
 *
 * ⚠️ **The refusal deliberately stays in the SERVICE rather than moving to a
 * `z.never()` here**, though the boundary is where a constraint would normally
 * live. Two reasons, and the second is the stronger one: the service's message
 * names the field and says *why*, where Zod's would not; and `never` is a
 * construct nothing in this package walks — `collectLeafPaths`
 * (`schemas/zod-walk.ts`) reports it as uninterpretable and `tests/pii.test.ts`
 * fails rather than skipping it, correctly. Introducing the package's only
 * `never` node to save one runtime check would mean teaching a SHARED walker a
 * new arm, which is a worse trade than one owner in the service.
 *
 * ⚠️ **`path` is REQUIRED here, and the two existing input schemas disagree
 * about that** — `OrderItemLineInner` has `path: z.array(ItemUid)` while
 * `InvoiceItemInputLineInner` has `.optional()`. This grain follows the order,
 * for a reason rather than by majority: `updateFulfillmentItems` map-keys the
 * submission on `pathKey(li.path)` and `rebuildFulfillmentItems` treats it as a
 * SET keyed on `path`, so an absent one is not a defaulted value but a row that
 * addresses nothing. Requiring it turns a confusing failure deep in the rebuild
 * into a 400 that names the field.
 *
 * ⚠️ It is a refinement of the boundary — the DOCUMENT schema standing in as
 * the request contract accepted an absent `path` via `LineItemCore.path`'s
 * `.default([])` — but no writer can produce one: the manager sends stored
 * lines, and `computeItemPaths` authors `path` on every stored line.
 */
export interface FulfillmentItemInputLineType {
  uid: string;
  path: string[];
  quantity: number;
  path_substituted_for?: string[];
  /** Declared so the service can REFUSE it — see the note above. */
  quantity_order?: number;
}

const FulfillmentItemInputLineInner = z.object({
  uid: ItemUid,
  path: z.array(ItemUid),
  quantity: z.number().int().min(0),
  path_substituted_for: z.array(ItemUid).optional(),
  // Same declaration as the stored line's, so a body carrying it survives the
  // parse and reaches `updateFulfillmentItems`' explicit refusal.
  quantity_order: z.number().int().min(0).optional(),
});

export const FulfillmentItemInputLine: z.ZodType<FulfillmentItemInputLineType> =
  FulfillmentItemInputLineInner;

/**
 * The whole `PUT /fulfillments/{uid}/items` body.
 *
 * Lives here rather than in the route for the same reason `UpdateOrderInput`
 * and `UpdateInvoiceInput` do: the request contract is part of the grain's
 * shape, and a body declared beside its handler is invisible to every guard in
 * this package.
 *
 * ⚠️ **`lineItems` is the COMPLETE set of picker-editable lines, and structural
 * items are not in it.** The server preserves stored dividers and reassembles
 * via `computeItemPaths`, so there is no divider arm here and no union — the
 * one place the three grains' item schemas legitimately differ in ARITY rather
 * than in field list.
 */
export interface UpdateFulfillmentItemsInputType {
  /**
   * Required, not `?:` — this is the PARSED shape a handler receives, and
   * `.default([])` guarantees it. `z.ZodType<T>` is checked in one direction
   * only, so `?:` here would compile while telling every consumer to branch on
   * a case no parse can produce (`tests/interface-optionality.test.ts`).
   */
  lineItems: FulfillmentItemInputLineType[];
  version: number;
}

export const UpdateFulfillmentItemsInput: z.ZodType<UpdateFulfillmentItemsInputType> = z.object({
  lineItems: z.array(FulfillmentItemInputLineInner).default([]),
  version: z.number().int().min(0),
});

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

/**
 * Narrows a fulfillment doc item to a line item (excludes the two dividers).
 *
 * 🔴 **core#90.** This grain was the only one of the three without a guard, so
 * the predicate was hand-written four times across three repos and two of those
 * copies returned `boolean` and therefore narrowed NOTHING — `isLineItemType`
 * tests the `type` STRING, so a caller reaching for it got a truth value and
 * still had to cast to touch `quantity_order` or `path_substituted_for`. The
 * order and invoice grains have had `isLineItem` / `isInvoiceLineItem` all
 * along; this closes the set.
 *
 * ⚠️ **A key-presence test is not a substitute and reverses the question.**
 * `"zero_priced" in item` narrows at compile time and, at runtime, skips exactly
 * the documents that OMIT the key — which is the population any component census
 * is counting. The decision is `ITEM_CONTRACTS[type].kind`, shared with the
 * other two grains, and it is the only thing that should decide it.
 */
export function isFulfillmentLineItem(item: FulfillmentItemType): item is FulfillmentLineItemType {
  return isLineItemType(item.type);
}

/**
 * Sanitized organization snapshot — uid and CHAIN.
 *
 * ⚠️ This said "uid and name only" until 2026-09-08 and had been wrong since
 * `beta.309` removed the composed `name`: the field is `path`, and the name is
 * composed from it by `composeOrgName`.
 *
 * ⚠️ **It also carries no `crms_id`, unlike `DocumentOrganizationSnapshot` on
 * orders, invoices and quotes.** Plausibly deliberate — this is the client-facing
 * warehouse view, which states no price and no financial flags, and an
 * operator-facing account number is neither — but nobody has written that down,
 * so it reads as an omission. core#94 asks for the ruling.
 */
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
  // Bare `z.string()`, identical to the other two grains as of core#97
  // increment 3 — the interface for `OrderDocument.subject` carries the census
  // and the reason the `.default("")` was a widening rather than a guarantee.
  // 1,020 of 1,020 stored fulfillments carry the key in prod and dev, and the
  // projection writes `orderNew.subject ?? ""` explicitly.
  subject: z.string().meta({ pii: "mask", column: true, label: "Subject", linkTo: "fulfillmentDetail" }),
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
