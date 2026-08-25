/**
 * Shared order utility functions for CFS applications.
 * Includes pricing calculations, item consolidation, and destination grouping.
 * All arithmetic uses currency.js for safe floating-point calculations.
 *
 * ```ts
 * import { calculateOrderTotals } from "@cfs/core/utils/orders";
 *
 * const items = [
 *   {
 *     type: "rental",
 *     quantity: 1,
 *     price: {
 *       base: 100,
 *       formula: "five_day_week",
 *       chargeable_days: 5,
 *       discount: null,
 *       taxes: [],
 *       subtotal: 100,
 *       subtotal_discounted: 100,
 *     },
 *   },
 * ];
 * const totals = calculateOrderTotals(items, []);
 * console.log(totals.total); // 100
 * ```
 *
 * @module
 */

import type {
  COARevenueType,
  TaxedAsType,
  DiscountType,
  PriceModifierType,
  OrderDocTotalsType,
  OrderDocItemPriceType,
  OrderDatesType,
  OrderDocDatesType,
  DestinationType,
  DocDestinationType,
  DocDestinationEndpointType,
  JurisdictionType,
  OrderDocDestinationItemType,
  FirestoreTimestampType,
  ConsolidatedItemType,
  GroupPathType,
  ItemTypeType,
  PriceFormulaType,
  PreTaxItemType,
  FromTotalItemType,
  RateType,
  Tax as SchemaTax,
} from "../schemas/mod.ts";
import { itemContract } from "../schemas/mod.ts";
import { getDuration, toChicagoYmd } from "./dates.ts";
import {
  fromCents,
  roundDivHalfAwayFromZero,
  roundDivHalfUp,
  toCentsBig,
} from "./money.ts";

// ── Types ────────────────────────────────────────────────────────

/** @see {@link DiscountType} from `@cfs/core/schemas` */
export type Discount = DiscountType;

/** @see {@link PriceModifierType} from `@cfs/core/schemas` */
export type PriceModifier = PriceModifierType;

/** @see {@link OrderDocItemPriceType} from `@cfs/core/schemas` */
export type PriceObject = OrderDocItemPriceType;

/**
 * Subset of the full Tax document needed by utility functions.
 *
 * Only `uid`/`name`/`rate`/`type` are required — those are what the pricing
 * helpers read. Everything else is resolution metadata that only the as-of
 * resolvers in `@cfs/core/utils/taxes` (`findTaxAt`, `findTaxFor`) touch, and
 * it stays optional so partial `Tax` literals in tests and callers keep
 * type-checking.
 *
 * ⚠️ **`applied_from`/`applied_to` stay optional HERE while being required on
 * the document.** That is deliberate: a missing bound reads as OPEN, so every
 * version brackets every instant and {@link findTaxAt} throws `Tax catalog
 * drift` on the pricing path. A partial literal in a test is allowed to be
 * wrong that way; a stored document is not, which is why `TaxSchema` requires
 * the pair and this structural subset does not.
 */
export type Tax =
  & Pick<SchemaTax, "uid" | "name" | "rate" | "type">
  & Partial<
    Pick<
      SchemaTax,
      | "applied_from"
      | "applied_to"
      | "effective_from"
      | "jurisdiction"
      | "item_types"
      | "xero_tax_type"
      | "xero_account_code"
      | "xero_item_code"
      | "xero_components"
    >
  >;

/**
 * A single item in an order/invoice/fulfillment array — product, divider,
 * surcharge or fee.
 *
 * A structural supertype, not a shadow of the real unions. Every member of
 * `OrderDocItemType`, `InvoiceDocItemType` and `FulfillmentItemType` is
 * assignable to it, so a caller holding real doc items passes them straight in
 * and the generic helpers (`computeItemPaths`, `getItemSubtreeRange`, …) hand
 * back the caller's own type. It exists because the manager also calls these
 * helpers on STAGED, mid-edit items that are not yet valid doc items — narrowing
 * the helpers to the doc unions would force those callers back into casts.
 *
 * `type` is `ItemTypeType`, NOT `string`. That is the difference between a
 * supertype and a hole: the pricing and billability predicates all resolve
 * through `ITEM_CONTRACTS`, and a `string` here made "a type with no contract" a
 * reachable state for every one of them. The runtime guards still handle it —
 * these items come off Firestore documents — but no caller can construct it.
 *
 * Member-specific fields are still reached through the type guards
 * (`isPriceableItem`, `isPreTaxItem`, `isTransactionFeeItem`).
 */
export interface LineItem {
  uid: string;
  name: string;
  type: ItemTypeType;
  quantity?: number;
  price?: PriceObject;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
  /**
   * Revenue chart-of-accounts code — **where the line's income POSTS in Xero**.
   * Stored on an invoice line; absent on an order line, where it lives on the
   * product — see {@link PricingItem.coa_revenue}.
   *
   * ⚠️ It does **not** decide taxability, and until 2026-08-20 it did. Owner:
   * *"an item's tax is item type × jurisdiction, it has nothing to do with
   * coa."* {@link isTaxableCoa} is the retired gate.
   *
   * `COARevenueType`, not `number` — every schema that stores this field
   * (`OrderDocLineItem`, `InvoiceDocLineItem`, and the product) types it with
   * `COARevenueEnum`, so a bare `number` here made this type *not* a supertype
   * of the three it claims to generalise: a `LineItem` was not assignable to an
   * `InvoiceDocLineItem` on this one field, and the first projection that had to
   * emit it hit TS2322.
   *
   * The looser `number` is still correct one layer down, on
   * {@link PricingItem.coa_revenue} — that is the *input* surface, where an
   * unresolved product COA legitimately arrives before anything has validated
   * it, and {@link isTaxableCoa} keeps its `number` parameter for the same
   * reason. Narrowing here does not narrow that: `COARevenueType` is a subtype
   * of `number`, so a `LineItem` still satisfies `PricingItem`.
   */
  coa_revenue?: COARevenueType | null;
  /**
   * **The type this line is TAXED as**, overriding {@link LineItem.type} for
   * the tax rule alone (`taxed_as ?? type` — see `resolveLineTax`).
   *
   * The escape hatch for a line whose billing type and tax treatment
   * legitimately differ, and the reason the tax key is not simply `type`: a
   * `custom-` line has no product to inherit an account from, so its author
   * picks the nearest billing type and the tax rule would otherwise follow that
   * choice. `"none"` means untaxed outright — no tax lists it, so it needs no
   * branch of its own.
   */
  taxed_as?: TaxedAsType | null;
}

/**
 * A pre-tax line item with a full price object — every type the contract table
 * marks `pricing: "pre_tax"`.
 *
 * The member list is DERIVED from `ITEM_CONTRACTS`, not written out. It used to
 * be the literal `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
 * which made this a sixth place to remember when an item type was added.
 */
export interface PreTaxLineItem extends LineItem {
  type: PreTaxItemType;
  quantity: number;
  price: PriceObject;
}

/**
 * A transaction fee line item.
 *
 * Carries the same `PriceObject` every other line carries — a fee is an
 * ordinary line whose `price.formula` is `percent_of_total`, not a second price
 * shape. It differs from a `PreTaxLineItem` only in that it is priced FROM the
 * document total rather than into it, which is why it has its own predicate and
 * its own pass in `calculateOrderTotals`.
 */
export interface TransactionFeeLineItem extends LineItem {
  type: FromTotalItemType;
  quantity: number;
  price: PriceObject;
}

/** Any item that has pricing — pre-tax or transaction fee. */
export type PriceableLineItem = PreTaxLineItem | TransactionFeeLineItem;

/**
 * The price fields the pricing pipeline actually READS — deliberately narrower
 * than the stored {@link PriceObject}.
 *
 * `taxes` needs only a `uid`, because the name/rate/type/amount_cents are what
 * `calculateItemTax` resolves and computes; `subtotal_cents`,
 * `subtotal_discounted_cents`, `total_cents` and `taxes_base` are pricing's
 * OUTPUT and are never read as input.
 *
 * That is not a convenience: it is the shape an order-input item genuinely
 * arrives in (`ItemPriceType` in `@cfs/core/schemas`, whose `taxes` is
 * `{ uid }[]`). Typing the pricing entry points here is what lets a writer price
 * an item it has not built yet, instead of casting the input through
 * `as unknown as LineItem` and claiming a stored price it does not have —
 * which is what `api-cloudrun`'s `buildLineItem` did, twice, on the money path.
 */
export interface PricingPrice {
  /** Integer cents. Meaningless (and asserted 0) on a `percent_of_total` line. */
  base_cents?: number;
  /** The `percent_of_total` percentage at 4dp — see {@link checkPriceBaseUnit}. */
  base_percent?: number | null;
  formula?: PriceFormulaType;
  chargeable_days?: number | null;
  /** `rate` is 4dp DOLLARS on the `flat` arm and a percentage on `percent`. */
  discount?: { rate: number; type: RateType } | null;
  taxes?: readonly { uid: string }[];
}

/**
 * The item surface the pricing pipeline reads: a type (to look up the contract),
 * a quantity, and a {@link PricingPrice}. Both a stored {@link LineItem} and an
 * order-input item satisfy it.
 */
export interface PricingItem {
  type: ItemTypeType;
  quantity?: number;
  price?: PricingPrice | null;
  /**
   * Revenue chart-of-accounts code — where the line's income posts in Xero, and
   * **not** an input to what it is taxed (owner ruling, 2026-08-20; see
   * {@link isTaxableCoa}, the retired gate).
   *
   * Optional because the two item shapes differ: an **invoice** line stores it,
   * an **order** line does not (it lives on the product). Nothing in the
   * pricing pipeline reads it any more, so an unresolved one no longer changes
   * a price; the Xero push still needs it for `AccountCode`.
   */
  coa_revenue?: number | null;
}

/** A {@link PricingItem} that has passed {@link isPreTaxPricingItem}. */
export type PreTaxPricingItem = PricingItem & { quantity: number; price: PricingPrice };

/** A {@link PricingItem} that has passed {@link isTransactionFeePricingItem}. */
export type TransactionFeePricingItem = PricingItem & { quantity: number; price: PricingPrice };

/** @see {@link OrderDocTotalsType} from `@cfs/core/schemas` */
export type OrderTotals = OrderDocTotalsType;

/** @see {@link ConsolidatedItemType} from `@cfs/core/schemas` */
export type ConsolidatedItem = ConsolidatedItemType;

/** @see {@link GroupPathType} from `@cfs/core/schemas` */
export type GroupPath = GroupPathType;

// ── Date & destination comparison ───────────────────────────────

/**
 * Whether charge dates match the delivery/collection dates
 * (i.e. no custom charge period has been set).
 */
export function isSameAsDeliveryDates(dates: OrderDatesType): boolean {
  return dates.charge_start === dates.delivery_start
    && dates.charge_end === dates.collection_start;
}

/**
 * Whether a destination's collection endpoint matches its delivery endpoint
 * (address, contact, and instructions are all equal).
 */
export function isSameAsDeliveryDestination(destination: DestinationType): boolean {
  if (!destination.delivery && !destination.collection) return true;
  if (!destination.collection) return true;
  if (!destination.delivery) return false;

  return JSON.stringify(destination.delivery.address) === JSON.stringify(destination.collection.address)
    && JSON.stringify(destination.delivery.contact) === JSON.stringify(destination.collection.contact)
    && destination.delivery.instructions === destination.collection.instructions;
}

/**
 * Build a display name for a destination pair from its delivery/collection addresses.
 * Falls back to "Destination N" when no addresses are present.
 */
export function getDestinationPairItemName(
  destination: DestinationType,
  index: number,
): string {
  const deliveryName = destination.delivery?.address?.name || destination.delivery?.address?.street || "";
  const collectionName = destination.collection?.address?.name || destination.collection?.address?.street || "";

  if (!deliveryName && !collectionName) {
    return "Destination " + (index + 1);
  }

  if (!collectionName || deliveryName === collectionName) {
    return deliveryName || "Destination " + (index + 1);
  }

  return deliveryName + " - " + collectionName;
}

/**
 * Pair-derived legend strings for the order's start/end dates.
 *
 * Each pair contributes a label based on its `customer_collecting` /
 * `customer_returning` flags. Labels are deduped and joined with " / ", so
 * a mixed-mode order (one pair we deliver, one pair the customer picks up)
 * renders as "In Store Pickup / Delivery".
 *
 * Mapping:
 *   start: customer_collecting === true → "In Store Pickup", else → "Delivery"
 *   end:   customer_returning  === true → "In Store Return", else → "Pickup"
 *
 * Empty input returns empty strings.
 */
export function getDestinationsLegend(
  destinations: DestinationType[] | undefined | null,
): { start: string; end: string } {
  if (!destinations || destinations.length === 0) {
    return { start: "", end: "" };
  }

  const startSet = new Set<string>();
  const endSet = new Set<string>();
  for (const d of destinations) {
    startSet.add(d.customer_collecting ? "In Store Pickup" : "Delivery");
    endSet.add(d.customer_returning ? "In Store Return" : "Pickup");
  }

  return {
    start: Array.from(startSet).join(" / "),
    end: Array.from(endSet).join(" / "),
  };
}

/**
 * Compute default chargeable days from order dates and holidays.
 * Returns null if required dates are missing.
 */
export function getDefaultChargeDays(
  dates: OrderDatesType,
  holidays: string[],
): number | null {
  if (!dates?.delivery_start || !dates?.collection_start) return null;
  try {
    const duration = getDuration(dates, holidays);
    return duration?.chargeDays ?? null;
  } catch {
    return null;
  }
}

/**
 * Update chargeable_days on line items that still match the previous default.
 * Skips structural items, items without a price, and manual overrides.
 */
export function syncChargeDaysToItems(
  items: LineItem[],
  previousDefault: number | null,
  newDefault: number | null,
): void {
  if (previousDefault === newDefault) return;

  for (const item of items) {
    if (item.type === "destination" || item.type === "group") continue;
    if (!item.price) continue;
    const days = (item.price as PriceObject).chargeable_days;
    if (days === null || days === undefined) continue;
    if (previousDefault === null) continue;
    if (days !== previousDefault) continue;
    (item.price as PriceObject).chargeable_days = newDefault;
  }
}

// ── Per-destination date rollups ─────────────────────────────────

/**
 * Order-level date envelope derived on demand from per-destination dates.
 *
 * Mirrors the field set of the old top-level `order.dates`, except the `_fs`
 * companions are nullable: utilities can't mint a Firestore Timestamp, so each
 * boundary copies the `_fs` from whichever destination owns the extreme value
 * (and is null when no destination sets that boundary).
 */
export interface OrderDateEnvelope {
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
 * Pick the extreme (earliest for `"min"`, latest for `"max"`) value of one
 * date boundary across destinations, carrying along the `_fs` companion from
 * the owning destination. Instants are compared by epoch ms so mixed
 * CST/CDT offsets compare correctly. Returns nulls when no destination sets
 * the boundary.
 */
function pickEnvelopeBound(
  destinations: ReadonlyArray<Pick<DocDestinationType, "dates">>,
  isoKey: keyof OrderDocDatesType,
  fsKey: keyof OrderDocDatesType,
  dir: "min" | "max",
): { iso: string | null; fs: FirestoreTimestampType | null } {
  let bestT: number | null = null;
  let iso: string | null = null;
  let fs: FirestoreTimestampType | null = null;
  for (const d of destinations) {
    const value = d.dates?.[isoKey] as string | null | undefined;
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) continue;
    if (bestT === null || (dir === "min" ? t < bestT : t > bestT)) {
      bestT = t;
      iso = value;
      fs = (d.dates[fsKey] as FirestoreTimestampType | undefined) ?? null;
    }
  }
  return { iso, fs };
}

/**
 * Collapse per-destination dates into one order-level envelope.
 *
 * There is no persisted order-level `dates` anymore — every destination owns
 * its own range. This derives a bounding envelope on demand for the consumers
 * that still want one order-level range: the Typesense projection's sort key
 * and the quote / Xero / Calendar / Trello exporters.
 *
 * `*_start` boundaries take the earliest value across destinations, `*_end`
 * boundaries take the latest; `days_active` / `days_charged` take the largest
 * non-null value. For a single-destination order the envelope equals that
 * destination's dates exactly.
 */
export function deriveOrderDateEnvelope(
  destinations: ReadonlyArray<Pick<DocDestinationType, "dates">>,
): OrderDateEnvelope {
  const ds = pickEnvelopeBound(destinations, "delivery_start", "delivery_start_fs", "min");
  const de = pickEnvelopeBound(destinations, "delivery_end", "delivery_end_fs", "max");
  const cs = pickEnvelopeBound(destinations, "collection_start", "collection_start_fs", "min");
  const ce = pickEnvelopeBound(destinations, "collection_end", "collection_end_fs", "max");
  const chs = pickEnvelopeBound(destinations, "charge_start", "charge_start_fs", "min");
  const che = pickEnvelopeBound(destinations, "charge_end", "charge_end_fs", "max");

  let days_active: number | null = null;
  let days_charged: number | null = null;
  for (const d of destinations) {
    if (d.dates?.days_active != null) {
      days_active = Math.max(days_active ?? 0, d.dates.days_active);
    }
    if (d.dates?.days_charged != null) {
      days_charged = Math.max(days_charged ?? 0, d.dates.days_charged);
    }
  }

  return {
    delivery_start: ds.iso, delivery_start_fs: ds.fs,
    delivery_end: de.iso, delivery_end_fs: de.fs,
    collection_start: cs.iso, collection_start_fs: cs.fs,
    collection_end: ce.iso, collection_end_fs: ce.fs,
    charge_start: chs.iso, charge_start_fs: chs.fs,
    charge_end: che.iso, charge_end_fs: che.fs,
    days_active,
    days_charged,
  };
}

/** Minimal destination shape consumed by {@link buildQueryByDates}. */
interface QueryByDatesDestination {
  dates: {
    delivery_start: string | null;
    delivery_end: string | null;
    collection_start: string | null;
    collection_end: string | null;
  };
}

/**
 * Deduped, ascending list of Chicago `YYYY-MM-DD` boundary days across every
 * destination's delivery + collection windows. Server-maintained on the order
 * (and fulfillment) doc as `query_by_dates`, reserved for exact-day Firestore
 * `array-contains` lookups. Charge dates are billing-only and excluded.
 */
export function buildQueryByDates(
  destinations: ReadonlyArray<QueryByDatesDestination>,
): string[] {
  const days = new Set<string>();
  for (const d of destinations) {
    for (
      const iso of [
        d.dates?.delivery_start,
        d.dates?.delivery_end,
        d.dates?.collection_start,
        d.dates?.collection_end,
      ]
    ) {
      if (iso) days.add(toChicagoYmd(iso));
    }
  }
  return [...days].sort();
}

// ── Type guards ──────────────────────────────────────────────────

// All three predicates below read the SAME fact — `ITEM_CONTRACTS[type].pricing`
// — instead of each restating type membership. They used to be three
// independent lists of type literals, and a fourth type would have had to be
// added to all three (and to the 11 rival billability predicates across the
// three repos) to be priced correctly. `pricing` is the one place that decides.
//
// An unrecognized `type` has no contract and every predicate answers `false`
// (it was previously TRUE for `isPriceableItem`). `LineItem.type` is now
// `ItemTypeType` rather than `string`, so a caller cannot reach that branch
// through the type system — but the runtime check stays, because these items
// come off Firestore documents and a type predicate is not a parse.

/**
 * Determine whether a line item is priceable (has a price object, not a structural item).
 */
export function isPriceableItem(item: LineItem): item is PriceableLineItem {
  if (!item || typeof item !== "object") return false;
  const pricing = itemContract(item.type)?.pricing;
  if (pricing !== "pre_tax" && pricing !== "from_total") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Determine whether a line item is a transaction fee.
 */
export function isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem {
  if (!item || typeof item !== "object") return false;
  if (itemContract(item.type)?.pricing !== "from_total") return false;
  if (!item.price || typeof item.price !== "object") return false;
  // core#49's remaining arm. `TransactionFeeLineItem` DECLARES `quantity: number`
  // while `LineItem` has it optional, so omitting this check made the predicate
  // lie — and the lie reached the money. Measured before the fix: a `from_total`
  // line with no quantity passed this predicate, and
  // `calculateTransactionFeeAmountCents` then threw
  // `The number NaN cannot be converted to a BigInt` out of `perUnitSubtotal` on
  // the non-`percent_of_total` branch. Loud rather than silent — unlike core#49's
  // `currency(NaN).value === null` — but an opaque BigInt error in place of this
  // function's own message, and a predicate that returns `true` for a value it
  // has just declared well-typed. The `percent_of_total` branch never reads
  // `quantity` and was never affected.
  if (typeof item.quantity !== "number") return false;
  return true;
}

/**
 * Determine whether a line item participates in subtotal/discount/tax calculations.
 * Standalone predicate (not composed) because TS doesn't support negated predicates.
 */
export function isPreTaxItem(item: LineItem): item is PreTaxLineItem {
  if (!item || typeof item !== "object") return false;
  if (itemContract(item.type)?.pricing !== "pre_tax") return false;
  if (!item.price || typeof item.price !== "object") return false;
  // `PreTaxLineItem` DECLARES `quantity: number`, so not checking it made the
  // predicate lie, and the lie was quiet rather than loud: `currency(NaN).value`
  // is `null`, not `NaN`, so `calculateReplacementTotals` returned
  // `{subtotal: null, tax: 0, total: null}` against a declared `subtotal: number`.
  // A blank or $0.00 replacement value is what a loss-liability figure is read
  // off — the wrong direction to fail in. core#49.
  if (typeof item.quantity !== "number") return false;
  return true;
}

/**
 * {@link isPreTaxItem} at the {@link PricingItem} surface — the same three
 * checks, narrowing to a shape the pricing pipeline can read rather than to a
 * stored line item. Used by the three pricing entry points so they accept an
 * order-input item without being handed a stored price that does not exist yet.
 */
export function isPreTaxPricingItem(item: PricingItem): item is PreTaxPricingItem {
  if (!item || typeof item !== "object") return false;
  if (itemContract(item.type)?.pricing !== "pre_tax") return false;
  if (!item.price || typeof item.price !== "object") return false;
  // Same unsoundness as `isPreTaxItem`, and this is the one that guards the
  // MONEY path — `calculateItemSubtotal` narrows through here before
  // `perUnitSubtotal` multiplies by `item.quantity`. `PricingItem.quantity` is
  // `?: number` while `PreTaxPricingItem` intersects `{quantity: number}`, so
  // the cast was unchecked in exactly the place it matters most. core#49 named
  // only `isPreTaxItem`; fixing one and not the other would have left the
  // subtotal path lying while making the replacement path honest.
  if (typeof item.quantity !== "number") return false;
  return true;
}

/**
 * {@link isTransactionFeeItem} at the {@link PricingItem} surface — the same
 * checks, narrowing to a shape the pricing pipeline can read rather than to a
 * stored line item.
 *
 * The exact {@link isPreTaxItem} / {@link isPreTaxPricingItem} pairing, applied
 * to the fee family (core#56). It exists so a writer holding an item it has not
 * built yet can reach the fee pricer without inventing `uid`, `name` and `path`
 * — which is what `api-cloudrun/src/lib/transactionFeeLine.ts` was doing.
 *
 * ⚠️ The `quantity` check is load-bearing HERE in a way it is not at the
 * `LineItem` surface: `PricingItem.quantity` is `?: number` by design, because
 * the whole point of the shape is to describe an item mid-construction. A
 * caller reaching this predicate with the quantity not yet resolved is the
 * expected case, not a malformed document.
 */
export function isTransactionFeePricingItem(item: PricingItem): item is TransactionFeePricingItem {
  if (!item || typeof item !== "object") return false;
  if (itemContract(item.type)?.pricing !== "from_total") return false;
  if (!item.price || typeof item.price !== "object") return false;
  if (typeof item.quantity !== "number") return false;
  return true;
}

// ── Exact money arithmetic ───────────────────────────────────────
//
// Line subtotals are computed as exact rationals in BigInt and rounded to cents
// exactly once, at the end. currency.js is still the right tool for *summing*
// money (see `calculateOrderTotals`), but it is the wrong tool for applying a
// factor, because it quantizes every intermediate at its precision — including
// intermediates that are not money.
//
// The old form applied the factors as pre-divided floats:
//
//     currency(base).multiply(quantity).multiply(chargeable_days / 5)
//     subtotal.multiply((100 - discount.rate) / 100)
//
// Neither quotient is representable in binary. The days factor happened to be
// harmless — currency.js re-quantizes after each multiply and, over 300k random
// rental lines, never flipped a rounding tie. The discount factor was not: it
// mis-rounded 14 of those 300k lines by a cent, always upward, i.e. it undercharged
// the discount. Applying `× n ÷ d` instead of `× (n/d)` removes the class.

/** Scale for a possibly-fractional `quantity` (orders are `z.int()`; invoices are not). */
const QTY_SCALE = 10_000n;
/** Scale for a discount `rate`, in millionths of a percentage point. */
const RATE_SCALE = 1_000_000n;

// ── Item-level calculations ──────────────────────────────────────

/**
 * Calculate the pre-discount and post-discount subtotals for a single line item.
 *
 * `subtotal = base × quantity × max(chargeable_days / 5, 1)` for `five_day_week`,
 * or `base × quantity` for `fixed`. The one-week floor means the day factor only
 * applies above 5 chargeable days.
 */
export function calculateItemSubtotal(
  item: PricingItem,
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  if (!isPreTaxPricingItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }
  return perUnitSubtotal(item.price, item.quantity);
}

/**
 * The per-unit half of `calculateItemSubtotal`, split out so the fee path can
 * reach it without spoofing a discriminator. Takes the price and quantity
 * directly, because "which item type is this" is the caller's question.
 */
function perUnitSubtotal(
  price: PricingPrice,
  itemQuantity: number,
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  const { base_cents = 0, formula, chargeable_days = null, discount } = price;
  if (formula === "percent_of_total") {
    // Not a per-unit price: the rate lives in `base_percent` and is a
    // percentage of the DOCUMENT's subtotal_discounted, which this function
    // cannot see. Only a `transaction_fee` may be priced this way, and it is
    // costed by `calculateTransactionFeeAmount` in the totals pass instead.
    throw new Error(
      "percent_of_total prices from the document total, not the line: use calculateTransactionFeeAmount",
    );
  }
  if (formula !== "five_day_week" && formula !== "fixed") {
    throw new Error("Unknown formula: " + formula);
  }

  const quantity = BigInt(Math.round(itemQuantity * Number(QTY_SCALE)));
  const days = Math.round(chargeable_days ?? 0);
  // `pricingFactor = Math.max(chargeable_days / 5, 1)` — so the day factor bites
  // only above the one-week floor. At exactly 5 days it is 1, as is `fixed`.
  const useDays = formula === "five_day_week" && days > 5;

  // `base_cents` is ALREADY an integer count of cents, so this is a widening
  // and not a conversion — the `toCentsBig(base)` this replaced was the one
  // dollars→cents step in the line path, and it is now the storage form.
  let num = BigInt(base_cents) * quantity;
  let den = QTY_SCALE;
  if (useDays) {
    num *= BigInt(days);
    den *= 5n;
  }
  const subtotalCents = roundDivHalfUp(num, den);

  if (!discount) {
    return { subtotal_cents: Number(subtotalCents), subtotal_discounted_cents: Number(subtotalCents) };
  }

  let discountedCents: bigint;
  if (discount.type === "percent") {
    // subtotal × (100 − rate)/100, as subtotalCents × (100·RATE_SCALE − rate·RATE_SCALE) / (100·RATE_SCALE)
    const rate = BigInt(Math.round(discount.rate * Number(RATE_SCALE)));
    const scale = 100n * RATE_SCALE;
    discountedCents = roundDivHalfUp(subtotalCents * (scale - rate), scale);
  } else {
    // `flat`: rate is DOLLARS per unit, per pricing factor — not a line total,
    // and NOT cents.
    //
    // ⚠️ `toCentsBig` survives here on purpose, and it is the only surviving
    // dollars→cents conversion in this function. `Discount.rate` keeps its
    // dollar denomination through the cents migration because Xero's
    // `DiscountRate` holds 4dp and is a line's only discount channel; storing
    // it as an integer count of cents would quantize it, which is the
    // beta.117 regression. So the money beside it is cents and this is
    // dollars, deliberately — deleting this call to "finish the migration"
    // divides every flat discount by 100.
    let dNum = toCentsBig(discount.rate) * quantity;
    let dDen = QTY_SCALE;
    if (useDays) {
      dNum *= BigInt(days);
      dDen *= 5n;
    }
    // Subtraction is exact; a flat discount larger than the line goes negative,
    // which is the caller's problem to surface, not ours to clamp.
    discountedCents = subtotalCents - roundDivHalfUp(dNum, dDen);
  }

  return {
    subtotal_cents: Number(subtotalCents),
    subtotal_discounted_cents: Number(discountedCents),
  };
}

/**
 * The dollar amount a `transaction_fee` line contributes to a document.
 *
 * A fee is priced from the document, not from itself, so it needs the one input
 * `calculateItemSubtotal` cannot see: `basis`, the document's
 * `subtotal_discounted` (pre-tax, post-discount — the same base the fee has
 * always been computed against).
 *
 * - `percent_of_total` → `basisCents × base_percent / 100`.
 * - anything else → the ordinary per-unit subtotal, `base_cents × quantity`, so
 *   a flat processing charge stays expressible without a second formula.
 *
 * Exact: the percentage is applied as `× rate ÷ 100` over integer cents rather
 * than as a pre-divided float factor, and rounds half-up exactly once.
 *
 * The form this replaced was `currency(basis).multiply(rate / 100)`. That is the
 * *benign* float form, and an earlier version of this docstring was wrong about
 * why — `multiply` takes a plain JS number and never wraps it, so nothing
 * quantizes the ratio; it carries only the ~1e-18 representation error in
 * `rate / 100`, which flips a tie so rarely that it mis-costs **0** of the fee
 * sweep's pairs. The form that genuinely loses money is **divide-first**,
 * `currency(rate).divide(100)`, which does re-enter the constructor and
 * quantizes: `currency(12.345).divide(100) === 0.12`. Both are measured on every
 * run by the fail-closed companion in `tests/orders.test.ts` — the assertion
 * pins divide-first, the benign form is reported.
 */
export function calculateTransactionFeeAmountCents(item: PricingItem, basisCents: number): number {
  if (!isTransactionFeePricingItem(item)) {
    throw new Error("Item is not a transaction fee: missing price object or wrong type");
  }
  if (item.price.formula !== "percent_of_total") {
    return perUnitSubtotal(item.price, item.quantity).subtotal_discounted_cents;
  }
  // The percentage now lives in its own named field. Reading `base_cents` here
  // is exactly the 100× D1 exists to prevent, and it no longer type-checks as
  // the same thing.
  //
  // Non-negative on both sides — `roundDivHalfUp` truncates toward zero, so a
  // negative numerator would round the wrong way. A negative fee rate or a
  // negative document total is not a thing either side of this expresses.
  const rate = BigInt(Math.round(Math.max(item.price.base_percent ?? 0, 0) * Number(RATE_SCALE)));
  const scale = 100n * RATE_SCALE;
  return Number(roundDivHalfUp(BigInt(Math.max(basisCents, 0)) * rate, scale));
}

/**
 * Calculate the discount amount, in cents, for a single line item.
 *
 * Plain integer subtraction: both operands are exact counts of cents, so there
 * is nothing for currency.js to be careful about.
 */
export function calculateItemDiscountCents(item: LineItem): number {
  const { subtotal_cents, subtotal_discounted_cents } = calculateItemSubtotal(item);
  return subtotal_cents - subtotal_discounted_cents;
}

/**
 * The revenue COAs that sales/rental tax is actually owed on — 4000 Rental
 * Income, 4140 Pass Through Income, 4200 Retail Sales Income, 4210 Replacement
 * Sales Income.
 *
 * 🔴 **This is no longer a taxability rule.** It was the single source of truth
 * for line taxability until the owner ruling of 2026-08-20 — *"an item's tax is
 * item type × jurisdiction, it has nothing to do with coa"* — and both gates
 * built on it (the engine's {@link isTaxableCoa} and api-cloudrun's
 * `resolveXeroTaxType`) were removed together. What it records now is which
 * accounts CFS's Xero history taxed, which is what {@link TAXABLE_COA_TO_TAX_NAME}
 * and the restatement tools need.
 *
 * It existed because the set previously lived only on the *Xero push* side and
 * nowhere in the engine computing CFS's own totals. So CFS taxed lines it then
 * told Xero were untaxable (`TaxType: "NONE"`), inflating `total` and leaving
 * the difference as a phantom `amount_due`. Measured on prod 2026-07-30:
 * **19 invoices / $2,741.78**, plus 9 orders / $453.50. ⚠️ That failure is why
 * the two gates had to be deleted in ONE commit rather than one at a time —
 * removing either alone recreates it exactly.
 *
 * Everything outside the set is a service or fee — Service Income, Delivery
 * Surcharges, Transaction Fee, Other Income — and sales tax is not owed on it.
 * Xero was right and the engine was wrong, so there is no historical
 * under-collection: the customer was always billed the untaxed amount and CFS
 * merely displayed a balance that was never real.
 *
 * **4140 Pass Through Income was added 2026-08-02, and the direction matters.**
 * Every other member of this set was here because Xero disagreed with the engine
 * and Xero was right. 4140 is the one case where the two agreed with each other
 * and the constant was the outlier: prod invoice #1897 carries its SSD Card line
 * at `AccountCode: 4140` in CFS *and* in Xero, taxed `TAX003` (Chicago Rental,
 * 11%) for $510.40 in both, paid in full. Excluding 4140 meant the next reprice
 * of that invoice would have deleted tax that was charged, collected and
 * remitted. Operator decision: pass-through income is taxable.
 *
 * `api-cloudrun/src/lib/xeroTax.ts` consumes this same constant so the push and
 * the totals cannot drift apart again.
 */
export const TAXABLE_REVENUE_COAS: readonly number[] = [4000, 4140, 4200, 4210];

/**
 * Was a line with this revenue COA subject to tax **under the retired
 * account-keyed gate**?
 *
 * 🔴 **Nothing in the pricing pipeline calls this.** Owner, 2026-08-20: *"an
 * item's tax is item type × jurisdiction, it has nothing to do with coa, coa is
 * not a determining factor for tax."* The gate was deleted from
 * `resolveLineTax`, from {@link calculateItemTax} and from api-cloudrun's
 * `resolveXeroTaxType` in one commit — **one alone recreates api-cloudrun#409**,
 * where CFS computed a tax it then told Xero not to charge and the difference
 * stood as a phantom `amount_due` on 19 invoices / $2,741.78.
 *
 * What it is FOR now: explaining the corpus the gate shaped. The invoice-sync
 * `coa_untaxes` arm (`@cfs/core/utils/invoices`) reads it to say why a frozen
 * invoice line carries no tax while its order line does, and api-cloudrun's
 * `repair-invoice-restate-from-xero.ts` reads it to restate historical lines the
 * way Xero billed them. Both are statements about documents already written.
 *
 * **`null`/`undefined` meant UNKNOWN, and unknown was TAXABLE** — the opposite
 * of the Xero push's `![4000, 4200, 4210].includes(coa ?? 0)`. That asymmetry
 * was deliberate (an order line carries no `coa_revenue` at all, so folding
 * unknown into "untaxable" would have zeroed the tax on every order line in the
 * corpus) and it is preserved here, because a historical explanation has to
 * reproduce the rule that ran — not a tidier one.
 *
 * ⚠️ Do not reintroduce it as a taxability test. The class it was really
 * covering — a TAX billed as a line, the CRMS bottled-water levy at coa 2210 —
 * is said on the axis the rule reads now: `taxed_as: "none"`.
 */
export function isTaxableCoa(coaRevenue: number | null | undefined): boolean {
  if (coaRevenue === null || coaRevenue === undefined) return true;
  return TAXABLE_REVENUE_COAS.includes(coaRevenue);
}

/**
 * Pure per-item tax amount for one tax against a given subtotal.
 * `percent` → `subtotalDiscounted × rate/100`; `flat` → `rate × quantity`.
 *
 * `subtotalDiscounted` is a **parameter** (not recomputed) so both the order
 * path (which passes its `calculateItemSubtotal` result) and the CRMS invoice
 * webhook (which passes its `charge_total`-authoritative stored subtotal) share
 * one formula. Lives here (base module) and is re-exported from
 * `@cfs/core/utils/taxes` to avoid a `taxes ↔ orders` import cycle.
 *
 * Exact: both factors are applied as `× n ÷ d` over integer cents and rounded
 * half-up exactly once (core#47). The form this replaced was
 * `currency(subtotalDiscounted).multiply(tax.rate / 100)` — a pre-divided float
 * ratio, and **the one percent-of-money path that never migrated to integer
 * cents**: inside a single `calculateItemPrice` call the discount on a line was
 * already exact BigInt while the tax on that same line was not. It was measured
 * benign across CFS's six live rates, which is precisely why it survived; the
 * sweep in `tests/orders.test.ts` is what makes a future rate or magnitude
 * unable to change that silently.
 *
 * A negative `subtotalDiscounted` is legal — `calculateItemSubtotal` lets a flat
 * discount exceed its line rather than clamping — so the rounding is half *away
 * from zero* and the tax carries the subtotal's sign, exactly as the currency.js
 * form did.
 */
export function computeItemTaxAmountCents(
  tax: Pick<Tax, "rate" | "type">,
  subtotalDiscountedCents: number,
  quantity: number,
): number {
  if (tax.type === "percent") {
    // subtotal × rate ÷ 100, as cents × (rate·RATE_SCALE) / (100·RATE_SCALE).
    const rate = BigInt(Math.round(tax.rate * Number(RATE_SCALE)));
    return Number(roundDivHalfAwayFromZero(
      BigInt(subtotalDiscountedCents) * rate,
      100n * RATE_SCALE,
    ));
  }
  // `flat`: DOLLARS per unit — `Tax.rate` is a rate and keeps its dollar
  // denomination, so `toCentsBig` stays here for the same reason it stays on
  // the flat-discount arm of `perUnitSubtotal`. Invoice quantities are not
  // `z.int()`, so the quantity is a factor too and gets the same treatment.
  const qty = BigInt(Math.round(quantity * Number(QTY_SCALE)));
  return Number(roundDivHalfAwayFromZero(toCentsBig(tax.rate) * qty, QTY_SCALE));
}

/**
 * Calculate tax amounts for a single line item from the Tax[] parameter.
 * Returns a PriceModifier[] with computed amounts.
 *
 * **It prices the refs the line carries; it does not decide taxability.** That
 * decision is `resolveLineTax` / `assignLineTaxes`, which writes `price.taxes`
 * from `(taxed_as ?? type, jurisdiction)`. A revenue-account gate stood here
 * until the owner ruling of 2026-08-20 — *"an item's tax is item type ×
 * jurisdiction, it has nothing to do with coa"* — and removing it is what makes
 * the two functions answer one question instead of two.
 */
export function calculateItemTax(
  item: PricingItem,
  taxes: Tax[],
): PriceModifier[] {
  if (!isPreTaxPricingItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal_discounted_cents } = calculateItemSubtotal(item);
  const quantity = item.quantity;

  return (item.price.taxes ?? []).map((itemTax) => {
    const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
    if (!taxDoc) {
      throw new Error("Unknown tax uid: " + itemTax.uid);
    }

    return {
      uid: taxDoc.uid,
      name: taxDoc.name,
      rate: taxDoc.rate,
      type: taxDoc.type,
      amount_cents: computeItemTaxAmountCents(taxDoc, subtotal_discounted_cents, quantity),
    };
  });
}

/**
 * Calculate the complete price for a single line item.
 * Runs the full pipeline: subtotal → discount → taxes → total.
 */
export function calculateItemPrice(
  item: PricingItem,
  taxes: Tax[],
): {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: Discount | null;
  taxes: PriceModifier[];
  total_cents: number;
} {
  if (!isPreTaxPricingItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal_cents, subtotal_discounted_cents } = calculateItemSubtotal(item);
  const itemTaxes = calculateItemTax(item, taxes);

  // Integer addition over exact cent counts — currency.js has nothing left to
  // protect here, and summing through it would only re-introduce a float.
  let taxSumCents = 0;
  for (const t of itemTaxes) {
    taxSumCents += t.amount_cents;
  }

  let discount: Discount | null = null;
  if (item.price.discount) {
    discount = {
      rate: item.price.discount.rate,
      type: item.price.discount.type,
      amount_cents: subtotal_cents - subtotal_discounted_cents,
    };
  }

  return {
    subtotal_cents,
    subtotal_discounted_cents,
    discount,
    taxes: itemTaxes,
    total_cents: subtotal_discounted_cents + taxSumCents,
  };
}

/**
 * Calculate the total (subtotal_discounted + taxes) for a single line item.
 *
 * A `transaction_fee` reports its stored `price.total_cents`: it is priced from
 * the document, so the only correct value is the one the totals pass already
 * wrote. Recomputing it here would need a basis this function does not have.
 */
export function calculateItemTotalCents(
  item: LineItem,
  taxes: Tax[],
): number {
  if (!isPriceableItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group",
    );
  }

  if (isTransactionFeeItem(item)) {
    return item.price.total_cents;
  }

  const { total_cents } = calculateItemPrice(item, taxes);
  return total_cents;
}

// ── Aggregation functions ────────────────────────────────────────

/**
 * Calculate the total discount amount, in cents, across all pre-tax items.
 */
export function getTotalDiscountCents(items: LineItem[]): number {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let totalCents = 0;
  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    totalCents += calculateItemDiscountCents(item);
  }

  return totalCents;
}

/**
 * Aggregate tax PriceModifiers by name across all pre-tax items.
 */
export function getTaxTotals(
  items: LineItem[],
  taxes: Tax[],
): PriceModifier[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const totals: Record<
    string,
    { uid: string; rate: number; type: "percent" | "flat"; amount_cents: number }
  > = {};

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    const itemTaxes = calculateItemTax(item, taxes);
    for (const tax of itemTaxes) {
      if (tax.amount_cents === 0) continue;

      if (!totals[tax.name]) {
        totals[tax.name] = { uid: tax.uid, rate: tax.rate, type: tax.type, amount_cents: 0 };
      }
      totals[tax.name].amount_cents += tax.amount_cents;
    }
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount_cents }]) => ({
    uid,
    name,
    rate,
    type,
    amount_cents,
  }));
}

/**
 * Aggregate priced fee lines into the document-level `transaction_fees` rollup.
 *
 * Input is fee ITEMS carrying a costed `price` (as produced by the second pass
 * of `calculateOrderTotals` / `calculateInvoiceTotals`); output is a
 * `PriceModifier[]` — a rate-and-amount summary, which is a genuinely different
 * shape from a line and stays one. The fee's identity comes from the item
 * itself now that the price no longer carries a nested `{uid, name}`: a line
 * item's `uid` IS its product uid, which is exactly what the old
 * `price.uid` held.
 */
export function getTransactionFeeTotals(items: LineItem[]): PriceModifier[] {
  const totals: Record<
    string,
    { uid: string; rate: number; type: "percent" | "flat"; amount_cents: number }
  > = {};

  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;

    const amountCents = item.price.total_cents;
    if (amountCents === 0) continue;

    if (!totals[item.name]) {
      const isPercent = item.price.formula === "percent_of_total";
      totals[item.name] = {
        uid: item.uid,
        // `PriceModifier.rate` is DOLLARS on the flat arm and a PERCENTAGE on
        // the percent arm — the same discriminated contract as `Discount.rate`
        // — so the two arms read different source fields. This single line is
        // what `price.base`'s two units used to hide: it read one field and
        // relabelled it `rate` regardless of which unit was in it.
        rate: isPercent ? (item.price.base_percent ?? 0) : fromCents(item.price.base_cents),
        type: isPercent ? "percent" : "flat",
        amount_cents: 0,
      };
    }
    totals[item.name].amount_cents += amountCents;
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount_cents }]) => ({
    uid,
    name,
    rate,
    type,
    amount_cents,
  }));
}

/**
 * Cost every `transaction_fee` line against a document subtotal, returning
 * copies with the computed amount written into `price`.
 *
 * Shared by the order and invoice totals so the two cannot drift — they were
 * two byte-identical loops, and the invoice copy was reading `price.rate` /
 * `price.type` off a shape invoice line items have never had.
 */
export function costTransactionFees(items: LineItem[], basisCents: number): LineItem[] {
  const costed: LineItem[] = [];
  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;
    const amountCents = calculateTransactionFeeAmountCents(item, basisCents);
    costed.push({
      ...item,
      price: {
        ...item.price,
        subtotal_cents: amountCents,
        subtotal_discounted_cents: amountCents,
        total_cents: amountCents,
      },
    });
  }
  return costed;
}

/**
 * The six totals fields an order and an invoice compute identically.
 *
 * Deliberately the **intersection**, not a superset: both document totals are
 * `z.strictObject`s embedded in schemas `assertValidPatch` enforces at write
 * time, so an order doc carrying `amount_paid_cents` — or an invoice doc
 * carrying `replacement_total_cents` — fails validation. Each caller appends
 * its own tail.
 *
 * **Hand-declared as the intersection of two schema-derived shapes**, so it is
 * one of the places a rename does NOT arrive as a compile error automatically:
 * it must be edited in the same commit as `OrderDocTotalsType` and
 * `InvoiceDocTotals`, which is one of the three reasons Phase 11's core change
 * is a single commit rather than a series.
 */
export interface DocumentTotalsCore {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifier[];
  transaction_fees: PriceModifier[];
  total_cents: number;
}

/**
 * The two-pass totals fold shared by {@link calculateOrderTotals} and
 * `calculateInvoiceTotals`: pre-tax subtotals first, then transaction fees
 * costed against `subtotal_discounted`.
 *
 * It was ~35 byte-identical lines in both, which is the drift shape this
 * package exists to remove — but the two wrappers are NOT collapsible past
 * this point, and the differences are load-bearing rather than incidental:
 *
 * - **`calculateOrderTotals` keeps its `Array.isArray` throw.** Leading this
 *   helper with the invoice path's `flattenForXero` would turn a clear
 *   `Error("items must be an array")` into a bare `TypeError` at the call site.
 * - **`replacement_total` stays outside**, because
 *   {@link calculateReplacementTotals} reads the **unfiltered** items and is
 *   order-only.
 * - **The invoice path pre-filters `flattenForXero(items)` and this one does
 *   not**, which is safe because that filter is arithmetically inert here: it
 *   keeps `itemContract(type).kind === "line"`, every `kind: "divider"` member
 *   has `pricing: "none"` (pinned both directions at compile time by
 *   `_lineParity` in `schemas/common.ts`), and every predicate below gates on
 *   `pricing`. An unrecognised type is dropped by both. `filter` preserves
 *   order, and the fold accumulates in integer cents, so no float
 *   associativity hazard exists even if it did not.
 *
 * Not exported to templates — a rendered document reads its **stored**
 * `totals`, and recomputing at render time is how a document comes to disagree
 * with the doc it renders.
 */
export function sumDocumentTotals(items: LineItem[], taxes: Tax[]): DocumentTotalsCore {
  // Pass 1: compute subtotals from pre-tax items.
  //
  // Plain `+=` over integer cents. currency.js was here to make summing money
  // safe against float associativity; with every addend an exact integer count
  // of cents there is nothing left for it to protect, and routing integers
  // through a decimal type would only re-introduce the float it was guarding.
  let subtotalCents = 0;
  let subtotalDiscountedCents = 0;

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const result = calculateItemSubtotal(item);
    subtotalCents += result.subtotal_cents;
    subtotalDiscountedCents += result.subtotal_discounted_cents;
  }

  const discount_amount_cents = getTotalDiscountCents(items);
  const taxTotals = getTaxTotals(items, taxes);

  let taxSumCents = 0;
  for (const entry of taxTotals) {
    taxSumCents += entry.amount_cents;
  }

  // Pass 2: cost the transaction fees, against the CAPTURED amount.
  //
  // The basis is `subtotal_discounted + tax`, not the pre-tax subtotal, and that
  // is a decided product question rather than an implementation detail
  // (api-cloudrun#401, decided 2026-08-14): a card processor charges on the
  // amount actually captured, and the customer pays tax. Costing the fee off the
  // pre-tax figure under-charges by the fee rate times the tax.
  //
  // ⚠️ **No circularity, and it is worth stating because the expression looks
  // like there could be.** A `transaction_fee` is not an `isPreTaxItem`, so
  // `getTaxTotals` above never sees one: `taxSumCents` is fully determined
  // before this line, and the fee it feeds is itself untaxed (Card Fee and the
  // Distance/Holiday/Rush surcharges are all `tax_class: none` by policy). A
  // future decision to TAX a fee would make this genuinely circular and needs a
  // different shape, not a bigger expression.
  //
  // ⚠️ **No longer inert.** This said "0 prod invoices carry a non-empty
  // `totals.transaction_fees`, because the Card Fee is still a CRMS-authored
  // `sale` line" — true when it was written, false since 2026-08-18, when
  // api-cloudrun#401 flipped both Card Fee products to `transaction_fee`. **124
  // prod invoices and 79 orders now carry one**, so this arm runs on the money
  // path rather than standing ready for a migration.
  //
  // Worth knowing because the claim was load-bearing elsewhere: the manager's
  // `TotalsTable` flat-rate arm had never executed for the same reason, and it
  // shipped a 100x error ($43.60 rendering as $0.43) that only became reachable
  // when this stopped being true.
  const transaction_fees = getTransactionFeeTotals(
    costTransactionFees(items, subtotalDiscountedCents + taxSumCents),
  );

  let feeSumCents = 0;
  for (const entry of transaction_fees) {
    feeSumCents += entry.amount_cents;
  }

  return {
    discount_amount_cents,
    subtotal_cents: subtotalCents,
    subtotal_discounted_cents: subtotalDiscountedCents,
    taxes: taxTotals,
    transaction_fees,
    total_cents: subtotalDiscountedCents + taxSumCents + feeSumCents,
  };
}

/**
 * Calculate aggregated pricing totals for an entire order.
 * Owns the two-pass computation: pre-tax items first, then transaction fees.
 */
export function calculateOrderTotals(
  items: LineItem[],
  taxes: Tax[],
): OrderTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const core = sumDocumentTotals(items, taxes);
  const replacement = calculateReplacementTotals(items, taxes);

  return { ...core, replacement_total_cents: replacement.total_cents };
}

// ── Order inspection helpers ─────────────────────────────────────

/** Check whether any line item is a rental. */
export function orderHasRentals(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) => item.type === "rental");
}

/** Check whether any pre-tax line item has a discount. */
export function orderHasDiscount(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.discount !== null
  );
}

/** Check whether any pre-tax line item has taxes applied. */
export function orderHasTax(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.taxes.length > 0
  );
}

// ── Replacement totals ──────────────────────────────────────────

/** Replacement cost totals for an order, with and without tax. */
export interface ReplacementTotals {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}

/**
 * Calculate the total replacement cost across all pre-tax items that carry a
 * NON-ZERO replacement value on their price object.
 *
 * **Non-zero, not "present".** `price.replacement_cents` is a field on every
 * priced line rather than a rental-only one, so presence says nothing; see the
 * guard below for what testing presence used to admit, and what it started to
 * cost once a `flat` tax became reachable.
 *
 * Returns `subtotal_cents` (sum of replacement × quantity), `tax_cents` (taxes
 * applied to that subtotal), and `total_cents` (subtotal + tax).
 *
 * **Multiply-then-round, per line.** The per-line product is rounded once, at
 * the line, and the rounded lines are summed — which is not the same number as
 * rounding a per-unit figure first and multiplying it. `quote.eta` in the
 * `templates` repo hand-rolls the opposite order, and under integer cents the
 * two diverge systematically rather than coincidentally; that divergence is
 * tracked as Phase C3 work, and this function is the side that is right.
 */
export function calculateReplacementTotals(
  items: LineItem[],
  taxes: Tax[],
): ReplacementTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let subtotalCents = 0;
  let taxTotalCents = 0;

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    // `0` means "nothing to replace", and it is what every non-rental priced
    // line carries — `replacement_cents` is schema-REQUIRED whenever
    // `stock_method !== "none"` (`schemas/common.ts`), so a sale, a service and
    // a `replacement` twin all store it, and all store it at 0. Nothing writes
    // `null`: measured across the whole `quote` fixture set, 0 nulls against 38
    // lines sitting at exactly 0.
    //
    // So the old `== null` test admitted EVERY priced line. That cost blank
    // rows for as long as a zero row contributed zero — and stopped being free
    // the moment a `flat` tax existed, because the flat arm of
    // `computeItemTaxAmountCents` reads the QUANTITY and ignores the subtotal.
    // A zero-priced component carrying a $0.05/unit levy at quantity 240 then
    // adds $12.00 of tax to a $0.00 replacement subtotal, and the caller's
    // "Total Replacement Cost" is inflated by a levy no replacement triggers.
    //
    // Truthy rather than `> 0` deliberately: a NEGATIVE replacement cost is
    // meaningless rather than merely absent, and dropping it silently would
    // hide the corruption instead of showing it.
    if (!item.price.replacement_cents) continue;

    const quantity = item.quantity;
    // `× qty ÷ QTY_SCALE`, matching `perUnitSubtotal` — an order quantity is
    // `z.int()` today, so the scale is a no-op there, but the fold is written
    // once for a possibly-fractional quantity rather than assuming.
    const qty = BigInt(Math.round(quantity * Number(QTY_SCALE)));
    const itemReplacementSubtotalCents = Number(
      roundDivHalfUp(BigInt(item.price.replacement_cents) * qty, QTY_SCALE),
    );
    subtotalCents += itemReplacementSubtotalCents;

    for (const itemTax of item.price.taxes) {
      const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
      if (!taxDoc) continue;

      // Delegated rather than repeated. This WAS a second, independent copy of
      // the percent/flat branch — so core#47's fix to `computeItemTaxAmountCents`
      // would not have reached it, and the replacement path would have kept the
      // float ratio the rest of the module had migrated off. One formula, one
      // place to be wrong.
      taxTotalCents += computeItemTaxAmountCents(
        taxDoc,
        itemReplacementSubtotalCents,
        quantity,
      );
    }
  }

  return {
    subtotal_cents: subtotalCents,
    tax_cents: taxTotalCents,
    total_cents: subtotalCents + taxTotalCents,
  };
}

// ── Path computation ──────────────────────────────────────────────

/**
 * The structural divider hierarchy of an ORDER's items array, outermost first.
 *
 * A divider's index here is its level: encountering one closes every level at
 * or below it and opens its own. So a `destination` (level 0) ends the group
 * that preceded it, while a `group` (level 1) only ends a sibling group.
 *
 * Invoices nest one level deeper — see `INVOICE_ITEM_LEVELS` in
 * `@cfs/core/utils/invoices`. Fulfillments share the order hierarchy.
 */
export const ORDER_ITEM_LEVELS = ["destination", "group"] as const;

/**
 * The item surface the structural/path helpers read: identity, type, and path.
 *
 * Narrower than {@link LineItem} deliberately — these helpers never look at
 * `name`, `price` or `quantity`, and callers legitimately hold items that have
 * none of them yet (api-cloudrun's CRMS `ItemLike` is exactly this shape). Typing
 * them at `LineItem` is what forced `as unknown as LineItem[]` at those sites.
 */
export interface StructuralItem {
  uid: string;
  type: ItemTypeType;
  path?: string[];
}

/**
 * Build a set of structural item uids (dest/group) from items array.
 * Used to distinguish structural path elements from product parent refs.
 *
 * Order-shaped by default. `computeItemPaths` does NOT call this — it derives
 * the set from whichever `levels` it was handed, so an invoice's `order`
 * dividers count as structural there too. That asymmetry is why this keeps its
 * own two-type test rather than reading `ITEM_CONTRACTS[type].kind`: switching
 * to the contract would silently make `order` dividers structural here, for
 * every invoice caller.
 */
export function getStructuralUids(items: StructuralItem[]): Set<string> {
  return new Set(
    items.filter((i) => i.type === "destination" || i.type === "group").map((i) => i.uid),
  );
}

/**
 * Get the parent product uid from an item's path.
 * Returns null for non-components (where path.at(-2) is a structural uid or absent).
 */
export function getParentProductUid(item: StructuralItem, structuralUids: Set<string>): string | null {
  const secondToLast = item.path?.at(-2);
  if (!secondToLast) return null;
  if (structuralUids.has(secondToLast)) return null;
  return secondToLast;
}

/**
 * Return the contiguous index range covering an item and every descendant of it,
 * derived purely from `path` (not from item types or adjacency rules).
 *
 * `computeItemPaths` lays items out depth-first, so descendants of `items[index]`
 * are always contiguous starting at `index + 1` and run until the first item
 * whose path does not start with `items[index].path`.
 *
 * Generic over any `{ path: string[] }` so it works on order line items, invoice
 * line items (whose paths are scoped by an order divider uid), and any other
 * path-keyed flat array.
 */
export function getItemSubtreeRange<T extends { path: string[] }>(
  items: T[],
  index: number,
): { startIndex: number; endIndex: number } {
  const prefix = items[index].path;
  let endIndex = index;
  for (let i = index + 1; i < items.length; i++) {
    const p = items[i].path;
    if (p.length < prefix.length) break;
    let matches = true;
    for (let j = 0; j < prefix.length; j++) {
      if (p[j] !== prefix[j]) { matches = false; break; }
    }
    if (!matches) break;
    endIndex = i;
  }
  return { startIndex: index, endIndex };
}

/**
 * A single path mismatch reported by {@link validateItemPaths} or
 * {@link validateInvoiceItemPaths} (re-exported from `@cfs/core/utils/invoices`).
 */
export interface ItemPathIssue {
  /** Index of the offending item in the input array. */
  index: number;
  /** The item's `uid` (or `undefined` if missing). */
  uid: string | undefined;
  /** The path that was actually persisted on the item. */
  path: string[];
  /** The path that {@link computeItemPaths} would produce for this item. */
  expected: string[];
}

/**
 * Assert every line item's `path` matches what {@link computeItemPaths} would
 * produce — i.e. structural prefix + component ancestry + self uid, with no
 * stale dest/group uids from prior drag positions.
 *
 * Use as a defensive write-time invariant: any client (manager, webhook
 * handlers, manual firestore_admin pokes) that writes orders should pipe
 * `items` through `computeItemPaths` first, so a non-empty result here means
 * the client skipped the recompute step.
 *
 * Reports per-index mismatches; under the depth-first contiguity invariant,
 * an index whose `uid` doesn't match the recomputed array's uid at the same
 * index is also a violation (the array needs re-linearization). The original
 * path is reported so the caller can diff against `expected`.
 *
 * Returns `[]` when every path is clean and order is canonical.
 */
export function validateItemPaths<T extends LineItem>(items: T[]): ItemPathIssue[] {
  return validatePathsAgainst(items, computeItemPaths);
}

/**
 * The fixed-point comparison behind {@link validateItemPaths} and
 * `validateInvoiceItemPaths`, parameterised on the recompute.
 *
 * **Call the named wrappers, not this.** The workspace rule that invoice items
 * must go through `computeInvoiceItemPaths` *by name* exists because handing
 * invoice items the order hierarchy silently drops every `order` divider out of
 * every path — and a `recompute` parameter is exactly the shape that lets that
 * happen at a call site rather than at a definition. This exists so the two
 * wrappers cannot drift, not to make the recompute a caller's choice.
 *
 * It is also a **fixed-point** check, and therefore cannot be the only guard:
 * it agrees with whatever `recompute` produces, so it inherits every hole in
 * it. Pair it with a property that holds independently — `validateItemParentage`
 * against the contract table, and the direct `path.length >= 1` /
 * `path.at(-1) === uid` assertions in `api-cloudrun/src/lib/validate.ts`.
 */
export function validatePathsAgainst<T extends LineItem>(
  items: T[],
  recompute: (items: T[]) => { uid: string; path: string[] }[],
): ItemPathIssue[] {
  const recomputed = recompute(items);
  const issues: ItemPathIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const original = items[i].path ?? [];
    const expected = recomputed[i].path;
    const orderMismatch = items[i].uid !== recomputed[i].uid;
    if (
      orderMismatch ||
      original.length !== expected.length ||
      original.some((seg, j) => seg !== expected[j])
    ) {
      issues.push({ index: i, uid: items[i].uid, path: original, expected });
    }
  }
  return issues;
}

/** A single parentage violation reported by {@link validateItemParentage}. */
export interface ItemParentageIssue {
  /** Index of the offending item in the input array. */
  index: number;
  /** The item's `uid`. */
  uid: string;
  /** The item's own `type`. */
  type: string;
  /** Uid of the item's immediate structural parent (`path.at(-2)`). */
  parentUid: string;
  /** The parent's `type`, or `"<unresolved>"` when no item in the array carries that uid. */
  parentType: string;
}

/**
 * Assert every item's structural parent is a type its contract admits —
 * `ITEM_CONTRACTS[item.type].parentable_by`, resolved through `path.at(-2)`.
 *
 * **This is an INDEPENDENT property, and that is the whole point.**
 * `validateItemPaths` is a fixed-point check — "`path` equals what the
 * recompute produces" — so it can only ever agree with `computeItemPaths` and
 * inherits every hole in it. That is not hypothetical: when
 * `computeInvoiceItemPaths` returned its input unchanged on a divider-less
 * invoice, the fixed-point guard certified 79 provably-wrong items as clean,
 * corpus-wide, for as long as the hole existed. This check consults the contract
 * table instead of the normalizer, so a future hole cannot hide behind its own
 * oracle — the same reason `path.length >= 1` and `path.at(-1) === uid` are
 * asserted directly in `api-cloudrun/src/lib/validate.ts`.
 *
 * The rule it enforces is the asymmetry the corpus supports: **a divider is
 * never parented by a line item.** A `group` nested under a rental would make
 * the structural prefix `computeItemPaths` derives meaningless. Line items are
 * deliberately permissive — they are parented by dividers AND by other line
 * items (kit components).
 *
 * The document root is always legal, so an item whose `path` is just `[self]`
 * is never reported; the "must sit under a divider" rule is NOT asserted here,
 * because 78 legacy flat invoice items live at the root in prod and rejecting
 * them would make those invoices unwritable.
 *
 * Returns `[]` when every parent is admissible.
 */
export function validateItemParentage<T extends LineItem>(items: T[]): ItemParentageIssue[] {
  const typeByUid = new Map<string, string>();
  for (const item of items) typeByUid.set(item.uid, item.type);

  const issues: ItemParentageIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const path = item.path ?? [];
    if (path.length < 2) continue; // root-parented — always legal
    const parentUid = path[path.length - 2];
    const contract = itemContract(item.type);
    if (!contract) continue; // unknown type — the schema union rejects it first
    const parentType = typeByUid.get(parentUid);
    if (parentType !== undefined && (contract.parentable_by as readonly string[]).includes(parentType)) {
      continue;
    }
    issues.push({
      index: i,
      uid: item.uid,
      type: item.type,
      parentUid,
      parentType: parentType ?? "<unresolved>",
    });
  }
  return issues;
}

/**
 * A single uniqueness violation reported by {@link validateItemUniqueness}
 * (and the invoice-scoped variant in `@cfs/core/utils/invoices`).
 */
export interface ItemUniquenessIssue {
  /** Index of the second (offending) occurrence in the array. */
  index: number;
  /** The duplicated item's `uid`. */
  uid: string;
  /**
   * Uid of the immediate structural parent (group, destination, or order
   * divider) or — for components — the parent product line. `null` when the
   * item is at the top level with no enclosing structural item.
   */
  parentUid: string | null;
  /** Index of the first occurrence sharing the same `(parentUid, uid)`. */
  firstIndex: number;
}

/**
 * Shared engine for the two path-keyed uniqueness checks below.
 * `parentIndexFromEnd` selects which `path` segment names the immediate
 * structural parent:
 *
 *  - `2` — orders/invoices/fulfillments `items`, whose `path` is self-INCLUDED
 *    (`computeItemPaths` writes `[...ancestors, self]`), so the parent is `path[-2]`.
 *  - `1` — products' `components`, whose `path` is the ancestor chain and
 *    EXCLUDES self, so the immediate parent is `path[-1]`.
 *
 * Keying with the wrong index conflates the same sub-item placed under two
 * DIFFERENT parents at depth >= 2 — a legal multi-occupancy — into one key and
 * falsely reports it as a duplicate.
 */
function collectUniquenessIssues<T extends LineItem>(
  items: T[],
  parentIndexFromEnd: 1 | 2,
): ItemUniquenessIssue[] {
  const seen = new Map<string, number>();
  const issues: ItemUniquenessIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const path = item.path ?? [];
    const parentUid = path.length >= parentIndexFromEnd ? path[path.length - parentIndexFromEnd] : null;
    const key = (parentUid ?? "\0root") + "\0" + item.uid;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      issues.push({ index: i, uid: item.uid, parentUid, firstIndex });
    } else {
      seen.set(key, i);
    }
  }
  return issues;
}

/**
 * Assert that within each items array, no two entries share the same `uid`
 * AND the same immediate structural parent. The immediate structural parent
 * is the second-to-last `path` segment (or `null` for items whose path is
 * just `[self.uid]`).
 *
 * This is the uniqueness invariant orders/invoices rely on so that path-based
 * line identity is unambiguous. Violations indicate a duplicate that should
 * be merged — manager's `mergeStagedIntoOrder` (`manager/src/stores/orders.ts`)
 * and the migration script consolidate.
 *
 * Returns `[]` when uniqueness holds.
 *
 * NOTE: assumes the self-INCLUDED `path` convention. Product `components`
 * exclude self from `path` — use {@link validateComponentUniqueness} for them.
 */
export function validateItemUniqueness<T extends LineItem>(items: T[]): ItemUniquenessIssue[] {
  return collectUniquenessIssues(items, 2);
}

/**
 * Products' `components` variant of {@link validateItemUniqueness}. A product
 * component `path` is the ancestor chain and EXCLUDES the component's own uid,
 * so the immediate parent is the LAST segment (`path[-1]`), not the
 * second-to-last. Reusing {@link validateItemUniqueness} here is off by one: it
 * keys a depth->=2 entry on its GRANDparent, so the same sub-product placed
 * under two different direct children — a placement the product editor supports
 * — collapses into one key and is falsely rejected (api-cloudrun#348).
 * Exact-duplicate rows (identical full `path` + `uid`) still collide and are
 * still rejected.
 *
 * Returns `[]` when uniqueness holds.
 */
export function validateComponentUniqueness<T extends LineItem>(items: T[]): ItemUniquenessIssue[] {
  return collectUniquenessIssues(items, 1);
}

/**
 * Compute full structural paths for a flat items array AND linearize it
 * depth-first with `zero_priced` items sorted before priced ones inside each
 * parent's direct-children block.
 *
 * Each item's path = [structural context...] + [component ancestry...] + [self uid].
 *
 * Client-sent paths carry component ancestry (from ProductComponent.path).
 * This function prepends structural context (dest/group) and appends self uid.
 *
 * `path` has exactly ONE author: the resolved parent. Per (destination, group)
 * block, in order:
 *  1. Resolve each line item's parent — the last segment of the client-supplied
 *     path that names another line item IN THE SAME BLOCK (structural uids and
 *     the item's own uid are skipped, as are orphan segments that resolve to no
 *     item in the block, e.g. catalog-only intermediate kit uids). No parent
 *     resolves to a block root. Parent cycles are broken deterministically.
 *  2. Derive `path` as `[...parent.path, self uid]`, or `[...structural prefix,
 *     self uid]` at a block root. Deriving from the parent's own path rather
 *     than from the client's chain is what makes ancestry transitively
 *     consistent: a client chain that skips or misnames an intermediate cannot
 *     survive, and `path.at(-2)` is the resolved parent BY CONSTRUCTION.
 *  3. Emit depth-first from that same parent relation — each parent followed by
 *     its full subtree before the next sibling — stable-sorting `zero_priced
 *     === true` before priced within each parent's direct children. Drag-drop
 *     reorders preserve intra-band order. Destination and group dividers keep
 *     their source positions; only the line items between them are reordered.
 *
 * Steps 2 and 3 read the SAME resolved parent, so the written path and the
 * emitted position cannot disagree. (They used to be decided independently —
 * the path from a globally-filtered client chain, the position from a
 * block-scoped bucketing — and a parent living in a different block was a
 * stable fixed point of the pair: 26 such order items in prod.)
 *
 * Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
 * safe to pass items that originate from a Solid store proxy (the manager app
 * routes reordered arrays through this function inside `setEntity` updaters).
 * Callers should replace their working array with the return value.
 *
 * Post-condition (under the within-parent uniqueness invariant): a parent and
 * its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
 * and `getGroupItems` can rely on path-prefix matching alone. Unconditionally:
 * every returned `path` is non-empty and ends in the item's own uid.
 */
export function computeItemPaths<T extends LineItem>(
  items: T[],
  levels: readonly string[] = ORDER_ITEM_LEVELS,
): T[] {
  const levelOf = new Map(levels.map((type, index) => [type, index]));
  const structuralUids = new Set(
    items.filter((it) => levelOf.has(it.type)).map((it) => it.uid),
  );

  const result: T[] = [];
  // The uids of the structural dividers currently in scope, outermost first.
  const stack: string[] = [];

  let i = 0;
  while (i < items.length) {
    const level = levelOf.get(items[i].type);
    if (level !== undefined) {
      // A divider closes every level at or below its own, then opens itself.
      // That one rule is what used to be `currentGroupUid = null` on a new
      // destination, and separately the order-divider scoping in
      // `computeInvoiceItemPaths`.
      stack.length = Math.min(stack.length, level);
      stack.push(items[i].uid);
      result.push({ ...items[i], path: [...stack] });
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && !levelOf.has(items[j].type)) j++;
    result.push(...resolveBlock(items.slice(i, j), [...stack], structuralUids));
    i = j;
  }
  return result;
}

/**
 * Resolve parents, derive paths, and depth-first linearize one contiguous run
 * of line items inside a single (destination, group) block.
 *
 * Parent references are by uid, so when two items in the block share a uid the
 * reference is ambiguous; the FIRST occurrence in input order wins, for both
 * the derived path and the emission position (they read the same map, so they
 * agree). This is a graceful-degradation path — the within-parent uniqueness
 * invariant rules the case out in steady state. Every input item appears in the
 * output exactly once regardless.
 */
function resolveBlock<T extends LineItem>(block: T[], prefix: string[], structuralUids: Set<string>): T[] {
  if (block.length === 0) return [];

  const blockUids = new Set(block.map((it) => it.uid));
  // A parent uid resolves to its FIRST occurrence in the block.
  const indexByUid = new Map<string, number>();
  for (let idx = 0; idx < block.length; idx++) {
    if (!indexByUid.has(block[idx].uid)) indexByUid.set(block[idx].uid, idx);
  }

  // Step 1: resolve each item's parent index (-1 = block root).
  const parentIdx: number[] = block.map((item, idx) => {
    const segs = item.path ?? [];
    for (let k = segs.length - 1; k >= 0; k--) {
      const seg = segs[k];
      if (seg === item.uid || structuralUids.has(seg) || !blockUids.has(seg)) continue;
      const resolved = indexByUid.get(seg);
      return resolved === undefined || resolved === idx ? -1 : resolved;
    }
    return -1;
  });

  // Break parent cycles (only reachable via duplicate uids): the first member
  // of each cycle encountered becomes a block root, which severs it for the
  // rest. Deterministic, and guarantees every walk terminates at -1.
  for (let idx = 0; idx < block.length; idx++) {
    const seen = new Set<number>([idx]);
    let cur = parentIdx[idx];
    while (cur !== -1) {
      if (seen.has(cur)) {
        parentIdx[idx] = -1;
        break;
      }
      seen.add(cur);
      cur = parentIdx[cur];
    }
  }

  // Step 2: derive paths from the resolved parent, root-downwards.
  const pathByIdx: (string[] | null)[] = new Array(block.length).fill(null);
  for (let idx = 0; idx < block.length; idx++) {
    if (pathByIdx[idx]) continue;
    const chain: number[] = [];
    let cur = idx;
    while (cur !== -1 && !pathByIdx[cur]) {
      chain.push(cur);
      cur = parentIdx[cur];
    }
    let base = cur === -1 ? prefix : pathByIdx[cur]!;
    for (let k = chain.length - 1; k >= 0; k--) {
      base = [...base, block[chain[k]].uid];
      pathByIdx[chain[k]] = base;
    }
  }

  // Step 3: emit depth-first off the same parent relation, zero-priced first
  // within each parent's direct children.
  const childrenOf = new Map<number, number[]>();
  for (let idx = 0; idx < block.length; idx++) {
    const key = parentIdx[idx];
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(idx);
    else childrenOf.set(key, [idx]);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => {
      const az = block[a].zero_priced === true ? 0 : 1;
      const bz = block[b].zero_priced === true ? 0 : 1;
      return az - bz;
    });
  }

  const result: T[] = [];
  const emitted = new Set<number>();
  function emitChildren(parentKey: number) {
    const bucket = childrenOf.get(parentKey);
    if (!bucket) return;
    for (const childIdx of bucket) {
      if (emitted.has(childIdx)) continue;
      emitted.add(childIdx);
      result.push({ ...block[childIdx], path: pathByIdx[childIdx]! });
      emitChildren(childIdx);
    }
  }
  emitChildren(-1);

  // Belt-and-braces: nothing can escape the walk once cycles are broken, but
  // never drop an item if it somehow does.
  if (emitted.size < block.length) {
    for (let idx = 0; idx < block.length; idx++) {
      if (!emitted.has(idx)) {
        emitted.add(idx);
        result.push({ ...block[idx], path: pathByIdx[idx]! });
      }
    }
  }

  return result;
}

// ── Item consolidation and destination grouping ──────────────────

const NON_PRODUCT_TYPES = new Set(["destination", "group", "surcharge", "transaction_fee"]);
const PACKING_LIST_ITEM_TYPES = new Set(["rental", "sale"]);
const DELIVERY_TYPES = new Set(["rental", "sale"]);
const COLLECTION_TYPES = new Set(["rental"]);

/**
 * Walk backwards from `index` to determine which destination and group
 * an item belongs to. `destination` is the destination's `uid_delivery`;
 * `group` is the group item's `uid` (not its display name) — keying on
 * uid lets group display names be edited without losing collapse state
 * or risking collisions between two groups that happen to share a name.
 */
export function getGroupPath(items: LineItem[], index: number): GroupPath {
  const item = items[index];
  const structuralUids = getStructuralUids(items);
  const result: GroupPath = {
    destination: null,
    group: null,
    product: getParentProductUid(item, structuralUids),
  };

  for (let i = index - 1; i >= 0; i--) {
    const entry = items[i];
    if (entry.type === "group" && result.group === null) {
      result.group = entry.uid ?? null;
    }
    if (entry.type === "destination") {
      result.destination = entry.uid_delivery ?? null;
      break;
    }
  }

  return result;
}

/**
 * Deduplicate line items by product UID and sum quantities.
 *
 * ## `unit_price` is a stored denorm, and `unit_price × quantity ≠ total_price`
 *
 * `total_price` is the authoritative figure — it is a sum of line totals, and
 * summing money is exact. `unit_price` is derived from it by a division that
 * usually has a remainder, so the two are related by *rounding*, not by
 * multiplication: 3 units totalling $100 give `unit_price` $33.33, and
 * `33.33 × 3` is $99.99.
 *
 * **That is correct, and it is written down here because it does not look
 * correct.** The field exists so `bookings` can be queried as a flat per-line
 * fact table — sortable, filterable, "show me every line over $500/unit" — and
 * for that a single representative per-unit figure is exactly right. It is
 * never summed and never reconciled against; anything that multiplies it back
 * to recover a total should read `total_price_cents` instead. The four money÷quantity
 * sites in CFS have four different residual contracts, and this is the
 * stored-denorm one: **the residual is discarded on purpose.**
 *
 * (Contrast `getXeroUnitAmountFromCents`, whose residual is real money because Xero
 * recomputes `LineAmount = UnitAmount × Quantity` on the other side of a wire.)
 */
export function consolidateItems(lineItems: LineItem[]): ConsolidatedItem[] {
  if (!Array.isArray(lineItems)) {
    throw new Error("lineItems must be an array");
  }

  const map: Record<
    string,
    {
      uid: string;
      name: string;
      type: string;
      quantity: number;
      total_price_cents: number;
      stock_method: string;
    }
  > = {};

  for (const item of lineItems) {
    if (NON_PRODUCT_TYPES.has(item.type)) continue;
    if (!item.uid) continue;

    const totalCents = item.price && "total_cents" in item.price
      ? (item.price.total_cents || 0)
      : 0;

    if (map[item.uid]) {
      map[item.uid].quantity += item.quantity || 0;
      map[item.uid].total_price_cents += totalCents;
    } else {
      map[item.uid] = {
        uid: item.uid,
        name: item.name || "",
        type: item.type || "",
        quantity: item.quantity || 0,
        total_price_cents: totalCents,
        stock_method: item.stock_method || "none",
      };
    }
  }

  return Object.values(map).map((entry) => ({
    uid: entry.uid,
    name: entry.name,
    type: entry.type,
    quantity: entry.quantity,
    total_price_cents: entry.total_price_cents,
    // `× QTY_SCALE ÷ scaledQuantity` over integer cents: one rounding, at the
    // end, on exact integers. `total_price_cents` stays the plain integer sum
    // above — with every addend an exact cent count there is nothing for a
    // decimal type to protect, and dividing money was never its job anyway.
    //
    // `QTY_SCALE` rather than a bare `BigInt(quantity)` for the same reason
    // `perUnitSubtotal` uses it: `LineItem.quantity` is `number` in the type
    // even though the schema constrains it to an int, and `BigInt(1.5)` throws
    // — turning a data anomaly into a failed order write inside a transaction.
    //
    // Half **away from zero**, not plain half-up: a flat discount larger than
    // its line gives a negative `price.total_cents`, which
    // `calculateItemSubtotal` deliberately does not clamp, and
    // `roundDivHalfUp` rounds a negative numerator toward zero rather than
    // half-up.
    unit_price_cents: entry.quantity > 0
      ? Number(roundDivHalfAwayFromZero(
        BigInt(entry.total_price_cents) * QTY_SCALE,
        BigInt(Math.round(entry.quantity * Number(QTY_SCALE))),
      ))
      : 0,
    stock_method: entry.stock_method,
  }));
}

// ── Minting a destination pair and its divider ──────────────────

/** What {@link buildDestinationPairWithDivider} takes. */
export interface DestinationPairMintInput {
  /**
   * Reuse an existing divider's uid instead of minting one. Pass the STORED
   * divider's uid on a rebuild — a CRMS webhook re-derives its items array on
   * every event, and letting the uid churn un-keys every pair, every path and
   * every invoice-side override that points at it.
   */
  uid?: string;
  /** The operator-typed divider label — a VENUE, not a person. */
  name: string;
  description?: string;
  dates: OrderDocDatesType;
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
  jurisdiction?: JurisdictionType | null;
  /** Injectable so a test or a migration can be deterministic. */
  mintUid?: () => string;
}

/** What {@link buildDestinationPairWithDivider} returns. */
export interface DestinationPairWithDivider {
  pair: DocDestinationType;
  /** `path` is `[]`; run `computeItemPaths` after placing it in the array. */
  divider: OrderDocDestinationItemType;
}

/**
 * **The ONE author of a destination pair AND its divider** — build them
 * together, from one identity, so they cannot be built inconsistently.
 *
 * A destination is stored as two rows that have to agree: a `type:"destination"`
 * divider in `items[]`, and a pair in `destinations[]`. Three facts couple them,
 * and this returns both halves so all three hold **by construction** rather than
 * by two call sites remembering to agree:
 *
 * ```
 * pair.uid              === divider.uid              // the row identity
 * pair.delivery.uid     === divider.uid_delivery     // the endpoint documents
 * pair.collection.uid   === divider.uid_collection
 * ```
 *
 * 🔴 **Every one of api-cloudrun#662, #663 and #664 is one of those three
 * equalities broken by a writer that authored only one side.** #662 moved the
 * pair and left the divider; #664 re-minted the divider and left the pair;
 * #663 lost an override because the *identity* it was keyed on moved. Before
 * this, each writer spelled the coupling itself — the manager minted a uuid
 * inline for the divider and built the pair beside it, and the CRMS webhook did
 * the same 120 lines apart.
 *
 * ⚠️ **This is the MINT side. {@link assignDestinationPairUids} is the DERIVE
 * side, and they are not interchangeable.** Use this where you are authoring a
 * destination — you know its identity because you are creating it. Use that one
 * where two arrays arrive from a client and you have to work out which pair
 * belongs to which divider, which is a different question with a different
 * failure mode (it can be undecidable, and reports rather than guesses).
 *
 * ⚠️ **The divider's `uid_delivery`/`uid_collection` are taken from the
 * endpoints, never passed separately.** That is what makes the second and third
 * equalities unrepresentable rather than checked, and it is why the parameter
 * list has no place to disagree. When those two fields are removed from the
 * divider arm at the contract step, this function is the single place that
 * stops emitting them.
 *
 * `path` comes back `[]` — the caller places the divider in its array and runs
 * {@link computeItemPaths}, which is the one author of a path.
 */
export function buildDestinationPairWithDivider(
  input: DestinationPairMintInput,
): DestinationPairWithDivider {
  const uid = input.uid ?? (input.mintUid ?? (() => crypto.randomUUID()))();
  const pair: DocDestinationType = {
    uid,
    dates: input.dates,
    delivery: input.delivery,
    collection: input.collection,
    customer_collecting: input.customer_collecting ?? false,
    customer_returning: input.customer_returning ?? false,
  };
  // ⚠️ ONE representation for "asserts nothing", and it is an ABSENT key —
  // `buildDestinationPair` (api-cloudrun) and `resolveJurisdiction` both read
  // presence, so writing an explicit `null` here would make a cleared claim and
  // an unstated one two states that compare unequal.
  if (input.jurisdiction != null) pair.jurisdiction = input.jurisdiction;

  const divider: OrderDocDestinationItemType = {
    uid,
    type: "destination",
    name: input.name,
    description: input.description ?? "",
    // Taken from the pair's own endpoints — see the docblock. There is
    // deliberately no parameter for these.
    uid_delivery: input.delivery.uid ?? null,
    uid_collection: input.collection.uid ?? null,
    path: [],
  };
  return { pair, divider };
}

// ── The divider ↔ pair join ─────────────────────────────────────

/** The shape {@link assignDestinationPairUids} needs from an items array. */
export interface DestinationDividerLike {
  uid: string;
  type: string;
  uid_delivery?: string | null;
  uid_collection?: string | null;
}

/** The shape {@link assignDestinationPairUids} needs from a destinations array. */
export interface DestinationPairLike {
  delivery?: { uid?: string | null } | null;
  collection?: { uid?: string | null } | null;
  uid?: string;
}

/** What {@link assignDestinationPairUids} returns. */
export interface DestinationPairUidResult<P extends DestinationPairLike> {
  /** The pairs in their original order, each carrying the uid of its divider. */
  destinations: (P & { uid: string })[];
  /**
   * Indices into the INPUT array of pairs no rung could match to a divider.
   * Under the pair-uid model such a pair is unaddressable — no line reaches it
   * through `item.path` and no divider names it — so a caller writing a
   * document should refuse rather than mint.
   *
   * ⚠️ Each of these still carries a `uid` in `destinations` (its own, or one
   * from `fallbackUid`), so the array stays well-formed for a caller that has
   * decided to proceed anyway — a migration reporting rather than halting.
   * **The presence of a uid is not a claim that the pair is joined.**
   */
  orphanPairs: number[];
  /** Uids of destination dividers no pair answers. */
  orphanDividers: string[];
}

/**
 * **The ONE author of `destinations[i].uid`** — the join between a document's
 * destination DIVIDERS (`items[]`) and its destination PAIRS
 * (`destinations[]`).
 *
 * A pair's identity IS its divider's uid ({@link DocDestinationType.uid}).
 * Where a pair does not yet state one, this derives it from the join the corpus
 * already carries — `divider.uid_delivery`/`uid_collection` against
 * `pair.delivery.uid`/`collection.uid` — so the same rule serves the migration
 * and every writer during the expand window rather than one rule per caller.
 *
 * ⚠️ **The endpoint derivation is TRANSITIONAL and must stay subordinate.**
 * Once an input carries `pair.uid` outright the derivation is dead code for
 * that caller. Deriving from the endpoints forever would keep alive the exact
 * value-join the pair uid exists to remove.
 *
 * ## The rungs, in strict precedence
 *
 * 0. **A stated uid wins.** If the pair already names a divider this document
 *    carries, that is its identity and nothing re-derives it.
 *
 *    🔴 **This rung is not an optimization, and inverting it is a live
 *    defect.** `createInvoice`'s projected arm inherits each pair's uid from
 *    its source order, where it is already correct; re-deriving those from the
 *    endpoints would let one order's divider claim another order's pair
 *    whenever two orders happen to deliver to the same address — silently
 *    re-pointing a section of a multi-order invoice.
 * 1. **Endpoint match** — an unclaimed divider takes the first unassigned pair
 *    whose `(delivery.uid, collection.uid)` equals its own `(uid_delivery,
 *    uid_collection)`. Walked in document order, so repeated endpoints pair
 *    k-th with k-th.
 * 2. **The FORCED leftover** — if exactly one divider and exactly one pair
 *    remain, they are each other's only possible partner, so pairing them is a
 *    deduction rather than a guess.
 *
 * 🔴 **There is deliberately no ordinal rung beyond that.** Two-or-more
 * leftovers on both sides is precisely the state a drifted multi-destination
 * document is in, and pairing those by position is what
 * `destinationsForItems`'s own comment calls *"the tempting fix… silently
 * wrong the first time a multi-destination document drifted."* Both sides are
 * reported instead.
 *
 * ⚠️ **Idempotent by construction**, which is what lets a writer call it
 * unconditionally: run it twice and rung 0 answers everything the first run
 * assigned.
 *
 * Measured 2026-08-25, prod and dev identically: **996 of 996 orders, 987 of
 * 988 divider-bearing invoices and 996 of 996 fulfillments carry exactly one
 * divider and one pair, and every one of them joins on rung 1.** The single
 * exception is invoice #2241 (1 divider, 2 pairs), which reaches
 * `orphanPairs`.
 *
 * @param items - The document's items array. Non-destination rows are ignored.
 * @param destinations - The document's destination pairs, in stored order.
 * @param fallbackUid - Mints a uid for a pair that states none and matches no
 *   divider. Defaults to `crypto.randomUUID`; injectable so a migration can be
 *   deterministic.
 */
export function assignDestinationPairUids<P extends DestinationPairLike>(
  items: readonly DestinationDividerLike[],
  destinations: readonly P[],
  fallbackUid: () => string = () => crypto.randomUUID(),
): DestinationPairUidResult<P> {
  const dividers = items.filter((it) => it.type === "destination");
  const dividerUids = new Set(dividers.map((d) => d.uid));
  /** Pair index → the divider uid that answers it. */
  const assigned: (string | undefined)[] = destinations.map(() => undefined);
  const claimed = new Set<string>();

  // Rung 0 — a stated identity wins, once. A second pair repeating a claimed
  // uid falls through to the rungs below and, failing those, is reported: two
  // pairs cannot be the same row.
  destinations.forEach((pair, i) => {
    const stated = pair.uid;
    if (stated && dividerUids.has(stated) && !claimed.has(stated)) {
      assigned[i] = stated;
      claimed.add(stated);
    }
  });

  // Rung 1 — endpoint match, in document order.
  for (const divider of dividers) {
    if (claimed.has(divider.uid)) continue;
    const index = destinations.findIndex((pair, i) =>
      assigned[i] === undefined &&
      (pair.delivery?.uid ?? null) === (divider.uid_delivery ?? null) &&
      (pair.collection?.uid ?? null) === (divider.uid_collection ?? null)
    );
    if (index === -1) continue;
    assigned[index] = divider.uid;
    claimed.add(divider.uid);
  }

  // Rung 2 — the forced leftover, and ONLY when it is forced.
  const freeDividers = dividers.filter((d) => !claimed.has(d.uid));
  const freePairs = assigned
    .map((uid, i) => (uid === undefined ? i : -1))
    .filter((i) => i >= 0);
  if (freeDividers.length === 1 && freePairs.length === 1) {
    assigned[freePairs[0]] = freeDividers[0].uid;
    claimed.add(freeDividers[0].uid);
    freeDividers.length = 0;
    freePairs.length = 0;
  }

  return {
    destinations: destinations.map((pair, i) => ({
      ...pair,
      uid: assigned[i] ?? pair.uid ?? fallbackUid(),
    })),
    orphanPairs: freePairs,
    orphanDividers: freeDividers.map((d) => d.uid),
  };
}

/** A destination section with its delivery/collection UIDs and child items. */
export interface DestinationGroup {
  uid_delivery: string;
  uid_collection: string;
  items: LineItem[];
  packing_list_delivery: LineItem[];
  packing_list_collection: LineItem[];
}

/**
 * Slice the flat items array into destination sections.
 */
export function groupByDestination(
  items: LineItem[],
  fallbackDeliveryUid: string,
  fallbackCollectionUid?: string,
): DestinationGroup[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const collectionFallback = fallbackCollectionUid || fallbackDeliveryUid;

  const groups: DestinationGroup[] = [];
  let current: DestinationGroup | null = null;

  for (const item of items) {
    if (item.type === "destination") {
      if (current) groups.push(current);
      current = {
        uid_delivery: item.uid_delivery || fallbackDeliveryUid,
        uid_collection: item.uid_collection || collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
      continue;
    }

    if (!current) {
      current = {
        uid_delivery: fallbackDeliveryUid,
        uid_collection: collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
    }

    current.items.push(item);

    if (DELIVERY_TYPES.has(item.type) && item.uid) {
      current.packing_list_delivery.push(item);
    }
    if (COLLECTION_TYPES.has(item.type) && item.uid) {
      current.packing_list_collection.push(item);
    }
  }

  if (current) groups.push(current);

  if (groups.length === 0) {
    return [{
      uid_delivery: fallbackDeliveryUid,
      uid_collection: collectionFallback,
      items: [],
      packing_list_delivery: [],
      packing_list_collection: [],
    }];
  }

  return groups;
}

/**
 * Collect the child product items belonging to a collapsible section.
 *
 * Destination / group: walk forward to the next divider of the same or
 * outer level, collecting every line item.
 *
 * Product: walk only its own contiguous subtree (via `getItemSubtreeRange`)
 * and return the immediate children (`path.at(-2) === item.uid`). Under the
 * within-parent uniqueness invariant, `path.at(-2) === uid` is unambiguous
 * inside the subtree; constraining to the subtree range protects against
 * accidental cross-parent collisions if an upstream invariant violation
 * slips through.
 */
export function getGroupItems(items: LineItem[], index: number): LineItem[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  if (item.type === "destination") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      if (items[i].type === "group") continue;
      result.push(items[i]);
    }
    return result;
  }

  if (item.type === "group") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      result.push(items[i]);
    }
    return result;
  }

  const range = getItemSubtreeRange(items, index);
  const result: LineItem[] = [];
  for (let i = range.startIndex + 1; i <= range.endIndex; i++) {
    if (items[i].path.at(-2) === item.uid) result.push(items[i]);
  }
  return result;
}

/**
 * Collect the indices of all items that should be removed when the item
 * at `index` is deleted — the item itself plus all its descendants.
 * Returns indices sorted ascending.
 */
export function getRemovalIndices(items: LineItem[], index: number): number[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  // Destination: self + everything until the next destination
  if (item.type === "destination") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Group: self + everything until the next group or destination
  if (item.type === "group") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Product: self + descendants. Under the depth-first contiguity invariant,
  // a product's full subtree is the contiguous range from `index` to the last
  // item whose path extends this item's path.
  const range = getItemSubtreeRange(items, index);
  const result: number[] = [];
  for (let i = range.startIndex; i <= range.endIndex; i++) result.push(i);
  return result;
}

/** Count and pricing totals for a collapsed destination or group section. */
export interface GroupTotalsResult {
  count: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  total_cents: number;
}

/**
 * Get count and pricing totals for a collapsed section.
 */
export function getGroupTotals(
  items: LineItem[],
  index: number,
  taxes: Tax[],
): GroupTotalsResult {
  const children = getGroupItems(items, index);
  if (children.length === 0) {
    return { count: 0, subtotal_cents: 0, subtotal_discounted_cents: 0, total_cents: 0 };
  }

  const { subtotal_cents, subtotal_discounted_cents, total_cents } = calculateOrderTotals(
    children,
    taxes,
  );
  return { count: children.length, subtotal_cents, subtotal_discounted_cents, total_cents };
}

/** An expanded packing list entry preserving group context. */
export interface PackingListItem {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  stock_method: string;
  group_name: string | null;
}

/**
 * Build a packing list from order line items.
 *
 * When `consolidated` is true, deduplicates by product UID and sums quantities
 * (delegates to {@link consolidateItems}). When false (default), returns
 * expanded entries with `group_name` preserved.
 *
 * Pass `destinationUid` to scope to a single destination; omit for the full order.
 *
 * Excludes structural rows, surcharges, transaction fees, and services.
 */
export function buildPackingList(
  items: LineItem[],
  consolidated?: boolean,
  destinationUid?: string,
): PackingListItem[] | ConsolidatedItem[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  // Scope to destination if requested
  let scoped: LineItem[];
  if (destinationUid) {
    scoped = [];
    let inDestination = false;
    for (const item of items) {
      if (item.type === "destination") {
        inDestination = item.uid_delivery === destinationUid ||
          item.uid_collection === destinationUid;
        continue;
      }
      if (inDestination) scoped.push(item);
    }
  } else {
    scoped = items;
  }

  // Filter to packing-list-eligible items
  const filtered = scoped.filter(
    (item) => item.uid && PACKING_LIST_ITEM_TYPES.has(item.type),
  );

  if (consolidated) {
    return consolidateItems(filtered);
  }

  // Expanded: walk the scoped array to track current group name
  const result: PackingListItem[] = [];
  let currentGroup: string | null = null;

  for (const item of scoped) {
    if (item.type === "group") {
      currentGroup = item.name ?? null;
      continue;
    }
    if (item.type === "destination") {
      currentGroup = null;
      continue;
    }
    if (!item.uid || !PACKING_LIST_ITEM_TYPES.has(item.type)) continue;

    result.push({
      uid: item.uid,
      name: item.name || "",
      type: item.type || "",
      quantity: item.quantity || 0,
      stock_method: item.stock_method || "none",
      group_name: currentGroup,
    });
  }

  return result;
}
