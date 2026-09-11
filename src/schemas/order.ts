/**
 * Order schemas — Firestore collection: orders
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { LineItemCore } from "./_items.ts";
import {
  Address,
  DocumentOrganizationSnapshot,
  type DocumentOrganizationSnapshotType,
  type AddressType,
  checkItemContract,
  checkZeroPricedAmount,
  checkZeroPricedComponents,
  checkItemPriceFormula,
  checkPriceBaseUnit,
  COARevenueEnum,
  type COARevenueType,
  DOC_LINE_ITEM_TYPES,
  type DocLineItemTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  InclusionTypeEnum,
  type InclusionTypeType,
  JurisdictionEnum,
  type JurisdictionType,
  type NameParts,
  NamePartsFields,
  NamePartsFieldsInput,
  type NamePartsInput,
  Phone,
  PriceFormulaEnum,
  type PriceFormulaType,
  RATE_UNIT_META,
  RateTypeEnum,
  type RateType,
  StockMethodEnum,
  type StockMethodType,
  TaxedAsEnum,
  type TaxedAsType,
  type InvoiceStatusType,
  InvoiceStatusEnum,
  NameField,
  TimestampFields,
  ActorRef,
  type ActorRefType,
  isFulfillableItemType,
  isLineItemType,
} from "./common.ts";

export const ORDER_STATUSES = [
  "draft", "quoted", "reserved", "active", "complete", "canceled",
] as const;
export type OrderStatusType = typeof ORDER_STATUSES[number];
const OrderStatus: z.ZodType<OrderStatusType> = z.enum(ORDER_STATUSES);

/**
 * Statuses an operator may set directly via UpdateOrderInput.status.
 * `active` and `complete` are computed by the booking workflow and are
 * never accepted from a manual write.
 */
export const ORDER_USER_STATUSES = ["draft", "quoted", "reserved", "canceled"] as const;
export type OrderUserStatusType = typeof ORDER_USER_STATUSES[number];

/**
 * Statuses derived from booking state — set only by the API's booking write
 * path (reserved → active when a booking moves quantity into out;
 * active → complete when every quantity has reached a terminal state).
 */
export const ORDER_COMPUTED_STATUSES = ["active", "complete"] as const;
export type OrderComputedStatusType = typeof ORDER_COMPUTED_STATUSES[number];

/**
 * The statuses an operator can move to from the given current status.
 * Returns an empty list for computed statuses (`active`, `complete`) and
 * filters the current status out of the user-settable set.
 */
export function getOrderStatusTransitions(current: OrderStatusType): OrderUserStatusType[] {
  if ((ORDER_COMPUTED_STATUSES as readonly string[]).includes(current)) return [];
  return ORDER_USER_STATUSES.filter((s) => s !== current);
}

/**
 * Server-side gate for an order status write. `source: "manual"` rejects
 * writes that move into a computed status or out of a computed status into
 * anything other than the same value (no-op). `source: "propagation"`
 * trusts the booking write path that sets `active` or `complete`.
 */
export function isValidOrderStatusTransition(
  prev: OrderStatusType,
  next: OrderStatusType,
  source: "manual" | "propagation",
): boolean {
  if (prev === next) return true;
  if (source === "propagation") return true;
  return (getOrderStatusTransitions(prev) as readonly string[]).includes(next);
}

// Item type constants imported from common.ts:
// DOC_LINE_ITEM_TYPES / DocLineItemTypeType — the billable types, the line arm of
// both the input union (`OrderItem`) and the stored one (`OrderDocItem`). The
// divider types are literals on their own arms rather than members of a
// combined enum, which is what discriminates the unions.

const INCLUSION_TYPES_NULLABLE = ["default", "mandatory", "optional"] as const;

/**
 * Order dates — all six date boundaries as ISO datetime strings with offset,
 * or null when the boundary is unset.
 */
export interface OrderDatesType {
  delivery_start: string | null;
  delivery_end: string | null;
  collection_start: string | null;
  collection_end: string | null;
  charge_start: string | null;
  charge_end: string | null;
}

/** Zod schema for order dates. */
export const OrderDates: z.ZodType<OrderDatesType> = z.object({
  delivery_start: chicagoInstant().nullable(),
  delivery_end: chicagoInstant().nullable(),
  collection_start: chicagoInstant().nullable(),
  collection_end: chicagoInstant().nullable(),
  charge_start: chicagoInstant().nullable(),
  charge_end: chicagoInstant().nullable(),
});

/**
 * Order dates with Firestore timestamp companions — the persisted, per-destination
 * date set. Each destination on an order/fulfillment/invoice owns one of these;
 * there is no order-level rollup (derive on demand via deriveOrderDateEnvelope).
 */
export interface OrderDocDatesType {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType | null;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType | null;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType | null;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType | null;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType | null;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType | null;
  days_active: number | null;
  days_charged: number | null;
}

/**
 * Zod schema for order dates with Firestore timestamp companions.
 *
 * 🔴 **The twelve BOUNDARY fields carry no `.default(null)`, deliberately.** A
 * default is inert on the CFS write path — `validateBeforeWrite` discards
 * `result.data` and writes the raw document — so its only live effect was to let
 * a payload OMIT a key and still parse, which is how a non-optional field ends
 * up absent in Firestore. Without one, an omitted boundary is a refused write.
 * Same reasoning that dropped `Invoice.destinations`' `.default([])`, and the
 * same house rule: prefer making a defect class unrepresentable over policing
 * it.
 *
 * Verified before removing, because a stored document missing a key is
 * invisible until its next WRITE (reads cast via `docData<T>`, they do not
 * parse) and would then be refused in front of an operator: **0 absent
 * boundary keys across all 1,020 orders, 1,009 invoice destinations and 1,020
 * fulfillments, in BOTH projects** (census 2026-09-09). The one constructor is
 * `canonicalizeDestinationDates` (`api-cloudrun/src/services/orders.ts`), which
 * builds all fourteen explicitly; every other path copies the whole map.
 *
 * 🔴 **The census BLOCKED on the two derived fields, and what it found was not
 * two missing keys.** `days_active` / `days_charged` were absent on 20 invoice
 * pairs — the 2025-12-02 CRMS import — and the absence was a SYMPTOM: all six
 * boundary instants on those pairs held one value, `2026-01-24T15:37:56.xxx`, a
 * migration's own clock written into delivery, collection and charge alike,
 * while the real 2023 windows sat on the source orders. There was no duration
 * because there was no window. Repaired 2026-09-09 with owner approval by
 * projecting each order's whole `dates` map
 * (`api-cloudrun/scripts/backfill-invoice-destination-windows.ts`), prod then
 * dev-by-mirror, both verified at 0 by two independent instruments.
 *
 * ⭐ **The instrument that caught it was an anti-vacuity arm, not the census.**
 * The first repair drafted here projected only the two durations and asserted
 * the windows already agreed before doing so. They did not — on all twelve
 * boundaries, on all 20 — so it wrote nothing. Without that arm it would have
 * grafted each order's real duration onto a fabricated window and the census
 * would have gone green.
 */
export const OrderDocDates: z.ZodType<OrderDocDatesType> = z.strictObject({
  delivery_start: chicagoInstant().nullable(),
  delivery_start_fs: FirestoreTimestamp.nullable(),
  delivery_end: chicagoInstant().nullable(),
  delivery_end_fs: FirestoreTimestamp.nullable(),
  collection_start: chicagoInstant().nullable(),
  collection_start_fs: FirestoreTimestamp.nullable(),
  collection_end: chicagoInstant().nullable(),
  collection_end_fs: FirestoreTimestamp.nullable(),
  charge_start: chicagoInstant().nullable(),
  charge_start_fs: FirestoreTimestamp.nullable(),
  charge_end: chicagoInstant().nullable(),
  charge_end_fs: FirestoreTimestamp.nullable(),
  days_active: z.int().nullable(),
  days_charged: z.int().nullable(),
});

/**
 * Contact reference embedded in a destination endpoint.
 * When present (not null), uid and first_name are required. `name` is the
 * server-derived display string (see `deriveName` in common.ts) — populated
 * by api-cloudrun on every write so consumers don't re-derive client-side.
 */
export interface DestinationContactType extends NamePartsInput {
  uid: string;
  name: string;
  phones?: string[];
}

/** Zod schema for destination contact reference. */
export const DestinationContact: z.ZodType<DestinationContactType> = z.object({
  uid: FirestoreId,
  ...NamePartsFieldsInput,
  name: NameField,
  phones: z.array(Phone).optional(),
});

/**
 * Contact reference in a destination endpoint (document schema — uid & first_name required).
 *
 * ⚠️ **`phones` is REQUIRED here and `.optional()` on {@link DestinationContact},
 * and that asymmetry is deliberate** (core#95 batch 4). It carried
 * `.default([])`, which is inert on a stored schema — `validateBeforeWrite`
 * discards `result.data` and writes the raw document — so its only effect was
 * to let a writer omit the key.
 *
 * The input stays lenient because a client that names a contact need not know
 * its phone numbers; api-cloudrun's `buildDestinationPair` supplies the empty
 * list, which is what makes this requirement reachable. Tightening the input
 * instead would 400 a payload that is semantically fine.
 *
 * Measured 2026-09-10 before the tightening: **0 of 4,560 prod and 0 of 4,571
 * dev documents** fail it across the six embedding collections. ⚠️ The
 * denominator is thin on the destination positions — 18 prod / 22 dev non-null
 * contact objects, and `invoices.destinations[].delivery.contact` has **none in
 * either project** — so this rests on the WRITER audit, not on the corpus.
 */
export interface DocDestinationContactType extends NameParts {
  uid: string;
  name: string;
  phones: string[];
}

/** Zod schema for destination contact reference (document version). */
export const DocDestinationContact: z.ZodType<DocDestinationContactType> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
  phones: z.array(Phone),
});

/**
 * A single destination endpoint (delivery or collection).
 */
export interface DestinationEndpointType {
  uid?: string | null;
  address?: AddressType | null;
  instructions?: string | null;
  contact?: DestinationContactType | null;
}

/** Zod schema for a destination endpoint. */
export const DestinationEndpoint: z.ZodType<DestinationEndpointType> = z.object({
  uid: FirestoreId.nullable().optional(),
  address: Address.optional(),
  // Free-text operator notes ("key under the mat", "ask for John") routinely
  // carry PII — tagged so the fixture sanitizer + logger masks them.
  instructions: z.string().meta({ pii: "mask" }).nullable().optional(),
  contact: DestinationContact.nullable().optional(),
});

/**
 * Destination endpoint in the full document (uid is nullable, contact uses doc version).
 */
export interface DocDestinationEndpointType {
  uid: string | null;
  address: AddressType | null;
  instructions: string | null;
  contact: DocDestinationContactType | null;
}

/** Zod schema for a destination endpoint (document version). */
export const DocDestinationEndpoint: z.ZodType<DocDestinationEndpointType> = z.strictObject({
  uid: FirestoreId.nullable(),
  address: Address,
  instructions: z.string().meta({ pii: "mask", column: true, label: "Instructions" }).nullable(),
  // The whole contact is one column — a joined name with a popover, not four
  // columns of name parts. That is why an object node has to be annotatable.
  contact: DocDestinationContact.nullable().meta({ column: true, label: "Contact" }),
});

/**
 * A destination pair — delivery and collection endpoints.
 *
 * `customer_collecting` is true when the customer picks up the items at our
 * warehouse for the delivery side of this pair. `customer_returning` is true
 * when the customer drops the items off at our warehouse for the collection
 * side. Both default to false (we deliver / we collect).
 */
export interface DestinationType {
  /**
   * **The pair's identity — the destination DIVIDER's uid** — stated by the
   * client rather than derived. See {@link DocDestinationType.uid} for what the
   * identity IS and why `delivery.uid` cannot be it.
   *
   * ⚠️ **Optional here and REQUIRED on the stored pair, and that asymmetry is
   * the whole point of this field.** A client that states it is answered by
   * `assignDestinationPairUids` rung 0 and nothing derives; a client that omits
   * it falls to the endpoint derivation, which is what every caller does today.
   *
   * 🔴 **Declaring it is what lets the endpoint derivation die.** `Destination`
   * is `z.object`, so an undeclared key is STRIPPED at the boundary — the
   * manager has minted the correct value since
   * `buildDestinationPairWithDivider` landed and ships the whole pair, and it
   * was being thrown away here. Without this field the ONLY join a native
   * create has is rung 1 (`divider.uid_delivery` against `pair.delivery.uid`),
   * so removing those two divider fields at the contract step would leave a
   * multi-destination create with no join at all: measured on
   * `assignDestinationPairUids`, two destinations with the endpoint fields gone
   * yields two MINTED pair uids naming no divider — 2 orphan dividers and 2
   * orphan pairs, which api-cloudrun's `findDestinationJoinIssues` refuses with
   * a 400.
   *
   * ⚠️ **And the one-destination case hides it completely.** Rung 2 — the
   * forced leftover — answers a single divider beside a single pair with no
   * endpoints at all, and every one of the 2,980 prod documents is 1:1. So the
   * corpus, the audits and the write guard would all report clean right up to
   * the first multi-destination order.
   */
  uid?: string;
  dates: OrderDatesType;
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
  /** Level 1 of the jurisdiction precedence — see {@link DocDestinationType}. */
  jurisdiction?: JurisdictionType | null;
}

/** Zod schema for a destination pair. */
export const Destination: z.ZodType<DestinationType> = z.object({
  // `z.uuid()`, matching the STORED pair (`DocDestination.uid`) and the divider
  // arm this value names (`DestinationDividerArm.uid`) — deliberately NOT
  // `ItemUid`, which also admits a 20-char `FirestoreId` and would therefore
  // accept the `destinations/{uid}` document id this identity exists not to be.
  // All 2,980 prod destination dividers are uuid-shaped. See
  // {@link DestinationType.uid}.
  uid: z.uuid().optional(),
  dates: OrderDates,
  delivery: DestinationEndpoint,
  collection: DestinationEndpoint,
  customer_collecting: z.boolean().optional(),
  customer_returning: z.boolean().optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
});

/**
 * Document-level destination pair. See `DestinationType` for flag semantics.
 */
export interface DocDestinationType {
  /**
   * **The pair's identity, and it is the DESTINATION DIVIDER's uid** — the
   * `items[]` row (`type: "destination"`) whose section delivers here.
   *
   * 🔴 **This is the join, and it is the only one.** *"Which destination does
   * this section of the document deliver to"* used to be stored twice — on the
   * divider as `uid_delivery`/`uid_collection`, and on this pair as
   * `delivery.uid`/`collection.uid` — joined by a **value** (a
   * `destinations/{uid}` document id) rather than by identity. Every one of
   * api-cloudrun#662 / #663 / #664 is one copy moving without the other.
   *
   * ⚠️ **`delivery.uid` cannot be this identity, by construction.**
   * `findOrCreateDestination` is a **global address-book dedupe** — matched on
   * `mapbox_ids` → coordinates → exact `address.full`, scoped to neither the
   * organization nor the document — so two pairs on one document delivering to
   * one address legitimately SHARE a `delivery.uid`.
   * `findDuplicateDestinations` (api-cloudrun `lib/firestoreWrite.ts`) has said
   * so in its own words for as long as it has existed: *"a destination has no
   * stable single-field identity."*
   *
   * ⚠️ **An address correction is now ordinary payload.** Repointing
   * `delivery.uid` moves the ENDPOINT, not the row — which is what lets
   * `pairsMatch` see the difference and `carryOverridablePairFields` run on the
   * population it was written for (api-cloudrun#663: 239 of 989 prod invoice
   * pairs named no order pair at all, 14 carrying a `jurisdiction` that prices
   * their lines).
   *
   * ⚠️ **NOT a `destinations/{uid}` document id.** It is an `items[].uid` — a
   * UUID, and the same value `path[k]` already carries for that divider. All
   * 2,980 prod destination dividers are UUID-shaped (measured 2026-08-25,
   * orders + invoices + fulfillments, dev identical).
   */
  uid: string;
  dates: OrderDocDatesType;
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting: boolean;
  customer_returning: boolean;
  /**
   * **Level 1** of the jurisdiction precedence (`resolveJurisdiction` in
   * `@cfs/core/utils/taxes`) — this document's OWN answer for this
   * destination, and the one that wins.
   *
   * 🔴 **Nothing seeds it.** A create stores exactly what the payload states
   * per destination, on the native path and the CRMS path alike — so `null` is
   * the ordinary case and it means *inherit*, not *no jurisdiction*. The seed
   * that used to write `organization.jurisdiction_claim` down onto every
   * destination was deleted because a stored copy is not a convenience but an
   * OVERRIDE that outranks the thing it copied: level 2 already answers on its
   * own rung, and the copy made `update-org:tax-axes-to-orders` relabel the
   * snapshot while repricing nothing. The reasoning lives at the deletion,
   * `api-cloudrun/src/services/orders.ts`. Which rung answered is visible
   * through `destinationJurisdictions` (manager#304), never by reading a
   * stored value here.
   *
   * ⚠️ **Per DESTINATION, which is the whole point.** A document is never
   * re-welded to one jurisdiction the way `tax_profile` welds it — a
   * Rantoul-claim customer taking a one-off Chicago delivery edits that one
   * entry, and a mixed order prices each leg correctly. A line reaches its
   * destination through `item.path`.
   *
   * ⚠️ **This is a SNAPSHOT.** An order records what it was billed, so level 1
   * must not re-resolve out from under a live document.
   *
   * `null`/absent asserts nothing and asks the next level; the answer "sources
   * somewhere CFS collects no tax" is the `no_nexus` value
   * ({@link JurisdictionType}).
   *
   * Optional through api-cloudrun#409 Phase 1: every new tax field is additive.
   */
  jurisdiction?: JurisdictionType | null;
}

/**
 * The destination-pair fields the ORDER/FULFILLMENT grain and the INVOICE grain
 * both carry, as ONE instance per field.
 *
 * 🔴 **This exists because the invoice's hand-copy of these six keys had already
 * drifted, in the one direction a destination pair can least afford.** `9435a15`
 * (2026-09-08) made `customer_collecting` / `customer_returning` REQUIRED on the
 * order grain, because the `.default(false)` they carried never materialized in
 * Firestore (`validateBeforeWrite` discards `result.data`) and its one effect was
 * to let a writer omit a flag that reads downstream as *"we deliver"* — the answer
 * that sends a crew to an address. `InvoiceDocDestination` was a separate
 * `z.strictObject` restating the same keys, so it kept both defaults and the
 * compiler could not see the gap: `InvoiceDocDestinationType extends
 * DocDestinationType` hands over the TYPE and the schema inherited nothing.
 * 16 flags were absent across 8 prod invoices (core#101, repaired 2026-09-09).
 *
 * ⭐ **SPREAD here, where the line item is referenced per key — and the difference
 * is key ORDER, not a change of mind.** `getFirestoreColumns` walks the shape, so
 * a spread sets the operator's column order. `schemas/_items.ts` cannot spread
 * because its six shared fields sit at three different arrangements across the
 * grains and no key order leaves all three unchanged. Here the shared fields are
 * the WHOLE of `DocDestination` in its existing order, and the invoice's only
 * extra key (`uid_order`) already sits first — so `{ uid_order, ...this }`
 * reproduces both current shapes exactly. Verified by dumping
 * `getFirestoreColumns` / `getTypesenseColumns` / `getInitialValues` for `orders`,
 * `invoices` and `fulfillments` before and after: byte-identical, order included.
 *
 * ⚠️ **A grain that SHADOWS a key after the spread is the one thing the spread
 * cannot see** — `{ ...DestinationPairCore, customer_collecting: z.boolean() }`
 * compiles and the later key silently wins, which is exactly how the invoice
 * drifted the first time. `tests/destination-pair-parity.test.ts` asserts instance
 * identity on both grains for that reason; do not delete it as redundant.
 *
 * 🔴 **Sharing the instance is what makes `.meta()` safe.** `z.globalRegistry` is
 * a WeakMap keyed on the schema instance, so a re-declaration carries none of the
 * base's annotations. A grain needing a different heading writes
 * `DestinationPairCore.delivery.meta({ … })`, which clones visibly at the call site.
 *
 * ⚠️ **Not on the `@cfs/core/schemas` barrel, deliberately** — no consumer assembles
 * a pair from parts, and publishing the parts would publish a second way to spell
 * one. It is reachable at `@cfs/core/schemas/order` only because `order.ts` is an
 * entrypoint; `DocDestination` is the shape to import.
 */
export const DestinationPairCore: {
  uid: z.ZodType<string>;
  dates: z.ZodType<OrderDocDatesType>;
  delivery: z.ZodType<DocDestinationEndpointType>;
  collection: z.ZodType<DocDestinationEndpointType>;
  customer_collecting: z.ZodType<boolean>;
  customer_returning: z.ZodType<boolean>;
  jurisdiction: z.ZodOptional<z.ZodNullable<z.ZodType<JurisdictionType>>>;
} = {
  // The destination divider's uid — see {@link DocDestinationType.uid}. Typed
  // `z.uuid()` to match `DestinationDividerArm.uid` exactly, because it IS that
  // value; a looser type here would admit a pair no divider can name.
  uid: z.uuid(),
  dates: OrderDocDates,
  // Two keys, ONE schema instance — and two headings, because `.meta()` clones.
  // `DocDestinationEndpoint.meta({ label: "Delivery" }) !== DocDestinationEndpoint`,
  // so the base stays unannotated and every column below each leg inherits its
  // own prefix ("Delivery Address" / "Collection Address").
  delivery: DocDestinationEndpoint.meta({ label: "Delivery" }),
  collection: DocDestinationEndpoint.meta({ label: "Collection" }),
  // 🔴 **REQUIRED, and the `.default(false)` they carried until 2026-09-08 was
  // doing the opposite of what it looked like.** `validateBeforeWrite` discards
  // `result.data` and writes the RAW doc (`api-cloudrun/src/lib/validate.ts`
  // says so in place), so a `.default()` on a stored schema never materializes
  // in Firestore. Its one effect was to let a writer omit the field and pass
  // validation — which is the failure this pair can least afford, because the
  // two flags are DIRECTIONAL and independent and every consumer reads them as
  // booleans. An absent flag reads as `false`, i.e. *"we deliver"*, which is
  // the answer that sends a crew to an address.
  //
  // ⚠️ **The invoice grain kept both defaults until 2026-09-09 and this shape is
  // what closes it.** Its 16 absent flags were NOT backfilled `false`: they were
  // projected from each invoice's source order, because a blanket default would
  // have been wrong on 5 of the 8 documents (core#101). An inert default is what
  // let those rows omit the field, so they are a biased sample by construction —
  // see `CLAUDE.md` § *`.default()` and `.optional()`*.
  //
  // ⭐ **No `.meta({ initial })` beside them, deliberately.** `getInitialValues`
  // falls through to `case "boolean": return false`, so the form seed is
  // unchanged — an `initial` here would restate what the type already says.
  // The five `z.boolean().default(true)` fields needed one because their
  // type-derived zero was the WRONG seed; see `schemas/initial.ts`.
  //
  // ⚠️ The INPUT (`Destination`, above) stays `.optional()`: a client may leave
  // the flags out and the writer fills them in explicitly. That is the rule —
  // the writer stamps, the storage schema refuses anything else.
  customer_collecting: z.boolean(),
  customer_returning: z.boolean(),
  // ⭐ **Adding a field to this pair is now ZERO schema edits beyond this
  // object.** It used to be two, and only one was enforced: the invoice
  // inherited the TYPE through `InvoiceDocDestinationType extends
  // DocDestinationType` and its schema was a hand-list that inherited nothing,
  // so a document carrying the new field type-checked and was then REFUSED at
  // write. Both grains now spread this shape.
  //
  // ⚠️ **What still needs a decision is the OVERRIDE POLICY, not the shape.**
  // `toInvoiceDestinationPair` and `pairsMatch` (`utils/invoices.ts`) both walk
  // the pair with `Object.entries`, so a new field is carried and compared for
  // free; the one deliberate call is whether it belongs in
  // `INVOICE_OVERRIDABLE_PAIR_FIELDS` — payload the invoice owns and
  // `carryOverridablePairFields` reconciles.
  jurisdiction: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction",
  }),
};

/**
 * Zod schema for a document-level destination pair.
 *
 * Spread from {@link DestinationPairCore}, which the invoice grain spreads too —
 * see that object for why this is a spread where the line item is referenced per
 * key.
 */
export const DocDestination: z.ZodType<DocDestinationType> = z.strictObject({
  ...DestinationPairCore,
});

// ── Shared modifier types ─────────────────────────────────────────

/**
 * A rate-based charge applied to an item or order (tax or transaction fee).
 * uid references a tax doc (for taxes) or a product doc (for transaction fees).
 */
export interface PriceModifierType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  amount_cents: number;
}

/**
 * Zod schema for a rate-based price modifier (tax or transaction fee).
 *
 * `rate` and `amount_cents` are deliberately DIFFERENT units and the names say
 * so: `rate` stays a 4dp dollars-or-percent rate discriminated on `type` (see
 * {@link DiscountType}), while `amount_cents` is the computed money in integer
 * cents. A sweep that "converts every number in this object" restores exactly
 * the rate/amount confusion the suffix exists to prevent.
 */
export const PriceModifier: z.ZodType<PriceModifierType> = z.strictObject({
  uid: FirestoreId,
  // Tax or fee label ("IL Sales Tax") — see `OrderDocLineItem.name`.
  // No `label`: the heading comes from whichever key holds the array, so this
  // one annotation reads "Tax" under `totals.taxes` and "Transaction Fee" under
  // `totals.transaction_fees`.
  name: z.string().meta({ pii: "none", column: true }),
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum,
  amount_cents: z.int().meta({ column: true, label: "Amount" }),
});

/**
 * Denormalized tax snapshot without computed amount — used on product catalog entries.
 * PriceModifier extends this shape with `amount` for order-time computation.
 */
export interface TaxRefType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
}

/** Zod schema for a denormalized tax snapshot without computed amount. */
export const TaxRef: z.ZodType<TaxRefType> = z.strictObject({
  uid: FirestoreId,
  // Tax label ("IL Sales Tax") — see `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none", column: true }),
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum,
});

/**
 * Discount applied to an item price. Nullable — null means no discount.
 * rate is per-unit for flat discounts (rate × quantity × days_factor = amount).
 */
export interface DiscountType {
  rate: number;
  type: RateType;
  amount_cents: number;
}

/**
 * `rate` means two different things depending on `type`, so the bounds differ:
 *
 * - `percent` → a percentage, and the only valid range is `[0, 100]`. Xero's
 *   `DiscountRate` rejects anything outside it, and `calculateItemSubtotal`
 *   would otherwise produce a `subtotal_discounted` above the subtotal (rate < 0)
 *   or below zero (rate > 100).
 * - `flat` → dollars **per unit, per pricing factor**
 *   (`rate × quantity × pricingFactor === amount_cents / 100`), so it has no
 *   upper bound — a $150/unit discount on a $200/unit line is legal — but it
 *   cannot be negative.
 *
 * A single `.min(0).max(100)` on `rate` would therefore be wrong: it silently
 * forbids most flat discounts.
 *
 * ⚠️ **`rate` stays DOLLARS on the `flat` arm and is NOT renamed `_cents`.**
 * It sits one line above `amount_cents`, which is integer cents, and that
 * adjacency is the whole hazard: Xero's `DiscountRate` holds 4 decimal places
 * and is a line's only discount channel, so CFS stores the rate at 4dp to
 * match. Quantizing it to the cent is the `@cfs/core@10.0.0-beta.117`
 * regression in a second location.
 */
function checkDiscountRate(
  d: { rate: number; type: RateType },
  ctx: z.RefinementCtx,
): void {
  if (d.type === "percent" && (d.rate < 0 || d.rate > 100)) {
    ctx.addIssue({
      code: "custom",
      path: ["rate"],
      message: `percent discount rate must be between 0 and 100, got ${d.rate}`,
    });
  }
  if (d.type === "flat" && d.rate < 0) {
    ctx.addIssue({
      code: "custom",
      path: ["rate"],
      message: `flat discount rate must not be negative, got ${d.rate}`,
    });
  }
}

/** Zod schema for an item discount. */
export const Discount: z.ZodType<DiscountType> = z.strictObject({
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum,
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
}).superRefine(checkDiscountRate);

/** Discount input — rate and type only. Amount is computed by calculateItemPrice. */
export interface DiscountInputType {
  rate: number;
  type: RateType;
}

/** Zod schema for a discount input (without computed amount). */
export const DiscountInput: z.ZodType<DiscountInputType> = z.object({
  rate: z.number(),
  type: RateTypeEnum,
}).superRefine(checkDiscountRate);

// ── Input schemas ─────────────────────────────────────────────────

/**
 * Price breakdown for an order item (input — client sends partial data, server computes the rest).
 */
export interface ItemPriceType {
  base_cents?: number;
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  subtotal_cents?: number;
  discount?: DiscountInputType | null;
  taxes?: Array<{ uid: string }>;
  total_cents?: number;
}

/** Zod schema for item price breakdown (input). */
export const ItemPrice: z.ZodType<ItemPriceType> = z.object({
  base_cents: z.int().optional(),
  base_percent: z.number().nullable().optional(),
  replacement_cents: z.int().nullable().optional(),
  chargeable_days: z.int().nullable().optional(),
  formula: PriceFormulaEnum.optional(),
  subtotal_cents: z.int().optional(),
  discount: DiscountInput.nullable().optional(),
  taxes: z.array(z.object({ uid: FirestoreId })).optional(),
  total_cents: z.int().optional(),
}).superRefine(checkPriceBaseUnit);

/**
 * A billable order line as a client sends it — the input mirror of
 * `OrderDocLineItem`.
 *
 * Deliberately permissive about what may be OMITTED: the server fills `name`,
 * `stock_method` and the whole price from the backing product doc, and a custom
 * line supplies them itself. What it is no longer permissive about is what a
 * line may CLAIM — see {@link OrderItem} for why the arms exist.
 *
 * `uid_delivery` / `uid_collection` are absent here on purpose. The flat schema
 * this replaces accepted both on any item, and `buildOrderLineItem` has never
 * propagated them to a line — prod agrees: 0 of 9,303 order line items carry
 * either key. They belong to the destination divider, which is where they now
 * live exclusively.
 */
export interface OrderItemLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: ItemPriceType;
  stock_method?: StockMethodType;
  path: string[];
  inclusion_type?: InclusionTypeType | null;
  zero_priced?: boolean | null;
  order_number?: number;
  uid_order?: string;
  /** @see `OrderDocLineItemType.taxed_as` — operator-authored, so it is accepted here. */
  taxed_as?: TaxedAsType | null;
}

// Un-annotated for `_zod.propValues` — see `_dividers.ts`. `z.object`, not
// `z.strictObject`: an input has always stripped unknown keys and tightening
// that would 400 every client that ships a stored item back verbatim (the
// manager ships `items` whole, so a line arrives carrying `crms_id`,
// `taxes_base` and computed price fields).
const OrderItemLineInner = z.object({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  // Line-item text — equipment and service wording, of a piece with a PO number
  // or a product name. Not customer data. See the note on
  // `OrderDocLineItem.description` for why this is tagged rather than left bare.
  description: z.string().meta({ pii: "none" }).optional(),
  quantity: z.int().optional(),
  price: ItemPrice.optional(),
  stock_method: StockMethodEnum.optional(),
  path: z.array(ItemUid),
  inclusion_type: InclusionTypeEnum.nullable().optional(),
  zero_priced: z.boolean().nullable().optional(),
  order_number: z.int().optional(),
  uid_order: FirestoreId.optional(),
  taxed_as: TaxedAsEnum.nullable().optional(),
}).superRefine(checkItemPriceFormula);

/** Zod schema for a billable order line (input). */
export const OrderItemLine: z.ZodType<OrderItemLineType> = OrderItemLineInner.superRefine(checkZeroPricedAmount);

/** A destination divider as a client sends it. */
export interface OrderItemDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path: string[];
}

// `z.strictObject`, unlike the line arm above — the asymmetry is the point.
// A divider's stored shape has no extra fields for a client to ship back, so
// strictness here costs nothing and turns "a divider carrying a price" into a
// 400 naming the offending key instead of a silent strip. The line arm cannot
// afford the same: a client that PUTs a stored line back verbatim brings
// `crms_id`, `taxes_base` and the computed price fields with it.
const OrderItemDestinationInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("destination"),
  // Venue label, not a person. See `DestinationDividerArm.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid),
  // `.nullable()`, not merely `.optional()` (api-cloudrun#492). The divider
  // BUILDER writes `?? null`, so the stored shape carries an explicit `null`
  // whenever the client omitted the id — and the manager drafts an invoice from
  // an order by projecting those stored dividers straight back through this
  // schema. Accepting only `undefined` therefore 400s on a payload the system
  // itself produced: `expected string, received null`, making an order created
  // through POST /orders un-invoiceable through the manager's own draft flow.
  //
  // Widening what the boundary ACCEPTS, and nothing downstream: every reader on
  // a stored divider already treats `null` and absent identically, and the
  // builder already writes `?? null`. It cannot break an older client either —
  // a widening never rejects what was previously valid.
});

/** Zod schema for a destination divider (input). */
export const OrderItemDestination: z.ZodType<OrderItemDestinationType> = OrderItemDestinationInner;

/** A group divider as a client sends it. */
export interface OrderItemGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path: string[];
}

// Strict for the same reason as the destination arm above.
const OrderItemGroupInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("group"),
  // Section header drawn from the catalog. See `GroupDividerArm.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid),
});

/** Zod schema for a group divider (input). */
export const OrderItemGroup: z.ZodType<OrderItemGroupType> = OrderItemGroupInner;

/** An individual order item (input) — a line, or one of the two dividers. */
export type OrderItemType = OrderItemLineType | OrderItemDestinationType | OrderItemGroupType;

/**
 * Zod schema for an individual order item (input) — discriminated on `type`,
 * mirroring the stored {@link OrderDocItem} union.
 *
 * This was one flat `z.object` where every field but `uid`/`type`/`path` was
 * optional, so `PUT /orders` accepted a `destination` divider carrying a
 * `quantity` and a `price`. Nothing stripped them: `buildOrderLineItem` passes a
 * divider through verbatim, so the payload reached `validateBeforeWrite` and
 * failed there as `unrecognized_keys` against the stored strict arm — a layer
 * too late, and phrased as a storage complaint rather than "a divider has no
 * price". Now it is unwritable at the boundary. Prod says nothing relied on it:
 * 0 of 3,635 order dividers carry any line-only key.
 *
 * **The line arm comes first, and the order is load-bearing.**
 * `getInitialValues` resolves a union by taking its first arm, and the manager
 * seeds a new order line with `getInitialValues(OrderItem)`. Putting a divider
 * first would silently reshape every staged line.
 *
 * Only `checkItemPriceFormula` is attached, not the full `checkItemContract`.
 * The `replacement` axis keys on `stock_method`, which an order INPUT does not
 * own — the product does, and the server reads it there — so enforcing it here
 * would reject a legal payload for an unstocked product. Storage already
 * enforces it against the resolved `stock_method`. Tighten storage, not the
 * input.
 */
export const OrderItem: z.ZodType<OrderItemType> = z.discriminatedUnion("type", [
  OrderItemLineInner,
  OrderItemDestinationInner,
  OrderItemGroupInner,
]);

/**
 * Input schema for POST /orders — what the endpoint accepts.
 */
export interface CreateOrderInputType {
  uid: string;
  organization: { uid: string };
  status: OrderStatusType;
  /**
   * **The document's only tax lever, and the only exemption channel there is**
   * — `tax_profile` left this input at api-cloudrun#596 item 2, so a create
   * says *whether this order is exempt* and nothing else.
   *
   * ⚠️ **Sticky from either side**: the rule is
   * `org.tax_exempt || doc.tax_exempt === true`, never `doc ?? org`. So `false`
   * and absent mean the same thing here — *"this document asserts no
   * exemption"* — and neither un-exempts an exempt customer.
   *
   * The JURISDICTION half is not a document-wide field at all: it lives on
   * `destinations[i].jurisdiction`, because an order can deliver to two
   * jurisdictions at once and one enum slot could never say so.
   */
  tax_exempt?: boolean;
  /**
   * Which store this order sells FROM — the ORIGIN half of the tax rule, and
   * the other axis this input states. `null`/absent means the `default: true`
   * store, so no existing caller changes meaning.
   *
   * ⚠️ Present on the UPDATE input too, deliberately. Create-only would make
   * the value unchangeable after the first write — the same half-built override
   * api-cloudrun#630 is about.
   *
   * ⚠️ **Not `booking.uid_store`** — see {@link Order.uid_store}.
   */
  uid_store?: string | null;
  destinations: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
}

/** Input schema for creating an order. */
export const CreateOrderInput: z.ZodType<CreateOrderInputType> = z.object({
  uid: FirestoreId,
  organization: z.object({ uid: FirestoreId }),
  status: OrderStatus,
  tax_exempt: z.boolean().optional(),
  uid_store: FirestoreId.nullable().optional(),
  destinations: z.array(Destination).min(1, "At least one destination is required"),
  items: z.array(OrderItem)
    .refine(
      (items) => items.length === 0 || items[0].type === "destination",
      { message: "First item must be a destination divider" },
    )
    .optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
});

/**
 * Input schema for PUT /orders/:uid — partial update.
 */
export interface UpdateOrderInputType {
  uid?: string;
  organization?: { uid: string };
  status?: OrderStatusType;
  /**
   * Absent = leave unchanged; `false` = this order asserts no exemption.
   *
   * ⚠️ **`null` is deliberately NOT accepted.** Exemption is sticky, so `false`
   * and absent already mean the same thing, and admitting `null` would invite a
   * caller to believe it un-set something. The retired `tax_profile` did need a
   * `null` arm, because "inherit" and "explicitly ordinary" were different
   * statements it had to spell with the same field — which is one of the
   * reasons it is gone.
   */
  tax_exempt?: boolean;
  /**
   * The ORIGIN axis. Absent = leave unchanged; `null` = fall back to the
   * `default: true` store. See {@link CreateOrderInputType.uid_store}.
   *
   * ⚠️ Unlike `tax_exempt` beside it, `null` IS accepted and IS distinct from
   * absent — origin is not sticky, so "use the default store" is a real answer
   * an operator can set back.
   */
  uid_store?: string | null;
  destinations?: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
  version: number;
}

/** Input schema for updating an order. */
export const UpdateOrderInput: z.ZodType<UpdateOrderInputType> = z.object({
  uid: FirestoreId.optional(),
  organization: z.object({ uid: FirestoreId }).optional(),
  status: OrderStatus.optional(),
  tax_exempt: z.boolean().optional(),
  uid_store: FirestoreId.nullable().optional(),
  destinations: z.array(Destination).min(1, "At least one destination is required").optional(),
  items: z.array(OrderItem)
    .refine(
      (items) => items.length === 0 || items[0].type === "destination",
      { message: "First item must be a destination divider" },
    )
    .optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
  version: z.int().min(0),
});

// ── Full document schemas ────────────────────────────────────────

/**
 * Line item price in the full order document (all fields required after server compute).
 * subtotal = pre-discount (base × qty × days_factor).
 * subtotal_discounted = post-discount.
 * total = subtotal_discounted + sum(taxes[].amount).
 */
export interface OrderDocItemPriceType {
  base_cents: number;
  /**
   * The `percent_of_total` percentage, at 4dp — present on exactly the lines
   * where `base_cents` is meaningless, and absent everywhere else. See
   * {@link checkPriceBaseUnit}, which enforces the biconditional.
   */
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  /**
   * **The tax this line would carry if the customer were not exempt.**
   *
   * ⚠️ It used to be the *product's* intrinsic tax, written once at line-build
   * time so that reverting a `tax_profile` override could restore `taxes` from
   * it. With the jurisdiction rule there is nothing to revert TO — the rule is
   * total and re-derived on every write — so `assignLineTaxes` is now the ONE
   * author of both fields and they cannot drift. What the field buys is that an
   * exempt document still records which tax it was exempt FROM.
   *
   * Optional: absent on documents written before the field existed.
   */
  taxes_base?: TaxRefType[];
  total_cents: number;
}

export const OrderDocItemPrice: z.ZodType<OrderDocItemPriceType> = z.strictObject({
  base_cents: z.int().meta({ column: true, label: "Base Price" }),
  base_percent: z.number().nullable().optional(),
  // `.nullable().optional()` and NOT defaulted: a null replacement means "this
  // line has no replacement value", which is not the fact `0` states, and
  // `checkItemContract`'s `forbidden` arm reads the difference.
  replacement_cents: z.int().nullable().optional().meta({ column: true, label: "Replacement" }),
  chargeable_days: z.number().int().nullable().meta({ column: true, label: "Chargeable Days" }),
  formula: PriceFormulaEnum.meta({ column: true, label: "Formula" }),
  subtotal_cents: z.int().meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().meta({ column: true, label: "Discounted Subtotal" }),
  discount: Discount.nullable().meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax" }),
  // Labelled although nothing here is a column in its own right: `TaxRef`'s
  // `name` and `rate` ARE columns (the product catalog offers them), so every
  // key holding a `TaxRef` inherits two columns and needs to name them. Without
  // this the pre-override snapshot would collide with the live `taxes`.
  taxes_base: z.array(TaxRef).optional().meta({ label: "Base Tax" }),
  total_cents: z.int().meta({ column: true, label: "Total" }),
}).superRefine(checkPriceBaseUnit);

/**
 * Line item in the full order document.
 *
 * `price` and `stock_method` are REQUIRED, and that is a statement about the
 * writers rather than a convenience: every one of the 9,303 line items in prod
 * (and in dev) carries both, because `buildOrderLineItem` resolves them off the
 * backing product doc — or off the `custom-` line's own payload — before it can
 * build anything at all. While they were optional, three call sites downstream
 * had to compensate for a shape no writer has ever produced: two `item.price!`
 * assertions, and a `"stock_method" in item` duck-type that answered "not a line
 * item" for a line item that merely omitted the field.
 *
 * `uid_delivery` / `uid_collection` are absent, matching the input arm. They
 * belong to the destination divider — 0 of 9,303 stored lines carry either key,
 * no writer has ever set one on a line, and both readers in
 * `@cfs/core/utils/orders` gate on `type === "destination"` before looking. The
 * FULFILLMENT line arm keeps its own pair: 9,304 prod rows carry an explicit
 * `null` there, so removing it would be a backfill, not a tightening.
 */
export interface OrderDocLineItemType {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: OrderDocItemPriceType;
  stock_method: StockMethodType;
  order_number?: number;
  uid_order?: string;
  path: string[];
  inclusion_type?: "default" | "mandatory" | "optional" | null;
  zero_priced?: boolean | null;
  crms_id?: number | null;
  /**
   * Revenue chart-of-accounts code, denormalized from the product at write time
   * — **where the line's income posts in Xero**.
   *
   * ⚠️ It decided taxability until 2026-08-20 (`isTaxableCoa` in
   * `@cfs/core/utils/orders`, now retired); everything below is the history of
   * that gate, kept because it is what the field was added for.
   *
   * **Absent on every line written before `10.0.0-beta.120`** — which is
   * api-cloudrun#421 tail 3, and the reason this field exists. `isTaxableCoa`
   * treats an absent COA as *taxable* (unknown means unknown, and the engine may
   * only remove tax from a line it can positively identify), so while an order
   * line carried no COA the gate was **inert for the entire order corpus**: CFS
   * taxed delivery, labour and pass-through lines on the order while the Xero
   * quote push (which resolves from the product) sent `TaxType: NONE` and the
   * resulting invoice (which stores a product-resolved COA) charged nothing.
   * Measured on prod 2026-08-03: 16 lines / 9 orders / $453.50 of tax an invoice
   * would not carry. Order #563 and its invoice #1978 disagreed by exactly the
   * $67.50 that invoice's own repair had already stripped.
   *
   * **Server-resolved, never client-supplied** — deliberately absent from the
   * INPUT schema (`OrderItemLineInner`). api-cloudrun#409's landing fix was
   * precisely that `coa_revenue` must be resolved from the product rather than
   * trusted from the payload; the manager ships `items` back whole, so a
   * client-sent value would round-trip a stale COA into the taxability decision.
   * The input schema is non-strict, so an incoming value is stripped and the
   * server re-derives it.
   */
  coa_revenue?: COARevenueType | null;
  /**
   * Per-line override of the item TYPE the tax engine keys on. Absent/`null`
   * means *use `type`*; `"none"` means *this line is untaxed* regardless of
   * what its type would attract.
   *
   * ⚠️ **It overrides the TYPE, never the tax.** There is deliberately no
   * per-line tax reference — a line naming its own tax uid is a second copy of
   * the catalog, free to drift from the jurisdiction rule, which is the
   * api-cloudrun#409 class ($2,741.78 of phantom receivable) in miniature.
   *
   * ⚠️ **`.optional()`, never `.default(null)`** — ~9,300 existing prod lines
   * are genuinely absent, and `validateBeforeWrite` persists the RAW doc, so a
   * `.default()` would never materialize while the published type promised one.
   *
   * ⚠️ **A CRMS rebuild must CARRY THIS FORWARD from the stored row.**
   * `createUpdateInvoiceFromCrms` and the opportunity webhook rebuild `items`
   * from scratch on every event, so a CFS-authored line fact that is not
   * re-read is destroyed — the same shape as api-cloudrun#480's uid churn.
   */
  taxed_as?: TaxedAsType | null;
}

// Un-annotated so `_zod.propValues` survives for `z.discriminatedUnion` below;
// the annotated public alias is exported immediately after. `z.enum(...)` is
// inlined rather than reusing `DocLineItemTypeEnum` for the same reason — the
// shared const carries a `z.ZodType<…>` annotation that erases the literals.
// See `_dividers.ts` for the full rationale.
const OrderDocLineItemInner = z.strictObject({
  // 🔴 **SPREAD, not per key** — `uid`, `name`, `description`, `quantity`, `path`
  // and `zero_priced` are the six fields all three grains share, one instance
  // each, from `_items.ts`. The spread puts them in one canonical order at the
  // head of every grain, which is the point: it is what makes a grain that
  // OMITS one a compile error rather than something only a test can see.
  // `tests/item-shape-parity.test.ts` still holds the SHADOWING case, which no
  // spread can catch.
  type: z.enum(DOC_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...LineItemCore,
  price: OrderDocItemPrice,
  // Required for every line type, `transaction_fee` included — a fee holds no
  // stock, which `"none"` says exactly (1,533 prod lines already use it). That
  // keeps the fee an ordinary line item, which is the whole point of W1's
  // collapse of the separate fee arm, rather than earning it a contract axis.
  stock_method: StockMethodEnum.meta({ column: true, label: "Stock Method" }),
  order_number: z.int().optional().meta({ column: true, label: "Order #" }),
  uid_order: FirestoreId.optional(),
  inclusion_type: z.enum(INCLUSION_TYPES_NULLABLE).nullable().optional().meta({ column: true, label: "Inclusion" }),
  crms_id: z.int().nullable().optional(),
  // Denormalized from the product at write time — see the interface docblock for
  // why this is on the DOC line and not the input one. `.optional()` rather than
  // defaulted: `validateBeforeWrite` persists the RAW doc, so a `.default()`
  // never materializes, and every line written before beta.120 is genuinely
  // absent rather than null.
  coa_revenue: COARevenueEnum.nullable().optional(),
  // Operator-authored, unlike `coa_revenue` beside it — so it IS on the input
  // schema. See the interface docblock for why it is optional rather than
  // defaulted, and why a CRMS rebuild has to carry it forward.
  taxed_as: TaxedAsEnum.nullable().optional().meta({ column: true, label: "Taxed As" }),
}).superRefine(checkItemContract).superRefine(checkZeroPricedAmount);

export const OrderDocLineItem: z.ZodType<OrderDocLineItemType> = OrderDocLineItemInner;

/** Destination divider item in the order document items array. */
export interface OrderDocDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  description: string;
}

/** Destination divider in items array. */
export const OrderDocDestinationItem: z.ZodType<OrderDocDestinationItemType> = DestinationDividerArm;

/** Group divider in items array. */
export interface OrderDocGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

export const OrderDocGroupItem: z.ZodType<OrderDocGroupItemType> = GroupDividerArm;

/**
 * Union of all item types in the document — discriminated on `type`.
 *
 * There is exactly ONE claimant per discriminator value, which is what makes
 * the discrimination possible at all. `transaction_fee` used to be claimed
 * twice — once by `DOC_LINE_ITEM_TYPES` here and once by a separate
 * `OrderDocTransactionFeeItem` arm carrying a `PriceModifier` instead of an
 * `OrderDocItemPrice` — and Zod answers a duplicate discriminator with a bare
 * `Error`, not a `ZodError`, so `safeParse` could not trap it. A fee is now an
 * ordinary line item whose `price.formula` says `percent_of_total`; the
 * per-document rollup (`totals.transaction_fees`) keeps the `PriceModifier`
 * shape, because that IS a rate-and-amount summary rather than a line.
 */
export const OrderDocItem: z.ZodType<OrderDocItemType> = z.discriminatedUnion("type", [
  OrderDocLineItemInner,
  DestinationDividerArm,
  GroupDividerArm,
]);

/** Union of all item types stored in the order document. */
export type OrderDocItemType = OrderDocLineItemType | OrderDocDestinationItemType | OrderDocGroupItemType;

/**
 * Type guard that narrows an order doc item to a line item (excludes
 * destination/group dividers). Sound: every non-divider `type` is now backed by
 * exactly one shape, so the narrowing cannot hand a caller a `price` of the
 * wrong kind.
 */
export function isLineItem(item: OrderDocItemType): item is OrderDocLineItemType {
  return isLineItemType(item.type);
}

/**
 * Narrows an order doc item to one that can be PICKED — the `fulfillable` axis,
 * which additionally excludes `transaction_fee`.
 *
 * Lives beside {@link isLineItem} because the two are constantly confused: a fee
 * is a line (it is billed) and is not fulfillable (there is nothing on a shelf).
 * `isFulfillableItemType` alone cannot do this job — a type predicate on
 * `item.type` narrows the property, not the union — which is why both
 * `services/fulfillment.ts` and `services/fulfillmentEdits.ts` had grown their
 * own item-level copy.
 *
 * The narrowing is deliberately imprecise in the same way `isLineItem` is: it
 * reports `OrderDocLineItemType`, whose `type` still nominally includes
 * `transaction_fee`. Every field a caller reads after this guard is shared
 * across all line types, so the imprecision costs nothing.
 */
export function isFulfillableItem(item: OrderDocItemType): item is OrderDocLineItemType {
  return isFulfillableItemType(item.type);
}

/**
 * Denormalized organization snapshot on the order document.
 *
 * Was a hand-maintained literal one field short of the invoice's — no
 * `tax_profile`, which is the whole of api-cloudrun#486. Now the shared
 * {@link DocumentOrganizationSnapshot}; see its docstring for the union taken
 * on the two fields the three copies disagreed about.
 */
const OrderDocOrganization = DocumentOrganizationSnapshot;

/** Order totals. */
/**
 * The six totals fields an order and an invoice declare identically.
 *
 * ⭐ **Referenced PER KEY, not spread — and unlike `DestinationPairCore` above,
 * that was forced.** The shared fields are contiguous in both grains, but their
 * internal order differs: `discount_amount_cents` is FIRST on the order and
 * THIRD on the invoice. A schema's key order is its Firestore-surface column
 * order (`getFirestoreColumns` walks the shape), so `{ ...TotalsCore, … }` would
 * move that column on whichever grain did not supply the ordering — an
 * operator-visible change wearing a refactor's clothes. Same answer as the line
 * item in `_items.ts`, same reason, and the opposite answer to the destination
 * pair. **Contiguity is not the test; agreement on ORDER is.**
 *
 * 🔴 **So the anti-drift guarantee lives in `tests/totals-parity.test.ts`, not in
 * the syntax.** A per-key reference cannot stop a grain re-declaring a field
 * inline any more than a spread can stop one shadowing it; only instance
 * identity (`shape[k] === TotalsCore[k]`) sees either. Structural equality would
 * NOT do — `z.globalRegistry` is keyed on the instance, so a separately-declared
 * twin carries none of these `.meta()` annotations and every heading below would
 * silently vanish from the tables.
 *
 * ⚠️ **`replacement_total_cents` being order-only is correct, not a gap.** An
 * invoice price has no `replacement_cents`, so an invoice structurally cannot
 * compute one. Written down because it reads like an omission.
 *
 * ⚠️ **Not on the `@cfs/core/schemas` barrel**, for the same reason as
 * `DestinationPairCore`: no consumer assembles a totals object from parts, and
 * publishing the parts publishes a second way to spell one.
 */
export const TotalsCore: {
  discount_amount_cents: z.ZodType<number>;
  subtotal_cents: z.ZodType<number>;
  subtotal_discounted_cents: z.ZodType<number>;
  taxes: z.ZodType<PriceModifierType[]>;
  transaction_fees: z.ZodType<PriceModifierType[]>;
  total_cents: z.ZodType<number>;
} = {
  discount_amount_cents: z.int().meta({ column: true, label: "Discount" }),
  subtotal_cents: z.int().meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().meta({ column: true, label: "Discounted Subtotal" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax" }),
  transaction_fees: z.array(PriceModifier).meta({ label: "Transaction Fee" }),
  total_cents: z.int().meta({ column: true, label: "Total" }),
};

export interface OrderDocTotalsType {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  replacement_total_cents: number;
}

// Key order is this grain's own and is preserved exactly — see `TotalsCore`.
const OrderDocTotals: z.ZodType<OrderDocTotalsType> = z.strictObject({
  discount_amount_cents: TotalsCore.discount_amount_cents,
  subtotal_cents: TotalsCore.subtotal_cents,
  subtotal_discounted_cents: TotalsCore.subtotal_discounted_cents,
  taxes: TotalsCore.taxes,
  transaction_fees: TotalsCore.transaction_fees,
  total_cents: TotalsCore.total_cents,
  // Order-only, and correctly so: an invoice price has no `replacement_cents`.
  replacement_total_cents: z.int().meta({ column: true, label: "Replacement Total" }),
});

/**
 * Full order document schema (Firestore document shape).
 * Used for validation before writing to Firestore.
 */
export interface Order {
  uid: string;
  number: number;
  status: OrderStatusType;
  organization: DocumentOrganizationSnapshotType;
  destinations: DocDestinationType[];
  items: OrderDocItemType[];
  // `tax_profile` was DELETED from this interface (#596). Its docblock
  // outlived it here until 2026-08-22, describing a `getEffectiveProfileTax`
  // precedence scan for a field with nothing beneath it.
  /**
   * This order's exemption, or `null` to inherit the organization's.
   *
   * ⚠️ **Exemption is STICKY**: the rule is `org.tax_exempt || doc.tax_exempt
   * === true`, never `doc ?? org`. A `false` here must not un-exempt an exempt
   * customer — that is a legal fact about the buyer, not a per-order choice.
   * Which is why the type is `boolean | null` and not `boolean`: `null` is
   * "inherit", `true` is "exempt this document too", and `false` is "this
   * document asserts nothing", NOT "tax this exempt customer".
   *
   * Splitting this out of `tax_profile` is what lets an exempt customer still
   * carry a jurisdiction — the welded enum gives a document exactly one of the
   * two facts.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  tax_exempt?: boolean | null;
  /**
   * Which store this order sells FROM — the origin for Illinois origin
   * sourcing. `null`/absent means the `default: true` store.
   *
   * ⚠️ **Not `booking.uid_store`**, which is per-line and records which store's
   * stock filled that line (`storeAllocation`). Origin sourcing is a property
   * of the DOCUMENT, and the two answer different questions.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  uid_store?: string | null;
  totals: OrderDocTotalsType;
  invoices: Array<{ uid: string; number: number; status: InvoiceStatusType }>;
  query_by_invoices: string[];
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  /**
   * Roll-up of breakdown across all bookings on this order. Mirrors the keys
   * of `booking.breakdown` but
   * aggregated along the order axis. Maintained incrementally by booking
   * writes (createOrder seeds it; updateBooking applies a delta).
   *
   * Invariant: sum of all values === sum of `booking.quantity` across the
   * order's bookings. The order is considered complete when
   * `quoted + reserved + prepped + out === 0` (every quantity has reached
   * a terminal state: returned, lost, or damaged).
   */
  bookings_breakdown: {
    quoted: number;
    reserved: number;
    prepped: number;
    out: number;
    returned: number;
    lost: number;
    damaged: number;
  };
  /**
    * The CRMS opportunity id, or `null` for an order CFS created itself.
    *
    * Required and NULLABLE, which is the whole distinction: `null` is a real
    * answer ("no CRMS twin") and absence was not. `createOrder`
    * (`api-cloudrun/src/services/orders.ts`) writes an explicit `null`, and
    * every one of **995 prod and 995 dev orders carries the key** (measured
    * 2026-08-23 by `orderBy(field)` key-presence — see CLAUDE.md § "Is a field
    * dead?" — with 0 nulls, because the whole live corpus is CRMS-authored).
    *
    * ⚠️ Contrast {@link crms_status} directly below, which is 995/995 for the
    * same reason and is NOT required, because the reason differs.
    */
  crms_id: number | null;
  /**
   * ⚠️ **995 of 995 in both environments, and it must stay optional.** That
   * number is a fact about the GENERATOR, not about the document: the only
   * writer in the repo is the CRMS opportunity webhook
   * (`api-cloudrun/src/services/webhooks/opportunity.ts`, since deleted), and `createOrder`
   * sets it nowhere. Every stored order carries it because every stored order
   * came from CRMS — a natively created one has no key at all, so requiring it
   * would 400 the native create path the first time it ran.
   *
   * Same shape as `cards.destination`/`organization`: a machine-generated
   * corpus proves what the generator does, never what the document permits.
   * And CRMS is being retired, so the native path is the future one.
   */
  crms_status?: string;
  /**
   * Required, non-nullable, and the SAME declaration as `Invoice.subject` and
   * `Fulfillment.subject` — `""` is "no subject" at all three grains
   * (core#97 increment 3, 2026-09-09).
   *
   * ⚠️ **The `?` and the `.default("")` went together, and both were wrong for
   * the same reason.** A `.default()` is inert on a write —
   * `validateBeforeWrite` discards `result.data` — so its only effect here was
   * to widen the accepted set to include an ABSENT key, which is the state that
   * yields `undefined` from `docData<T>`. Every stored order already carries
   * it: **1,020 of 1,020 in prod and dev, 0 absent, 0 null** (2026-09-09), and
   * `createOrder` writes a literal `subject: ""` while `updateOrder` only ever
   * assigns a string. Nothing produced the absence the declaration allowed.
   *
   * ⚠️ `getInitialValues` is unaffected — its `case "string"` already returns
   * `""`, which is the value the dropped `.default()` named. Verified as a
   * byte-identical dump of all three document schemas' seeds.
   *
   * `UpdateOrderInputType.subject` stays `.optional()`: a CLIENT may omit it.
   * Normalize at the writer, require at storage.
   */
  subject: string;
  reference?: string | null;
  xero_id?: string | null;
  /**
   * Required. Every order is born with a default thread — `createOrder` stamps
   * `orderThreadDoc.uid` in the same transaction that writes the order — and
   * **995 of 995 in prod and dev carry the key** (2026-08-23, `orderBy`
   * key-presence). The `?` described a document no writer can produce.
   */
  uid_thread: string;
  version: number;
  /**
   * Who created this order — optional, and paired with an `updated_by` twin
   * declared below.
   *
   * ⚠️ **This docstring used to say the twin was "deliberately absent", citing
   * api-cloudrun#407, and it stayed saying so after the field shipped on
   * 2026-09-04.** It is the paragraph a reader hits FIRST, ~130 lines above the
   * field it denied the existence of, so it read as current intent while being
   * flatly contradicted by the schema — the "a stale plan reads as current
   * intent" failure, one level down in a docstring.
   *
   * The original ruling was sound while it held: `orders` was the most
   * machine-written collection in the system (holiday recompute, the draft
   * fan-out, calendar, Trello, the Xero and CRMS sweeps), corpus-wide
   * **15,885 of 16,046 prod ActorRefs already named a bot**, and a second field
   * reading "Cloud Task Worker" on almost every order is worse than no field.
   * **CRMS being switched off expired that reasoning** — see `updated_by`'s own
   * docstring below for the measurement that retired it.
   *
   * Optional because it is **not backfilled**. Every historical order is
   * CRMS-authored, so a backfill could only write `crms-bot`, i.e. the field
   * would ship saying "we don't know" on 100% of the corpus. Absent means
   * absent — the `pdf_versions` precedent.
   *
   * ⚠️ **The `null` arm is load-bearing, not decoration.** `getInitialValues`
   * recurses INTO an `optional` rather than skipping it, so a bare
   * `ActorRef.optional()` seeds `{uid: "", name: ""}` — which strict `ActorRef`
   * then rejects (`min(1)` on both). That seed is not a test detail: manager
   * builds its order draft from `getInitialValues(OrderSchema)`
   * (`src/stores/orders.ts`), and api's invoice and credit-note suites spread it
   * into orders they WRITE. `nullable` makes `resolveField` yield `null`, which
   * every one of them can store. `comment.ts`'s `deleted_by` is the precedent
   * for a nullable ActorRef.
   */
  created_by?: ActorRefType | null;
  /**
   * Who last changed this order — **optional and nullable for exactly the same
   * reasons as `created_by` above, and added 2026-09-04 because the reason it
   * was absent expired.**
   *
   * The original ruling (api-cloudrun#407) was that a field reading
   * "Cloud Task Worker" on almost every order is worse than no field, and it
   * was right while CRMS authored the corpus. **CRMS is switched off**: the
   * last order-rebuilding `opportunity` webhook reached prod on
   * 2026-09-03 20:00 UTC and the last CRMS webhook of any kind on
   * 2026-09-04 15:00 UTC, against ~48 opportunity/day before that. Orders are
   * operator-authored from here, and the ~47 human `PUT /orders/{uid}` a week
   * that were already happening had nowhere to record who made them.
   *
   * ⚠️ **Not backfilled, and it must not be.** Every historical order is
   * CRMS-authored, so a backfill could only write `crms-bot` — the field would
   * ship saying "we don't know" on the whole corpus, which is the exact defect
   * `created_by` avoids. Absent means absent.
   *
   * ⚠️ **The `null` arm is load-bearing** — same trap as `created_by`:
   * `getInitialValues` recurses INTO an `optional`, so a bare
   * `ActorRef.optional()` seeds `{uid: "", name: ""}` and strict `ActorRef`
   * (`min(1)` on both) then rejects it.
   *
   * ⚠️ **Adding the KEY is not the free half of expand/migrate/contract.**
   * `OrderSchema` is a `z.strictObject`, so a build that does not declare this
   * field REFUSES any document carrying it. Nothing writes it yet, which is
   * what makes this schema change safe on its own — **the first writer may only
   * land once the manager is deployed on a core that declares it**
   * (api-cloudrun#782 is the same class, measured at 9,214 documents).
   */
  updated_by?: ActorRefType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for the full order Firestore document. */
export const OrderSchema: z.ZodType<Order> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "orderDetail" }),
  status: OrderStatus.meta({ column: true, label: "Status" }),
  organization: OrderDocOrganization.meta({ label: "Organization" }),
  destinations: z.array(DocDestination).min(1),
  // "Item" prefixes every column under here, which is what keeps
  // `items.price.taxes.rate` ("Item Tax Rate") distinct from the order-level
  // `totals.taxes.rate` ("Tax Rate") — the same field shape at two depths.
  items: z.array(OrderDocItem).default([]).meta({ label: "Item" })
    .superRefine(checkZeroPricedComponents),
  // Present but NULLABLE, not optional — `null` is a value meaning "inherit the
  // organization's profile", so it has to be stored rather than absent. Still
  // no `.default()`: one never materializes on a write (see the note in
  // `product.ts`), and the Typesense config declares the field required.
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  // ⚠️ **Nullable AND optional, where the ORGANIZATION's twin is a plain
  // optional boolean — and the asymmetry is deliberate.** On a document `null`
  // is the meaningful "asserts nothing, inherit the customer's" value, and
  // `undefined` is every order written before #409 Phase 1. A customer has no
  // one to inherit from, so its axis needs no third state.
  //
  // This is why `getInitialValues` seeds `null` here and `false` there, and why
  // the fold is `org.tax_exempt || doc.tax_exempt === true` rather than
  // `doc ?? org`: a `false` on the document must not un-exempt an exempt
  // customer.
  tax_exempt: z.boolean().nullable().optional().meta({ column: true, label: "Tax Exempt" }),
  // No `column: true` — `display-columns.test.ts` bans a heading ending in "Uid".
  // 0 of 995 prod orders carry the KEY (2026-08-23) — expected mid-migration,
  // not dead. `null`/absent already means the default store, and
  // `api-cloudrun/src/lib/locationIntegrity.ts` reasons about exactly that.
  uid_store: FirestoreId.nullable().optional(),
  totals: OrderDocTotals,
  invoices: z.array(z.strictObject({
    uid: FirestoreId,
    number: z.int().meta({ column: true, label: "#" }),
    status: InvoiceStatusEnum.meta({ column: true, label: "Status" }),
  })).default([]).meta({ label: "Invoice" }),
  query_by_invoices: z.array(z.string()).default([]),
  query_by_items: z.array(z.string()),
  query_by_contacts: z.array(z.string()),
  query_by_dates: z.array(z.string()),
  bookings_breakdown: z.strictObject({
    quoted: z.number(),
    reserved: z.number(),
    prepped: z.number(),
    out: z.number(),
    returned: z.number(),
    lost: z.number(),
    damaged: z.number(),
  }),
  crms_id: z.int().nullable(),
  // NOT tightened — see the interface. 995/995 is a fact about the CRMS
  // webhook, the only writer; `createOrder` stamps no `crms_status` at all.
  crms_status: z.string().optional(),
  // 🔴 **`mask`, reversing core#35 — on a MEASUREMENT, not a re-reading.** That
  // issue weighed `subject` as a dictionary candidate and ruled the order /
  // invoice / booking / fulfillment ones business labels, which they mostly are.
  // Measured 2026-09-05 against prod: **8 of 100 consecutive orders carry a
  // literal street address here** (an origin-to-destination pair typed by an
  // operator). Both things are true at once — it IS a label and operators DO
  // type shoot addresses into it — so this is a judgement about acceptable
  // exposure rather than a defect with a correct answer, and the owner made it.
  //
  // ⚠️ Same shape as `DestinationDividerArm.name` one file over: a field whose
  // NAME is innocuous and whose CONTENTS sometimes are not. The dictionary asks
  // what a field is called; the hazard is what it holds.
  //
  // ⚠️ Known give-back, deliberately accepted: `fixturePiiStrategy.fakeForMask`
  // shape-detects 2-3 alphabetic tokens as a person, so a subject like
  // `3100 W Fillmore St` will be faked as a person's name until that detection
  // is fixed (api-cloudrun#778 is open on exactly that machinery). A
  // plausible-but-wrong fake reads as sanitized, which is why this is written
  // down rather than left to be rediscovered.
  //
  // Bare `z.string()` — the dropped `.default("")` is core#97 increment 3; the
  // interface above carries the census and the reason.
  subject: z.string().meta({ pii: "mask", column: true, label: "Subject", linkTo: "orderDetail" }),
  reference: z.string().max(255).nullable().default(null).meta({ column: true, label: "Reference", linkTo: "orderDetail" }),
  xero_id: z.uuid().nullable().default(null),
  uid_thread: ThreadId,
  version: z.int().min(0).default(0),
  // Both actor fields — see the interface for why each is optional rather than
  // backfilled, and why `updated_by` arrived only once CRMS was switched off.
  // They put `orders` into the user-rename cascade, which is safe ONLY because
  // api-cloudrun's `ORDER_FANOUT_EXCLUDED_FIELDS` already refuses both names —
  // and it listed `updated_by` before this field existed, precisely so adding it
  // would be a schema change rather than a schema change plus a guard nobody
  // remembers to write. `api-cloudrun/tests/unit/actorRefPaths.test.ts` asserts
  // every order ActorRef path appears in that set, so the two cannot drift.
  created_by: ActorRef.nullable().optional().meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.nullable().optional().meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Order",
  collection: "orders",
  displayDefaults: {
    columns: ["number", "organization.path", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<Order>;

// ── Shared utility types ─────────────────────────────────────────

/**
 * A consolidated line item — aggregated quantity and price for display.
 * Used by consolidateItems() in utilities and the manager app.
 */
/**
 * One (product) row of an order's lines, consolidated across every line naming
 * that product. The seed a `bookings` document is built from.
 *
 * 🔴 **It carries NO MONEY, and that is the point of api-cloudrun#922.** It used
 * to emit `total_price_cents` and a lossy `unit_price_cents` denorm beside it,
 * which is what put money on `bookings` at all. Owner ruling 2026-09-07: those
 * fields come off the collection. Removing them from HERE is what stops the
 * writer, and the compiler is what finds every site that was consuming them.
 */
export interface ConsolidatedItemType {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  stock_method: string;
}

/**
 * Path context for an item — which destination and group it belongs to.
 * Used by getGroupPath() in utilities and consumed by the manager app.
 */
export interface GroupPathType {
  destination: string | null;
  group: string | null;
  product: string | null;
}
