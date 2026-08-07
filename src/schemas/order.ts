/**
 * Order schemas — Firestore collection: orders
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import {
  Address,
  type AddressType,
  checkItemContract,
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
  type NameParts,
  NamePartsFields,
  Phone,
  PriceFormulaEnum,
  type PriceFormulaType,
  RateTypeEnum,
  type RateType,
  StockMethodEnum,
  type StockMethodType,
  TaxProfileEnum,
  type InvoiceStatusType,
  InvoiceStatusEnum,
  type TaxProfileType,
  NameField,
  TimestampFields,
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

/** Zod schema for order dates with Firestore timestamp companions. */
export const OrderDocDates: z.ZodType<OrderDocDatesType> = z.strictObject({
  delivery_start: chicagoInstant().nullable().default(null),
  delivery_start_fs: FirestoreTimestamp.nullable().default(null),
  delivery_end: chicagoInstant().nullable().default(null),
  delivery_end_fs: FirestoreTimestamp.nullable().default(null),
  collection_start: chicagoInstant().nullable().default(null),
  collection_start_fs: FirestoreTimestamp.nullable().default(null),
  collection_end: chicagoInstant().nullable().default(null),
  collection_end_fs: FirestoreTimestamp.nullable().default(null),
  charge_start: chicagoInstant().nullable().default(null),
  charge_start_fs: FirestoreTimestamp.nullable().default(null),
  charge_end: chicagoInstant().nullable().default(null),
  charge_end_fs: FirestoreTimestamp.nullable().default(null),
  days_active: z.int().nullable().default(null),
  days_charged: z.int().nullable().default(null),
});

/**
 * Contact reference embedded in a destination endpoint.
 * When present (not null), uid and first_name are required. `name` is the
 * server-derived display string (see `deriveName` in common.ts) — populated
 * by api-cloudrun on every write so consumers don't re-derive client-side.
 */
export interface DestinationContactType extends NameParts {
  uid: string;
  name: string;
  phones?: string[];
}

/** Zod schema for destination contact reference. */
export const DestinationContact: z.ZodType<DestinationContactType> = z.object({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
  phones: z.array(Phone).optional(),
});

/**
 * Contact reference in a destination endpoint (document schema — uid & first_name required).
 */
export interface DocDestinationContactType extends NameParts {
  uid: string;
  name: string;
  phones?: string[];
}

/** Zod schema for destination contact reference (document version). */
export const DocDestinationContact: z.ZodType<DocDestinationContactType> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
  phones: z.array(Phone).default([]),
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
  instructions: z.string().meta({ pii: "mask" }).nullable(),
  contact: DocDestinationContact.nullable(),
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
  dates: OrderDatesType;
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
}

/** Zod schema for a destination pair. */
export const Destination: z.ZodType<DestinationType> = z.object({
  dates: OrderDates,
  delivery: DestinationEndpoint,
  collection: DestinationEndpoint,
  customer_collecting: z.boolean().optional(),
  customer_returning: z.boolean().optional(),
});

/**
 * Document-level destination pair. See `DestinationType` for flag semantics.
 */
export interface DocDestinationType {
  dates: OrderDocDatesType;
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting: boolean;
  customer_returning: boolean;
}

/** Zod schema for a document-level destination pair. */
export const DocDestination: z.ZodType<DocDestinationType> = z.strictObject({
  dates: OrderDocDates,
  delivery: DocDestinationEndpoint,
  collection: DocDestinationEndpoint,
  customer_collecting: z.boolean().default(false),
  customer_returning: z.boolean().default(false),
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
  name: z.string().meta({ pii: "none" }),
  rate: z.number(),
  type: RateTypeEnum,
  amount_cents: z.int(),
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
  name: z.string().meta({ pii: "none" }),
  rate: z.number(),
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
  rate: z.number(),
  type: RateTypeEnum,
  amount_cents: z.int().min(0),
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
  order_number: z.number().optional(),
  uid_order: FirestoreId.optional(),
}).superRefine(checkItemPriceFormula);

/** Zod schema for a billable order line (input). */
export const OrderItemLine: z.ZodType<OrderItemLineType> = OrderItemLineInner;

/** A destination divider as a client sends it. */
export interface OrderItemDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path: string[];
  uid_delivery?: string;
  uid_collection?: string;
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
  uid_delivery: FirestoreId.optional(),
  uid_collection: FirestoreId.optional(),
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
  tax_profile: TaxProfileType;
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
  tax_profile: TaxProfileEnum,
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
  tax_profile?: TaxProfileType;
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
  tax_profile: TaxProfileEnum.optional(),
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
   * Intrinsic (pre-override) tax snapshot — the tax this item would carry under
   * `tax_applied` (product default, or the tax a custom/CRMS item was created
   * with). Set once at item-build time and never touched by the doc-level
   * `tax_profile` override (which only rewrites `taxes`), so a `tax_profile`-only
   * revert can restore `taxes` from it losslessly — for product AND custom
   * items, with zero reads. Optional: absent on pre-`taxes_base` docs (the
   * revert path falls back to a batched product read for those).
   */
  taxes_base?: TaxRefType[];
  total_cents: number;
}

export const OrderDocItemPrice: z.ZodType<OrderDocItemPriceType> = z.strictObject({
  base_cents: z.int().default(0),
  base_percent: z.number().nullable().optional(),
  // `.nullable().optional()` and NOT defaulted: a null replacement means "this
  // line has no replacement value", which is not the fact `0` states, and
  // `checkItemContract`'s `forbidden` arm reads the difference.
  replacement_cents: z.int().nullable().optional(),
  chargeable_days: z.number().int().nullable().default(null),
  formula: PriceFormulaEnum.default("five_day_week"),
  subtotal_cents: z.int().default(0),
  subtotal_discounted_cents: z.int().default(0),
  discount: Discount.nullable().default(null),
  taxes: z.array(PriceModifier).default([]),
  taxes_base: z.array(TaxRef).optional(),
  total_cents: z.int().default(0),
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
   * Revenue chart-of-accounts code, denormalized from the product at write time,
   * deciding whether the line is taxable at all (`isTaxableCoa` in
   * `@cfs/core/utils/orders`).
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
}

// Un-annotated so `_zod.propValues` survives for `z.discriminatedUnion` below;
// the annotated public alias is exported immediately after. `z.enum(...)` is
// inlined rather than reusing `DocLineItemTypeEnum` for the same reason — the
// shared const carries a `z.ZodType<…>` annotation that erases the literals.
// See `_dividers.ts` for the full rationale.
const OrderDocLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES),
  // CANONICAL RATIONALE for every item `name` in the package — the divider,
  // transaction-fee, invoice and fulfillment leaves all point back here (#40).
  //
  // Catalog product name ("Dewalt Work Light") — NOT customer data, so it
  // survives fixture sanitization verbatim, which is the whole point of drawing
  // fixture line items from real orders. Tagged explicitly rather than left
  // untagged so the decision is visible and the drift gate can see it. Custom
  // items put operator-typed text here, but it is equipment/service text by
  // convention.
  //
  // An item `name` is a LABEL — catalog text, a section header, a venue, a tax
  // name, `Order #NNN`. It is not a person or an organization, which is why
  // `order` / `invoice` / `fulfillment` are now listed in `NAME_SENSITIVE`
  // (`src/schemas/pii/dictionary.ts`) — being listed there forces every `name`
  // under them to state an answer instead of defaulting into one.
  name: z.string().min(1).max(100).meta({ pii: "none" }),
  // Line-item text, classified the same as `name` above: it carries equipment,
  // service and destination wording — a PO number, a product name — not customer
  // data. It previously masked on the theory that a custom item's description
  // paraphrases the customer; that is not what the field is used for in practice.
  //
  // Tagged explicitly rather than left untagged so the decision is visible and
  // the drift gate can see it, and so every `items[].description` in the package
  // (order, invoice, fulfillment, and their input schemas) states one answer.
  // Consequence: it survives fixture sanitization verbatim and appears raw in
  // logs — the same posture `name` has always had.
  description: z.string().meta({ pii: "none" }).default(""),
  quantity: z.number().int().min(0).default(0),
  // Required, not `.optional()` — see the interface docblock. A `.default()`
  // would be worse than useless here: `validateBeforeWrite` persists the RAW
  // doc, so a default never materializes, and an omitted `price` would reach
  // Firestore absent while the published type promised one.
  price: OrderDocItemPrice,
  // Required for every line type, `transaction_fee` included — a fee holds no
  // stock, which `"none"` says exactly (1,533 prod lines already use it). That
  // keeps the fee an ordinary line item, which is the whole point of W1's
  // collapse of the separate fee arm, rather than earning it a contract axis.
  stock_method: StockMethodEnum,
  order_number: z.number().optional(),
  uid_order: FirestoreId.optional(),
  path: z.array(ItemUid).default([]),
  inclusion_type: z.enum(INCLUSION_TYPES_NULLABLE).nullable().optional(),
  zero_priced: z.boolean().nullable().optional(),
  crms_id: z.number().nullable().optional(),
  // Denormalized from the product at write time — see the interface docblock for
  // why this is on the DOC line and not the input one. `.optional()` rather than
  // defaulted: `validateBeforeWrite` persists the RAW doc, so a `.default()`
  // never materializes, and every line written before beta.120 is genuinely
  // absent rather than null.
  coa_revenue: COARevenueEnum.nullable().optional(),
}).superRefine(checkItemContract);

export const OrderDocLineItem: z.ZodType<OrderDocLineItemType> = OrderDocLineItemInner;

/** Destination divider item in the order document items array. */
export interface OrderDocDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
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

/** Denormalized organization snapshot on the order document. */
const OrderDocOrganization = z.strictObject({
  uid: FirestoreId.nullable(),
  name: z.string().min(1).max(100).meta({ pii: "mask" }),
  crms_id: z.number().nullable().optional(),
  xero_id: z.uuid().nullable(),
  billing_address: Address.optional(),
});

/** Order totals. */
export interface OrderDocTotalsType {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  replacement_total_cents: number;
}

const OrderDocTotals: z.ZodType<OrderDocTotalsType> = z.strictObject({
  discount_amount_cents: z.int().default(0),
  subtotal_cents: z.int().default(0),
  subtotal_discounted_cents: z.int().default(0),
  taxes: z.array(PriceModifier).default([]),
  transaction_fees: z.array(PriceModifier).default([]),
  total_cents: z.int().default(0),
  replacement_total_cents: z.int().default(0),
});

/**
 * Full order document schema (Firestore document shape).
 * Used for validation before writing to Firestore.
 */
export interface Order {
  uid: string;
  number: number;
  status: OrderStatusType;
  organization: {
    uid: string | null;
    name: string;
    crms_id?: number | null;
    xero_id: string | null;
    billing_address?: AddressType | null;
  };
  destinations: DocDestinationType[];
  items: OrderDocItemType[];
  tax_profile: TaxProfileType;
  totals: OrderDocTotalsType;
  invoices: Array<{ uid: string; number: number; status: InvoiceStatusType }>;
  query_by_invoices: string[];
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  /**
   * Roll-up of breakdown across all bookings on this order. Mirrors the keys
   * of `stock-summaries.bookings_breakdown` and `booking.breakdown` but
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
  crms_id?: number | null;
  crms_status?: string;
  subject?: string;
  reference?: string | null;
  xero_id?: string | null;
  uid_thread?: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for the full order Firestore document. */
export const OrderSchema: z.ZodType<Order> = z.strictObject({
  uid: FirestoreId,
  number: z.int(),
  status: OrderStatus,
  organization: OrderDocOrganization,
  destinations: z.array(DocDestination).min(1),
  items: z.array(OrderDocItem).default([]),
  // Required (no `.default("tax_applied")`): the Typesense config declares it
  // so, and a `.default()` never materializes on a write — see the note in
  // `product.ts`. No `initial` needed: TAX_PROFILES[0] is "tax_applied", so
  // the enum's type-derived seed already equals the dropped default.
  tax_profile: TaxProfileEnum,
  totals: OrderDocTotals,
  invoices: z.array(z.strictObject({ uid: FirestoreId, number: z.number(), status: InvoiceStatusEnum })).default([]),
  query_by_invoices: z.array(z.string()).default([]),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  query_by_dates: z.array(z.string()).default([]),
  bookings_breakdown: z.strictObject({
    quoted: z.number().default(0),
    reserved: z.number().default(0),
    prepped: z.number().default(0),
    out: z.number().default(0),
    returned: z.number().default(0),
    lost: z.number().default(0),
    damaged: z.number().default(0),
  }).default({ quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0 }),
  crms_id: z.number().nullable().optional(),
  crms_status: z.string().optional(),
  subject: z.string().default(""),
  reference: z.string().max(255).nullable().default(null),
  xero_id: z.uuid().nullable().default(null),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Order",
  collection: "orders",
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<Order>;

// ── Shared utility types ─────────────────────────────────────────

/**
 * A consolidated line item — aggregated quantity and price for display.
 * Used by consolidateItems() in utilities and the manager app.
 */
export interface ConsolidatedItemType {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  total_price_cents: number;
  /**
   * A LOSSY per-unit denorm of `total_price_cents` — `unit_price_cents ×
   * quantity` does not in general equal `total_price_cents`, and that residual
   * is discarded on purpose because nothing multiplies it back. Contrast
   * `getXeroUnitAmountFromCents`, whose residual is real money in someone
   * else's ledger and is absorbed through `DiscountRate`.
   */
  unit_price_cents: number;
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
