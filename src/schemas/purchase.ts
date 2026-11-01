/**
 * Purchase document schema — Firestore collection: `purchases`
 *
 * What CFS ORDERED from a supplier: one ITEM per thing ordered, each with the
 * quantity and the amount agreed. It moves nothing. api-cloudrun#1210 split a
 * `purchase` movement, which used to be the order, the delivery, the bill and
 * (through Xero) the debt all at once, into four facts with four homes:
 *
 * | fact     | home                                                   | moves                         |
 * |----------|--------------------------------------------------------|-------------------------------|
 * | ordered  | this document                                          | nothing                       |
 * | received | `purchase` movements naming it in `sources[]`          | `quantity_held`, basis, units |
 * | billed   | `purchase-bills` / `purchase-credits` naming it        | the Xero document             |
 * | paid     | `settlements` rows against a bill                      | the bill's `totals`           |
 *
 * The owner's real sequence is order → bill → delivery (days or weeks later,
 * possibly partial) → payment, and before this document nothing could hold
 * "billed, not received" — movement #3882 recorded three radios that had not
 * arrived. Design: api-cloudrun#1210.
 *
 * ## The shape is the out-of-service record's, on purpose
 *
 * `schemas/out-of-service.ts` is the package's parent-with-movements shape and this
 * copies every part of it:
 *
 * - **Its receipts name it in `sources[]`** and it finds them through
 *   `query_by_sources`. There is no `Movement.purchase` field and no back-list
 *   of movement ids here — the HISTORY of a purchase is the journal.
 * - **Co-written buckets** per item (`quantity_received`, `quantity_billed`,
 *   `quantity_canceled`), each written in the same transaction as the receipt,
 *   bill or close that moves it — the analogue of the record's `breakdown`.
 * - **A derived status** in the record's vocabulary (`active | complete |
 *   canceled`), authored by {@link derivePurchaseStatus} and refined here, so a
 *   document asserting one status and holding buckets that say another does not
 *   parse.
 *
 * ## Items take the invoice's shape (api-cloudrun#1407)
 *
 * `items[]` is discriminated on `type`, the house key for a stored line union
 * (`OrderDocItem`, `InvoiceDocItem`), and the ARM is per item — there is no
 * document-level `kind`, so one purchase may mix arms:
 *
 * | `type` | what CFS gets | custody | supply | priced |
 * |---|---|---|---|---|
 * | `buy` | ownership | receipts raise `quantity_held` and basis | `inbound` until received | flat |
 * | `subrent` | units for a hire window | `subrent_in` / `subrent_out`, never owned | `subrent` over `dates` | flat or time |
 * | `charge` | a service with no custody — a carrier line on an owned device, freight, a fee | none | none | flat or time |
 *
 * (`usage` and `direct` retired into `charge`, and the nested `SubrentBilling`
 * union into the price rule below — purchases-as-documents Phase 2.)
 *
 * Each item carries its own **row identity** (`uid`, and `path` = `[uid]`
 * until a divider type exists — the writer is its one author), so one product
 * may sit on two items: a buy plus a re-order, or two hire windows. Bills and
 * credits name an item by `path` (`path_purchase_item`), the way an invoice line
 * names its order line.
 *
 * Each item also carries its own **posting** — `coa_posting` and
 * `uid_tracking_category`, stamped at write rather than worked out at push.
 * The account is constrained per arm: a buy posts to an inventory asset
 * account (`COA_ASSET_CODES`), a subrent to a Direct Costs account
 * (`COA_COST_CODES`), a charge to any account. Both are `propagate: true`, so a
 * bill item follows its purchase item's posting until an operator changes it
 * there.
 *
 * ## Money — flat lines state a total, time lines carry rates
 *
 * Every item snapshots the formula it is priced by
 * (`price.price_formula = { uid, name, basis }`, see {@link PurchaseLinePrice}):
 *
 * - **flat** — `amount_cents` is what the whole item costs, NET of any supplier
 *   discount, integer cents, and `price.rates` is empty. The k-th receipt or
 *   bill against an item is priced by `cumulativeShareCents`
 *   (`@cfs/core/utils/purchases`), which rounds the CUMULATIVE share once, so the
 *   partials sum to `amount_cents` exactly with no remainder rule. There is no
 *   stored per-unit rate: measured on prod, most buys cost a total that does
 *   not divide by their quantity, and no reader needs one (`perUnitCostAt4dp`
 *   derives the display rate).
 * - **time** — `amount_cents: null` and `price.rates` holds the rates in force
 *   when the line was raised. What it costs is decided by its bills, priced
 *   from the units' charge windows (`pricePurchaseDocument`).
 *
 * A per-line REFINE ({@link purchaseLineMoneyIssues}) rather than union arms,
 * because `basis` cuts across all three types; arms would split each in two.
 * It also makes `quantity_billed` null exactly on time lines: billed is a
 * co-written bucket only on flat lines, and a time line resolves on custody
 * (Q7). Over-billing is never refused (D5) — the purchase↔bill diff flags it.
 *
 * `total_cents` is the COMMITTED amount (owner, 2026-10-30): Σ of the flat
 * lines' amounts. A time line adds 0; what was billed against it is its bills'
 * totals.
 *
 * There is no tax anywhere on a purchase (owner, 2026-10-05): stock bought for
 * sale or rent is bought resale-exempt and the tax is collected from the end
 * user, so `priceDocument` never runs here.
 *
 * The document stays one `z.strictObject` with a `superRefine` rather than a
 * root `discriminatedUnion`: no registered document schema has one, and the
 * column walker, `getInitialValues`, `getTestDoc` and the stored-defaults walk
 * all assume a root object.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid, OutOfServiceId, ThreadId, UnitId } from "./_uid.ts";
import { chicagoInstant, chicagoStartOfDay } from "./_datetime.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import {
  ActorRef,
  type ActorRefType,
  COAAssetEnum,
  type COAAssetType,
  COACostEnum,
  type COACostType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { Discount, DiscountInput, type DiscountInputType, type DiscountType } from "./order.ts";
import {
  type PriceFormulaBasis,
  type PriceFormulaRef,
  PriceFormulaRefSchema,
  RateKey,
  type RateSnapshotType,
  RateSnapshotSchema,
} from "./price-formula.ts";
import {
  allocationUnitsIssue,
  MovementAllocationInput,
  type MovementAllocationInputType,
  MovementUnitInput,
  type MovementUnitInputType,
} from "./transaction.ts";

// ── Status ───────────────────────────────────────────────────────

/**
 * Derived by {@link derivePurchaseStatus}, never client-set. The out-of-service
 * vocabulary, for the reason `OOS_STATUSES` gives: orders, bookings and cards
 * all say `active` for "in progress".
 *
 * Partial progress — some received, some billed — is read off the buckets, not
 * encoded here. A status per stage (`partially_received`, `billed`, …) would be
 * a second rendering of numbers the item already carries.
 */
export const PURCHASE_STATUSES = ["active", "complete", "canceled"] as const;
/** Allowed purchase statuses. See {@link PURCHASE_STATUSES}. */
export type PurchaseStatusType = typeof PURCHASE_STATUSES[number];
/** Zod schema for PurchaseStatusType. */
export const PurchaseStatusEnum: z.ZodType<PurchaseStatusType> = z.enum(PURCHASE_STATUSES);

// ── Item type ────────────────────────────────────────────────────

/**
 * The item arms — see the module docblock. `buy` is FIRST so `getInitialValues`
 * seeds a buy.
 *
 * 🔴 **Closed, and read through exhaustive switches.** Every reader that
 * branches on an item's arm switches over this union with a `never` default
 * (`purchaseItemSupplies`, `purchaseItemResolved`, …), so a fourth member is a
 * compile error at every one of them rather than a silent fall-through into
 * the buy branch.
 *
 * Explicit tuple type rather than `as const` alone: core#43 is JSR's npm
 * `.d.ts` emit truncating an inferred tuple.
 */
export const PURCHASE_ITEM_TYPES: readonly ["buy", "subrent", "charge"] = ["buy", "subrent", "charge"];
/** One {@link PURCHASE_ITEM_TYPES} member. */
export type PurchaseItemTypeType = typeof PURCHASE_ITEM_TYPES[number];
/** Zod schema for PurchaseItemTypeType. */
export const PurchaseItemTypeEnum: z.ZodType<PurchaseItemTypeType> = z.enum(PURCHASE_ITEM_TYPES);

/**
 * The arms that ORDER a product (a required `uid_product`). A `charge` line's
 * `uid_product` is attribution only, so it is not one.
 */
export const PURCHASE_PRODUCT_ITEM_TYPES: readonly ["buy", "subrent"] = ["buy", "subrent"];
/** One {@link PURCHASE_PRODUCT_ITEM_TYPES} member. */
export type PurchaseProductItemTypeType = typeof PURCHASE_PRODUCT_ITEM_TYPES[number];

// ── Pieces ───────────────────────────────────────────────────────

/**
 * A line's span. On a subrent, the hire window: `start` is when the units
 * come; `end` is when they are due back to the SUPPLIER, not when the customer
 * returns them. On a charge, the span a span-metered formula reads (Verizon:
 * from the line's start to its end, less suspensions).
 *
 * `end: null` is open-ended — `+∞` in availability as on bookings and
 * out-of-service records (api-cloudrun#1392). The hire window doubles as the
 * expected delivery: a subrent item has no separate `expected_date`.
 *
 * Named `dates` after out-of-service, bookings and cards. The object carries no
 * label of its own; its children are labelled.
 */
export interface PurchaseItemDates {
  start: string;
  end: string | null;
}

/** Zod schema for PurchaseItemDates. */
export const PurchaseItemDatesSchema: z.ZodType<PurchaseItemDates> = z.strictObject({
  start: chicagoInstant().meta({ column: true, label: "Start" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "End" }),
});

/**
 * How a purchase line is priced (purchases-as-documents Phase 2 rulings 1, 2,
 * 7): the formula it is priced by, the rates it snapshots, and a supplier
 * discount.
 *
 * - A **flat** line (`price_formula.basis === "flat"`: a buy, a fixed-cost
 *   subrent, freight or a fee) states its WHOLE cost in the line's
 *   `amount_cents` and carries `rates: []`. Measured: most stored buys cost a
 *   total that does not divide by their quantity, and every reader slices the
 *   total with `cumulativeShareCents`, so no per-unit rate is stored.
 * - A **time** line (Vision's "weekly while on", Verizon's "monthly unless
 *   suspended") has `amount_cents: null` and the rates in force when it was
 *   raised (Q13); what it costs is decided by the bills, priced from the
 *   units' charge windows.
 *
 * `discount` is core's `Discount`. On a time line the engine applies it; on a
 * flat line it records what came off the operator's GROSS, and `amount_cents`
 * is the NET — what CFS pays, which receipts, basis and bills slice.
 *
 * There is no subtotal/discounted/taxes/total triple: purchases are
 * resale-exempt (no tax), and gross = `amount_cents + discount.amount_cents`.
 */
export interface PurchaseLinePrice {
  price_formula: PriceFormulaRef;
  rates: RateSnapshotType[];
  discount: DiscountType | null;
}

/** Zod schema for {@link PurchaseLinePrice}. */
export const PurchaseLinePriceSchema: z.ZodType<PurchaseLinePrice> = z.strictObject({
  price_formula: PriceFormulaRefSchema.meta({ propagate: true }),
  // One value to the purchase → bill merge, like `charge_windows`: its entries
  // carry no `uid`, and a rate set is overridden or followed as a whole.
  rates: z.array(RateSnapshotSchema).meta({ shared: "value", propagate: true, label: "Rate" }),
  discount: Discount.nullable().meta({ propagate: true, label: "Discount" }),
});

/**
 * The single-document money rule (ruling 1), shared by every arm and by the
 * bill line: a flat line states an amount and no rates, a time line states
 * rates and — on a purchase — no amount. A refine rather than a union arm
 * because `basis` cuts across all three line types; arms would split each in
 * two.
 */
export function purchaseLineMoneyIssues(
  item: { price?: PurchaseLinePrice; amount_cents: number | null; quantity_billed?: number | null },
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const basis = item.price?.price_formula.basis ?? "flat";
  const rates = item.price?.rates ?? [];
  if (basis === "flat") {
    if (item.amount_cents === null) issues.push({ path: ["amount_cents"], message: "a flat line states its amount" });
    if (rates.length > 0) issues.push({ path: ["price", "rates"], message: "a flat line carries no rates" });
    if (item.quantity_billed === null) {
      issues.push({ path: ["quantity_billed"], message: "a flat line counts what is billed" });
    }
  } else {
    if (item.amount_cents !== null) {
      issues.push({ path: ["amount_cents"], message: "a time line's cost is decided by its bills; amount_cents is null" });
    }
    if (rates.length === 0) issues.push({ path: ["price", "rates"], message: "a time line snapshots its rates" });
    if (item.quantity_billed !== undefined && item.quantity_billed !== null) {
      issues.push({ path: ["quantity_billed"], message: "a time line resolves on custody, not on a billed count; quantity_billed is null" });
    }
  }
  return issues;
}

function addIssues(issues: { path: (string | number)[]; message: string }[], ctx: z.RefinementCtx): void {
  for (const issue of issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
}

/** The basis of an item's formula; a buy written before `price` existed is flat. */
export function purchaseItemBasis(item: { price?: PurchaseLinePrice }): PriceFormulaBasis {
  return item.price?.price_formula.basis ?? "flat";
}

/**
 * One landed cost on a BUY item: freight, duty or a fee the operator attributes
 * to the units still to arrive (api-cloudrun#1227). It is cost basis, so it
 * reaches the ledger only through the receipts that price it.
 *
 * ⚠️ **It lives on the PURCHASE ITEM, not on the bill.** 276 of 299 historic
 * bills are linked card-purchase bills with no charge items, and the receipt
 * transaction reads the purchase, never its bills. The Xero side is unchanged:
 * the freight still posts through a bill's charge item to its own account.
 * `uid_purchase_bill` is traceability only.
 *
 * **What it spreads over is fixed at entry.** `quantity` is the item's
 * outstanding count when the entry was made, and `received_at_entry` is
 * `quantity_received` at that moment. The k-th receipt prices the units received
 * since the entry, `clamp(received − received_at_entry, 0, quantity)`, with
 * `cumulativeShareCents`, so the shares telescope to `amount_cents` exactly when
 * every outstanding unit arrives (`purchaseLineReceiptTargetCents`,
 * `@cfs/core/utils/purchases`).
 *
 * **Append-only, the way the item amount is.** An entry no receipt has priced
 * (`quantity_received ≤ received_at_entry`) is editable and removable. One that
 * a receipt has priced any part of is frozen. A short close still proceeds:
 * the unpriced remainder is DERIVED (`strandedLandedCents`), never stored. The
 * post-receipt re-base waits on depreciation (api-cloudrun#1388).
 */
export interface PurchaseLandedCost {
  /** Array-member id, minted by the writer (`crypto.randomUUID()`). */
  uid: string;
  description: string;
  /** What this entry adds to the item's units, integer cents. */
  amount_cents: number;
  /** The item's outstanding count (`quantity − canceled − received`) when the entry was made. */
  quantity: number;
  /** The item's `quantity_received` when the entry was made. */
  received_at_entry: number;
  /** The bill this cost was charged on, or `null`. Traceability only; nothing reads it to price. */
  uid_purchase_bill: string | null;
}

/** Zod schema for PurchaseLandedCost. */
export const PurchaseLandedCostSchema: z.ZodType<PurchaseLandedCost> = z.strictObject({
  uid: z.uuid(),
  description: z.string().min(1).max(200).meta({ column: true, label: "Description" }),
  amount_cents: z.int().min(1).meta({ column: true, label: "Amount" }),
  quantity: z.int().min(1).meta({ column: true, label: "Spread Over" }),
  received_at_entry: z.int().min(0),
  uid_purchase_bill: FirestoreId.nullable(),
});

// ── Items ────────────────────────────────────────────────────────

/**
 * The keys every purchase item carries. The posting pair and `price` are
 * `propagate: true` so a bill line follows its purchase line until an operator
 * changes it there (D5); `name` is the product's name when ordered (or a
 * charge's description), a point-in-time snapshot like `Movement.supplier`.
 */
interface PurchaseItemBase {
  /** Row identity, minted by the writer. Never a product uid: one product may sit on two items. */
  uid: string;
  /** `[uid]` — self-inclusive and flat until a divider type exists. */
  path: string[];
  name: string;
  /** The Xero account the item posts to — per arm, see the module docblock. */
  coa_posting: COACodeType;
  /** The tracking category (`tracking-categories/{uid}`), or `null` for untracked. */
  uid_tracking_category: string | null;
}

/** A BUY item — ownership of `quantity` units of one product. Always flat. */
export interface BuyItem extends PurchaseItemBase {
  type: "buy";
  uid_product: string;
  quantity: number;
  /** What the whole item costs, net, integer cents. */
  amount_cents: number;
  /**
   * The formula snapshot (always a flat one). Optional only until the Phase 5
   * backfill stamps it on the buys written before it existed; absent reads as
   * flat.
   */
  price?: PurchaseLinePrice;
  /** An inventory asset account: 1400 for a `sale` product, 1999 for a `rental`. */
  coa_posting: COAAssetType;
  /**
   * When the supplier says this item will arrive, or `null` when nobody said.
   * A calendar date. Inbound supply (`supplyFromPurchase`) reads it.
   */
  expected_date: string | null;
  /** Units received — Σ of the receipts naming this purchase for this item, net of reversals. */
  quantity_received: number;
  /**
   * Units billed — Σ of bill items minus Σ of credit items projecting this
   * item. May exceed what was ordered: over-billing is legal and flagged, never
   * refused (D5).
   */
  quantity_billed: number;
  /** Units that will never be received — set by a short close or a cancel. */
  quantity_canceled: number;
  /** Freight, duty and fees spread onto the units still to arrive ({@link PurchaseLandedCost}). */
  landed_costs: PurchaseLandedCost[];
}

/** A SUBRENT item — `quantity` units borrowed for a hire window and given back. Flat or time. */
export interface SubrentItem extends PurchaseItemBase {
  type: "subrent";
  uid_product: string;
  quantity: number;
  /** Net whole cost on a flat line; `null` on a time line (its bills decide it). */
  amount_cents: number | null;
  price: PurchaseLinePrice;
  /** A Direct Costs account; 5100 by default. */
  coa_posting: COACostType;
  dates: PurchaseItemDates;
  quantity_received: number;
  /** Units billed on a flat line; `null` on a time line, which resolves on custody alone (Q7). */
  quantity_billed: number | null;
  quantity_canceled: number;
  /**
   * Units no longer owed to the supplier: Σ of the `subrent_out` (handed back)
   * and `return_to_supplier` (lost or damaged, settled to the supplier's
   * account) movements naming this purchase for this item, net of reversals.
   * Never more than received.
   *
   * ⚠️ **A settled unit counts as returned** (api-cloudrun#1360, D3). Every
   * reader means "no longer owed" — `remainingToReturn`, the return card,
   * `derivePurchaseStatus` and supply — so the "Returned" column includes units
   * that were never physically handed back.
   */
  quantity_returned: number;
  /**
   * The orders this item was raised for, possibly none. For margin and for
   * raising a subrent from an order's shortage; it is NOT a reservation, and
   * the units stay fungible across every booking.
   */
  uid_orders: string[];
  /**
   * May the supplier's Xero bills and card payments be LINKED to this line
   * automatically (the poll and the ACCPAY webhook)? D5's auto-link predicate.
   */
  auto_link: boolean;
  /**
   * The units this line covers (`units/{uid}`), each named once. The LINE names
   * the unit and the unit names nothing back — the invoice ↔ out-of-service
   * direction (`uid_out_of_service`), so offering a line for an uncovered
   * window and creating it writes the purchase alone. A unit's charge window
   * is covered by this line where it overlaps the line's `dates`
   * (`purchaseLineCoversWindow`). Mirrored on `Purchase.query_by_units`.
   * Not shared with a bill line, which states its own `units` (D5).
   */
  uid_units: string[];
}

/**
 * A CHARGE item — something CFS pays for with no custody: a carrier line on a
 * device CFS owns (Verizon), freight, a fee, Vision's standing history line.
 * Flat (freight: one amount) or time (a carrier line, priced from the device's
 * charge windows).
 *
 * Attribution, as on a bill's charge item (api-cloudrun#1360, #1364):
 * `uid_product` is the product the spend is for, `uid_out_of_service` the
 * record a loss or damage charge is for. Both permanently optional — freight
 * attributes nothing.
 */
export interface ChargeItem extends PurchaseItemBase {
  type: "charge";
  quantity: number;
  /** Net whole cost on a flat line; `null` on a time line. */
  amount_cents: number | null;
  price: PurchaseLinePrice;
  /** The span a span-metered formula reads, or `null`. */
  dates: PurchaseItemDates | null;
  /** Units billed on a flat line; `null` on a time line. */
  quantity_billed: number | null;
  /** Units a close or cancel stopped. A time line resolves only once all are. */
  quantity_canceled: number;
  auto_link: boolean;
  /** See {@link SubrentItem.uid_units} — a Verizon line names its device. `[]` for freight. */
  uid_units: string[];
  uid_product?: string;
  uid_out_of_service?: string;
}

/** Union of every purchase item arm, discriminated on `type`. */
export type PurchaseItem = BuyItem | SubrentItem | ChargeItem;

// The shared head, one instance per key. `name` is `propagate: true`: a bill
// item's name follows its purchase item's until an operator changes it there.
const itemHead = {
  uid: ItemUid,
  path: z.array(ItemUid),
  name: z.string().min(1).max(4000).meta({ column: true, label: "Name", propagate: true }),
} as const;
const trackingKey = FirestoreId.nullable().meta({ propagate: true });

// The co-written buckets, each `propagate: false` — a bill item's `quantity` is
// the units it BILLS, a homonym of the purchase item's ordered `quantity`, and
// these buckets have no counterpart on a bill at all.
const quantityKey = z.int().min(1).meta({ column: true, label: "Quantity", propagate: false });
const amountKey = z.int().min(0).meta({ column: true, label: "Amount", propagate: false });
const receivedKey = z.int().min(0).meta({ column: true, label: "Received" });
const billedKey = z.int().min(0).meta({ column: true, label: "Billed" });
const canceledKey = z.int().min(0).meta({ column: true, label: "Canceled" });
const productKey = FirestoreId.meta({ propagate: true });
const autoLinkKey = z.boolean().meta({ column: true, label: "Auto-link" });
const unitsKey = z.array(UnitId);

function uniqueUnitsIssue(units: readonly string[], ctx: z.RefinementCtx): void {
  if (new Set(units).size !== units.length) {
    ctx.addIssue({ code: "custom", path: ["uid_units"], message: "a line names each unit once" });
  }
}

function bucketIssues(
  item: { quantity: number; quantity_received?: number; quantity_canceled: number },
  ctx: z.RefinementCtx,
): void {
  // Received is bounded by what is still coming — the out-of-service
  // `Σ breakdown ≤ quantity`. Billing has NO ceiling: over-billing is legal and
  // flagged by the purchase↔bill diff, never refused (D5, reversing #1396).
  if ((item.quantity_received ?? 0) + item.quantity_canceled > item.quantity) {
    ctx.addIssue({
      code: "custom",
      path: [item.quantity_received === undefined ? "quantity_canceled" : "quantity_received"],
      message: `received ${item.quantity_received ?? 0} + canceled ${item.quantity_canceled} exceeds the ${item.quantity} ordered`,
    });
  }
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`. Each arm's refine sits HERE, on the Inner const: a
// refine on an exported alias never runs inside the union (`invoice.ts`,
// `checkZeroPricedAmount`).
const BuyItemInner = z.strictObject({
  type: z.literal("buy").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  uid_product: productKey,
  quantity: quantityKey,
  amount_cents: amountKey,
  // Optional until the Phase 5 backfill: 413 stored buys predate it.
  price: PurchaseLinePriceSchema.optional(),
  coa_posting: COAAssetEnum.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  expected_date: chicagoStartOfDay().nullable().meta({ column: true, label: "Expected" }),
  quantity_received: receivedKey,
  quantity_billed: billedKey,
  quantity_canceled: canceledKey,
  landed_costs: z.array(PurchaseLandedCostSchema).meta({ label: "Landed Cost" }),
}).superRefine((item, ctx) => {
  bucketIssues(item, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  if (purchaseItemBasis(item) !== "flat") {
    ctx.addIssue({ code: "custom", path: ["price", "price_formula", "basis"], message: "a buy is priced flat" });
  }
  const entryUids = new Set<string>();
  item.landed_costs.forEach((entry, k) => {
    if (entryUids.has(entry.uid)) {
      ctx.addIssue({ code: "custom", path: ["landed_costs", k, "uid"], message: "a landed cost uid appears once per item" });
    }
    entryUids.add(entry.uid);
    // The units it spreads over had not arrived when it was entered, so they
    // fit inside what was ordered then. A later quantity cut must keep it so:
    // the writer re-bases an entry no receipt has priced, and refuses the cut
    // under a frozen one (a short close is the channel for "fewer will come").
    if (entry.received_at_entry + entry.quantity > item.quantity) {
      ctx.addIssue({
        code: "custom",
        path: ["landed_costs", k, "quantity"],
        message: `a landed cost spreads over ${entry.quantity} units after ${entry.received_at_entry} received, ` +
          `more than the ${item.quantity} ordered`,
      });
    }
  });
});

const SubrentItemInner = z.strictObject({
  type: z.literal("subrent").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  uid_product: productKey,
  quantity: quantityKey,
  amount_cents: amountKey.nullable(),
  price: PurchaseLinePriceSchema,
  coa_posting: COACostEnum.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  // `propagate: false`: a bill line's `dates` is the span it BILLED, never the
  // hire window — D5's "windows never merge" (a purchase extension must not
  // rewrite what the supplier already billed).
  dates: PurchaseItemDatesSchema.meta({ propagate: false }),
  quantity_received: receivedKey,
  quantity_billed: billedKey.nullable(),
  quantity_canceled: canceledKey,
  quantity_returned: z.int().min(0).meta({ column: true, label: "Returned" }),
  uid_orders: z.array(FirestoreId),
  auto_link: autoLinkKey,
  uid_units: unitsKey,
}).superRefine((item, ctx) => {
  bucketIssues(item, ctx);
  uniqueUnitsIssue(item.uid_units, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  // A unit can only go back to the supplier once it has come in.
  if (item.quantity_returned > item.quantity_received) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_returned"],
      message: `returned ${item.quantity_returned} exceeds the ${item.quantity_received} received`,
    });
  }
  if (item.dates.end !== null && Date.parse(item.dates.end) < Date.parse(item.dates.start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a hire ends at or after it starts" });
  }
});

const ChargeItemInner = z.strictObject({
  type: z.literal("charge").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  quantity: quantityKey,
  amount_cents: amountKey.nullable(),
  price: PurchaseLinePriceSchema,
  coa_posting: COACode.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  dates: PurchaseItemDatesSchema.nullable().meta({ propagate: false }),
  quantity_billed: billedKey.nullable(),
  quantity_canceled: canceledKey,
  auto_link: autoLinkKey,
  uid_units: unitsKey,
  // Permanent `.optional()`: freight and fees attribute nothing (api-cloudrun#1360).
  uid_product: FirestoreId.optional().meta({ propagate: true }),
  // A `mark_lost` record's id is a MovementId, so the union, not FirestoreId.
  uid_out_of_service: OutOfServiceId.optional().meta({ propagate: true }),
}).superRefine((item, ctx) => {
  bucketIssues(item, ctx);
  uniqueUnitsIssue(item.uid_units, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  if (item.dates !== null && item.dates.end !== null && Date.parse(item.dates.end) < Date.parse(item.dates.start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a span ends at or after it starts" });
  }
});

/** Zod schema for BuyItem. */
export const BuyItemSchema: z.ZodType<BuyItem> = BuyItemInner;
/** Zod schema for SubrentItem. */
export const SubrentItemSchema: z.ZodType<SubrentItem> = SubrentItemInner;
/** Zod schema for ChargeItem. */
export const ChargeItemSchema: z.ZodType<ChargeItem> = ChargeItemInner;

/** Zod schema for any purchase item — discriminated on `type`. */
export const PurchaseItemSchema: z.ZodType<PurchaseItem> = z.discriminatedUnion("type", [
  BuyItemInner,
  SubrentItemInner,
  ChargeItemInner,
]);

// ── Per-arm rules ────────────────────────────────────────────────
//
// Each is an exhaustive switch with a `never` default, so a fourth item type is
// a compile error here rather than a silent fall-through (D7). They live in the
// schema module because the document refine calls them and `utils/` imports
// `schemas/` one way only; `@cfs/core/utils/purchases` re-exports them.

function unreachableItem(item: never): never {
  throw new Error(`unknown purchase item type: ${JSON.stringify(item)}`);
}

/** Has a flat line been billed for everything not canceled? Over-billed counts as billed in full. */
function billedInFull(item: { quantity: number; quantity_canceled: number; quantity_billed: number | null }): boolean {
  return (item.quantity_billed ?? 0) + item.quantity_canceled >= item.quantity;
}

/**
 * Has this item nothing left to happen?
 *
 * - **buy** — every unit received or canceled, and billed for at least what was
 *   not canceled (over-billing is flagged, not held open).
 * - **subrent** — every unit received or canceled, every unit received gone
 *   back (a hire with units still in CFS's custody is not finished), and on a
 *   flat line billed in full. A TIME line resolves on custody alone (Q7): it
 *   bills windows as they accrue, with no count to close.
 * - **charge** — a flat one when billed or canceled in full; a time one only
 *   once canceled in full, since a carrier line accrues for as long as it lives.
 *
 * Payment is the bill's business and holds nothing open.
 */
export function purchaseItemResolved(item: PurchaseItem): boolean {
  switch (item.type) {
    case "buy":
      return item.quantity_received + item.quantity_canceled === item.quantity && billedInFull(item);
    case "subrent":
      return item.quantity_received + item.quantity_canceled === item.quantity &&
        item.quantity_returned === item.quantity_received &&
        (purchaseItemBasis(item) === "time" || billedInFull(item));
    case "charge":
      return purchaseItemBasis(item) === "time" ? item.quantity_canceled === item.quantity : billedInFull(item);
    default:
      return unreachableItem(item);
  }
}

/** Was this item canceled in full — nothing will come and nothing is billed? */
export function purchaseItemCanceled(item: PurchaseItem): boolean {
  switch (item.type) {
    case "buy":
    case "subrent":
    case "charge":
      return item.quantity_canceled === item.quantity && (item.quantity_billed ?? 0) === 0;
    default:
      return unreachableItem(item);
  }
}

/**
 * The amount an item COMMITS up front — the term of the purchase's
 * `total_cents` (owner, 2026-10-30): a flat line's net amount, and 0 for a time
 * line, whose cost is decided as it accrues.
 */
export function purchaseItemCommittedCents(item: PurchaseItem): number {
  switch (item.type) {
    case "buy":
      return item.amount_cents;
    case "subrent":
    case "charge":
      return item.amount_cents ?? 0;
    default:
      return unreachableItem(item);
  }
}

/**
 * The purchase's status, derived — never client-set.
 *
 * - `canceled` when every item is canceled in full ({@link purchaseItemCanceled}).
 *   A cancel is a close with nothing received.
 * - `complete` when every item is resolved ({@link purchaseItemResolved}).
 * - `active` otherwise.
 *
 * ⚠️ **Received in full but unbilled is `active`, deliberately.** The owner's
 * sequence bills before delivery as often as after, and a purchase that reads
 * `complete` while a bill is still owed hides exactly the work the split exists
 * to show.
 */
export function derivePurchaseStatus(purchase: Pick<Purchase, "items">): PurchaseStatusType {
  const { items } = purchase;
  if (items.length === 0) return "active";
  if (items.every(purchaseItemCanceled)) return "canceled";
  return items.every(purchaseItemResolved) ? "complete" : "active";
}

/** The product an item ORDERS, or `undefined` — a charge's `uid_product` is attribution, not an order. */
export function purchaseItemProduct(item: PurchaseItem): string | undefined {
  switch (item.type) {
    case "buy":
    case "subrent":
      return item.uid_product;
    case "charge":
      return undefined;
    default:
      return unreachableItem(item);
  }
}

/**
 * Derive `query_by_products` — the distinct products the items ORDER, in first
 * appearance order. A charge's attribution is not an order and is left out.
 * The one author of the mirror, called by every writer.
 */
export function deriveQueryByProducts(items: readonly PurchaseItem[]): string[] {
  return [...new Set(items.map(purchaseItemProduct).filter((u): u is string => u !== undefined))];
}

/** Derive `query_by_orders` — the distinct union of the subrent items' `uid_orders`, in first-seen order. */
export function deriveQueryByOrders(items: readonly PurchaseItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.type === "subrent" ? i.uid_orders : [])))];
}

/** Derive `query_by_units` — the distinct units the subrent and charge lines cover, sorted. */
export function deriveQueryByUnits(items: readonly PurchaseItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.type === "buy" ? [] : i.uid_units)))].sort();
}

/** Derive `query_by_item_types` — the distinct item types, in first-seen order. */
export function deriveQueryByItemTypes(items: readonly Pick<PurchaseItem, "type">[]): PurchaseItemTypeType[] {
  return [...new Set(items.map((i) => i.type))];
}

/**
 * A purchase line named from elsewhere — its purchase and its row identity
 * (`path`), the way a bill line names its purchase line. A report row states
 * which line covered a unit's window with it; nothing STORES it on a unit.
 */
export interface PurchaseLineRef {
  uid_purchase: string;
  path: string[];
}

/** Zod schema for {@link PurchaseLineRef}. */
export const PurchaseLineRefSchema: z.ZodType<PurchaseLineRef> = z.strictObject({
  uid_purchase: FirestoreId,
  path: z.array(ItemUid).min(1),
});

// ── Document ─────────────────────────────────────────────────────

/** A purchase order placed with a supplier. */
export interface Purchase {
  uid: string;
  /** Monotonic per-collection sequence (`counters/purchases`). Displayed `PO-n`; stored bare. */
  number: number;
  status: PurchaseStatusType;
  /**
   * Who CFS is buying from — a point-in-time `{uid, name}` snapshot. Every
   * receipt's `Movement.supplier` and every bill's `supplier` must equal it;
   * the writers assert that, since it spans documents.
   */
  supplier: UidNameRefType;
  /** The store the goods are coming to — a `{uid, name}` snapshot. */
  store: UidNameRefType;
  /** The day the order was placed. A calendar date. */
  date: string;
  date_fs: FirestoreTimestampType;
  /** The supplier's order or quote number, or `null`. */
  reference: string | null;
  /** Internal note, or `null` for none. */
  notes: string | null;
  items: PurchaseItem[];
  /** Σ {@link purchaseItemCommittedCents} — refined. */
  total_cents: number;
  /**
   * Mirror of the products the items order ({@link deriveQueryByProducts}), for
   * "which purchases name this product" as one `array-contains` — the stock
   * rebuild's supply read. Refused when it disagrees with the items.
   */
  query_by_products: string[];
  /** Mirror of the subrent items' `uid_orders` ({@link deriveQueryByOrders}): "which subrents were raised for this order". */
  query_by_orders: string[];
  /**
   * Mirror of the item types ({@link deriveQueryByItemTypes}) — "which
   * purchases hold a subrent" as one `array-contains`, replacing the retired
   * document `kind` (D3).
   */
  query_by_item_types: PurchaseItemTypeType[];
  /**
   * The bills raised against this purchase, co-written by every bill create
   * and void (D5), so the purchase → bill sync can point-get them inside the
   * purchase writer's transaction rather than range-read them. Optional only
   * until the Phase 5 backfill stamps it.
   */
  query_by_bills?: string[];
  /**
   * Mirror of the units the lines cover ({@link deriveQueryByUnits}) — "which
   * purchases cover this unit" as one `array-contains`, the read behind every
   * coverage question (`purchaseLineCoversWindow`, the uncovered-window offer).
   * The `Invoice.query_by_out_of_service` twin. Optional only until the Phase 5
   * backfill stamps it; every writer states it.
   */
  query_by_units?: string[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function sameMembers(mirror: readonly string[], derived: readonly string[]): boolean {
  const want = new Set(derived);
  return mirror.length === want.size && mirror.every((u) => want.has(u));
}

/**
 * The row-identity invariants an items array owes every reader (cfs-items),
 * asserted directly rather than through a recompute: each `uid` once, and each
 * `path` exactly `[uid]` — non-empty, self-inclusive, flat.
 */
function itemIdentityIssues(items: readonly { uid: string; path: readonly string[] }[], ctx: z.RefinementCtx): void {
  const uids = new Set<string>();
  items.forEach((item, i) => {
    if (uids.has(item.uid)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "uid"], message: "an item uid appears once per document" });
    }
    uids.add(item.uid);
    if (item.path.length !== 1 || item.path[0] !== item.uid) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path is [uid] — flat, self-inclusive" });
    }
  });
}

function checkPurchase(p: Purchase, ctx: z.RefinementCtx): void {
  itemIdentityIssues(p.items, ctx);
  const mirrors = [
    ["query_by_products", p.query_by_products, deriveQueryByProducts(p.items), "the products the items order"],
    ["query_by_orders", p.query_by_orders, deriveQueryByOrders(p.items), "the distinct uid_orders on the subrent items"],
    ["query_by_item_types", p.query_by_item_types, deriveQueryByItemTypes(p.items), "the distinct item types"],
  ] as const;
  for (const [key, mirror, derived, what] of mirrors) {
    if (!sameMembers(mirror, derived)) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} must list exactly ${what}` });
    }
  }
  if (p.query_by_units !== undefined && !sameMembers(p.query_by_units, deriveQueryByUnits(p.items))) {
    ctx.addIssue({ code: "custom", path: ["query_by_units"], message: "query_by_units must list exactly the units the lines cover" });
  }

  const total = p.items.reduce((sum, item) => sum + purchaseItemCommittedCents(item), 0);
  if (p.total_cents !== total) {
    ctx.addIssue({
      code: "custom",
      path: ["total_cents"],
      message: `total_cents ${p.total_cents} must equal the items' committed ${total}`,
    });
  }

  const derived = derivePurchaseStatus(p);
  if (p.status !== derived) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: `status "${p.status}" contradicts the items, which derive "${derived}"`,
    });
  }
}

// Root keys a bill or credit shares by NAME with the purchase, each a homonym:
// the bill's number, date and reference are its own, not copies of these.
// Declared so `classifySharedFields(PurchaseSchema, PurchaseBillSchema)` stays
// fail-closed (D5); nothing merges the pair yet.
const homonym = { propagate: false } as const;

/** Zod schema for Purchase. */
export const PurchaseSchema: z.ZodType<Purchase> = z.strictObject({
  uid: FirestoreId.meta(homonym),
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseDetail", serverSortVia: "number", ...homonym }),
  status: PurchaseStatusEnum.meta({ column: true, label: "Status", ...homonym }),
  supplier: UidNameRef.meta({ label: "Supplier", propagate: true }),
  store: UidNameRef.meta({ label: "Store" }),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date", ...homonym }),
  date_fs: FirestoreTimestamp.meta(homonym),
  reference: z.string().max(200).nullable().meta({ column: true, label: "Reference", ...homonym }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" }).nullable(),
  items: z.array(PurchaseItemSchema).min(1).meta({ label: "Item" }),
  total_cents: z.int().min(0).meta({ column: true, label: "Total", ...homonym }),
  query_by_products: z.array(FirestoreId).meta({ derived: true }),
  query_by_orders: z.array(FirestoreId).meta({ derived: true }),
  query_by_item_types: z.array(PurchaseItemTypeEnum).meta({ derived: true }),
  query_by_bills: z.array(FirestoreId).optional(),
  query_by_units: z.array(UnitId).optional(),
  uid_thread: ThreadId.optional().meta(homonym),
  version: z.int().min(0).default(0).meta(homonym),
  created_by: ActorRef.meta({ column: true, label: "Created By", ...homonym }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By", ...homonym }),
  // `.meta()` clones, so the shared `TimestampFields` instances stay untagged —
  // the order schema's spelling of the same homonym.
  created_at: TimestampFields.created_at.meta(homonym),
  updated_at: TimestampFields.updated_at.meta(homonym),
}).superRefine(checkPurchase).meta({
  title: "Purchase",
  collection: "purchases",
  displayDefaults: {
    columns: ["number", "date", "supplier.name", "status", "total_cents"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────

/**
 * One landed cost as the operator states it on a buy item. `quantity` and
 * `received_at_entry` are the server's, stamped from the stored item.
 *
 * `uid` names a stored entry to keep or edit. A uid the item does not hold
 * is a NEW entry stored under it (the manager mints one as it adds the entry, so
 * a re-send before the Firestore echo is the same entry), and absent mints one
 * server-side. Splitting one amount across several items is
 * `allocateLandedCostCents` (`@cfs/core/utils/purchases`), run by the client so
 * the preview it shows is the split it sends.
 */
export interface PurchaseLandedCostInputType {
  uid?: string;
  description: string;
  amount_cents: number;
  uid_purchase_bill?: string | null;
}

/** Zod schema for PurchaseLandedCostInputType. */
export const PurchaseLandedCostInput: z.ZodType<PurchaseLandedCostInputType> = z.object({
  uid: z.uuid().optional(),
  description: z.string().min(1).max(200),
  amount_cents: z.int().min(1),
  uid_purchase_bill: FirestoreId.nullable().optional(),
});

/**
 * How an operator prices an item input (ruling 1, 7). `uid_price_formula`
 * names the formula; absent takes the writer's default (a buy and a flat charge
 * Fixed; a subrent or a time charge the product's `cogs` activation entry's
 * formula, else Fixed). The writer snapshots the formula's name and basis.
 *
 * - `rates` — a time line's rates; absent takes the rates in force today on
 *   the product's activation entry. Refused on a flat line.
 * - `discount` — a supplier discount, `{ rate, type }`; the writer computes its
 *   `amount_cents`. On a flat line `amount_cents` is then the GROSS the
 *   operator states, and the stored amount is net of the discount.
 */
export interface PurchaseLinePriceInputType {
  uid_price_formula?: string;
  rates?: RateSnapshotType[];
  discount?: DiscountInputType | null;
}

/**
 * The keys every item input may carry. `uid` names a stored item to keep;
 * absent (or a uid the purchase does not hold) is a NEW item, minted by the
 * writer, so an update matches rows by identity rather than by product.
 *
 * `uid_tracking_category` takes the SAME rule as an order or invoice line's
 * (`resolveLinePosting`, `api-cloudrun/src/lib/lineDenorms.ts`): absent KEEPS
 * what is stored (a new item takes the product's category); `null` returns it to
 * the product's category — never "untracked"; a uid SETS it and must name a
 * live category. `coa_posting` is absent-KEEPS, value-SETS, with the writer's
 * default on a new item (D4): a buy's is `xeroPostingFor("purchase", …)`'s asset
 * account, a subrent's 5100, a charge's its cost entry's `coa_cost` when it
 * names a product with one.
 */
interface PurchaseItemInputBase {
  uid?: string;
  uid_tracking_category?: string | null;
  price?: PurchaseLinePriceInputType;
}

/** A buy item as an operator orders it — the buckets are the server's. */
export interface BuyItemInputType extends PurchaseItemInputBase {
  type: "buy";
  uid_product: string;
  quantity: number;
  /** The whole cost — GROSS when `price.discount` is set. */
  amount_cents: number;
  coa_posting?: COAAssetType;
  expected_date?: string | null;
  /**
   * The item's WHOLE landed-cost set. Absent keeps what is stored, so a client
   * that never names landed costs cannot erase them: this is a replacement, and
   * a default here would delete what the client did not restate. Present: a
   * stored entry missing from it is removed, which the writer refuses once a
   * receipt has priced it.
   */
  landed_costs?: PurchaseLandedCostInputType[];
}

/** A subrent item as an operator orders it. `amount_cents` on a flat line only (gross when discounted). */
export interface SubrentItemInputType extends PurchaseItemInputBase {
  type: "subrent";
  uid_product: string;
  quantity: number;
  amount_cents?: number | null;
  coa_posting?: COACostType;
  dates: PurchaseItemDates;
  /** The orders the item was raised for. Absent is `[]`: the writer states it. */
  uid_orders?: string[];
  /** Absent: `true` for a time line, `false` for a flat one. */
  auto_link?: boolean;
  /** The units the line covers. Absent keeps the stored list on an amend, `[]` on a create. */
  uid_units?: string[];
}

/** A charge item as an operator raises it. Its account is the operator's — there is no default. */
export interface ChargeItemInputType extends PurchaseItemInputBase {
  type: "charge";
  name: string;
  quantity?: number;
  amount_cents?: number | null;
  coa_posting: COACodeType;
  dates?: PurchaseItemDates | null;
  auto_link?: boolean;
  /** See {@link SubrentItemInputType.uid_units}. */
  uid_units?: string[];
  uid_product?: string;
  uid_out_of_service?: string;
}

/** Union of every item input arm. */
export type PurchaseItemInputType = BuyItemInputType | SubrentItemInputType | ChargeItemInputType;

const inputDates = z.object({ start: chicagoInstant(), end: chicagoInstant().nullable() });
const PurchaseLinePriceInput: z.ZodType<PurchaseLinePriceInputType> = z.object({
  uid_price_formula: FirestoreId.optional(),
  rates: z.array(z.object({ rate_key: RateKey, amount_cents: z.int().min(0) })).optional(),
  discount: DiscountInput.nullable().optional(),
});
const inputHead = {
  uid: ItemUid.optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
  price: PurchaseLinePriceInput.optional(),
};

function datesOrderIssue(dates: PurchaseItemDates | null | undefined, ctx: z.RefinementCtx): void {
  if (dates && dates.end !== null && Date.parse(dates.end) < Date.parse(dates.start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a span ends at or after it starts" });
  }
}

/** Zod schema for PurchaseItemInputType — non-strict arms, so extra keys strip. */
export const PurchaseItemInput: z.ZodType<PurchaseItemInputType> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("buy"),
    ...inputHead,
    uid_product: FirestoreId,
    quantity: z.int().min(1),
    amount_cents: z.int().min(0),
    coa_posting: COAAssetEnum.optional(),
    expected_date: chicagoStartOfDay().nullable().optional(),
    landed_costs: z.array(PurchaseLandedCostInput).optional(),
  }).superRefine((item, ctx) => {
    const named = new Set<string>();
    item.landed_costs?.forEach((entry, k) => {
      if (entry.uid === undefined) return;
      if (named.has(entry.uid)) {
        ctx.addIssue({ code: "custom", path: ["landed_costs", k, "uid"], message: "a landed cost uid appears once per item" });
      }
      named.add(entry.uid);
    });
  }),
  z.object({
    type: z.literal("subrent"),
    ...inputHead,
    uid_product: FirestoreId,
    quantity: z.int().min(1),
    amount_cents: z.int().min(0).nullable().optional(),
    coa_posting: COACostEnum.optional(),
    dates: inputDates,
    uid_orders: z.array(FirestoreId).optional(),
    auto_link: z.boolean().optional(),
    uid_units: unitsKey.optional(),
  }).superRefine((item, ctx) => {
    datesOrderIssue(item.dates, ctx);
    if (item.uid_units) uniqueUnitsIssue(item.uid_units, ctx);
  }),
  z.object({
    type: z.literal("charge"),
    ...inputHead,
    name: z.string().min(1).max(4000),
    quantity: z.int().min(1).optional(),
    amount_cents: z.int().min(0).nullable().optional(),
    coa_posting: COACode,
    dates: inputDates.nullable().optional(),
    auto_link: z.boolean().optional(),
    uid_units: unitsKey.optional(),
    uid_product: FirestoreId.optional(),
    uid_out_of_service: OutOfServiceId.optional(),
  }).superRefine((item, ctx) => {
    datesOrderIssue(item.dates, ctx);
    if (item.uid_units) uniqueUnitsIssue(item.uid_units, ctx);
  }),
]);

/** A stored item named twice in one write is ambiguous: which row is kept? */
function uniqueNamedUids(items: readonly { uid?: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (item.uid === undefined) return;
    if (seen.has(item.uid)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "uid"], message: "an item uid appears once per write" });
    }
    seen.add(item.uid);
  });
}

/**
 * Input for creating a purchase.
 *
 * `supplier` and `store` are uids only — the server resolves the names, as
 * `CreateTransactionInput.supplier` does, so a snapshot never disagrees with
 * its document. Items of any arm may mix (D3).
 */
export interface CreatePurchaseInputType {
  supplier: { uid: string };
  store: { uid: string };
  date: string;
  reference?: string | null;
  notes?: string | null;
  items: PurchaseItemInputType[];
  /**
   * One per operator action, client-minted OUTSIDE any retry loop. The purchase
   * id is derived from it (`derivedId("purchase:{uuid_session}")`), so a retried
   * create lands on the same document.
   */
  uuid_session: string;
}

/** Zod schema for CreatePurchaseInputType. */
export const CreatePurchaseInput: z.ZodType<CreatePurchaseInputType> = z.object({
  supplier: z.object({ uid: FirestoreId }),
  store: z.object({ uid: FirestoreId }),
  date: chicagoStartOfDay(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  items: z.array(PurchaseItemInput).min(1),
  uuid_session: z.uuid(),
}).superRefine((p, ctx) => uniqueNamedUids(p.items, ctx));

/**
 * Input for amending a purchase — a PATCH.
 *
 * `items`, when present, is the complete next set, matched to the stored items
 * by `uid`. A stored item absent from it is removed — refused once it has any
 * receipt, bill or return. A named item may not change `type`. On a buy the
 * writer refuses to cut `quantity` below what is received or billed, and to
 * change `amount_cents` once it has any receipt or bill: a price that moved
 * after goods or a bill exist is a short close plus a new item, because every
 * receipt already carries its share of the old price. Those are cross-document
 * facts the writer holds, so they are not refined here.
 *
 * ⚠️ **A SUBRENT item's price is not frozen by a receipt**, because its receipts
 * carry no cost (`subrent_in` is cost-forbidden). So on a subrent the writer lets
 * `amount_cents` and `dates.end` move after receipt — a paid hire extension —
 * with `quantity` still floored at what is received.
 */
export interface UpdatePurchaseInputType {
  date?: string;
  reference?: string | null;
  notes?: string | null;
  items?: PurchaseItemInputType[];
  version: number;
}

/** Zod schema for UpdatePurchaseInputType. */
export const UpdatePurchaseInput: z.ZodType<UpdatePurchaseInputType> = z.object({
  date: chicagoStartOfDay().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  items: z.array(PurchaseItemInput).min(1).optional(),
  version: z.int().min(0),
}).superRefine((p, ctx) => {
  if (p.items) uniqueNamedUids(p.items, ctx);
});

/**
 * Input for a short close or a cancel.
 *
 * Sets each named buy or subrent item's `quantity_canceled` to
 * `quantity − quantity_received`, a flat charge's to `quantity − quantity_billed`,
 * and a time charge's to `quantity` (it stops accruing). `uid_items` absent
 * closes every such item; a
 * cancel is a close of a purchase with nothing received. When the close leaves
 * a FLAT item billed beyond what was received, the writer raises a
 * `purchase-credits` document for the excess; a time line has no billed count.
 */
export interface ClosePurchaseInputType {
  uid_items?: string[];
  /** Client-minted per operator action; keys the auto-credit, so a retry cannot mint two. */
  uuid_session: string;
  version: number;
}

/** Zod schema for ClosePurchaseInputType. */
export const ClosePurchaseInput: z.ZodType<ClosePurchaseInputType> = z.object({
  uid_items: z.array(ItemUid).min(1).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Each named item once per write — a receipt or return of one item is one line. */
function uniqueItems(lines: readonly { uid_item: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (seen.has(line.uid_item)) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "uid_item"], message: "one line per item" });
    }
    seen.add(line.uid_item);
  });
}

/** One item received in a delivery. */
export interface ReceivePurchaseLineInputType {
  /** The buy or subrent item received against — by row identity, since one product may sit on two items. */
  uid_item: string;
  quantity: number;
  /**
   * Which locations the units go to. Absent means they land at the store's
   * default staging location (`store.default_location`, the arrivals inbox),
   * as every arrival does — a receipt is an arrival (api-cloudrun#1302 ruling
   * 12; api-cloudrun#1308). Name a storage location to shelve them directly.
   */
  allocations?: MovementAllocationInputType[];
  /**
   * Which units arrive, on a serialized product: exactly `quantity`, ascending
   * by number, each with the serial it arrives with — the receipt is where
   * serials are captured (serial-tracking D8), exactly as on a manual purchase.
   */
  units?: MovementUnitInputType[];
}

/** Zod schema for ReceivePurchaseLineInputType. */
export const ReceivePurchaseLineInput: z.ZodType<ReceivePurchaseLineInputType> = z.object({
  uid_item: ItemUid,
  quantity: z.int().min(1),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  units: z.array(MovementUnitInput).optional(),
}).superRefine((l, ctx) => {
  if (l.allocations && l.quantity !== l.allocations.reduce((sum, a) => sum + a.quantity, 0)) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must equal the sum of per-location allocation quantities" });
  }
  if (l.units !== undefined) {
    if (l.units.length !== l.quantity) {
      ctx.addIssue({ code: "custom", path: ["units"], message: "a receipt that names units names exactly `quantity` of them" });
    }
    for (let i = 1; i < l.units.length; i++) {
      if (l.units[i].number <= l.units[i - 1].number) {
        ctx.addIssue({ code: "custom", path: ["units", i], message: "units must be ascending by number, each named once" });
        break;
      }
    }
  }
  const issue = allocationUnitsIssue(l.units?.map((u) => u.number), l.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
});

/**
 * Input for receiving goods against a purchase.
 *
 * Each line becomes ONE `purchase` (or `subrent_in`) movement naming the
 * purchase in `sources[]`, all in one transaction with the bucket co-write.
 * Cost is not an input: each receipt costs its cumulative share of the item
 * (`cumulativeShareCents`), which is what keeps basis equal to what is billed.
 */
export interface ReceivePurchaseInputType {
  /** The physical instant the goods arrived. */
  date: string;
  reference?: string;
  lines: ReceivePurchaseLineInputType[];
  uuid_session: string;
  version: number;
}

/** Zod schema for ReceivePurchaseInputType. */
export const ReceivePurchaseInput: z.ZodType<ReceivePurchaseInputType> = z.object({
  date: chicagoInstant(),
  reference: z.string().optional(),
  lines: z.array(ReceivePurchaseLineInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
}).superRefine((p, ctx) => uniqueItems(p.lines, ctx));

/**
 * Input for reversing one receipt (`POST /purchases/{uid}/receipts/{movementUid}/reverse`).
 *
 * A standalone reversal of a receipt is refused; this lever reverses it AND
 * decrements `quantity_received` in one transaction. It posts nothing to Xero —
 * a receipt never did.
 */
export interface ReversePurchaseReceiptInputType {
  uuid_session: string;
  reference?: string;
  version: number;
}

/** Zod schema for ReversePurchaseReceiptInputType. */
export const ReversePurchaseReceiptInput: z.ZodType<ReversePurchaseReceiptInputType> = z.object({
  uuid_session: z.uuid(),
  reference: z.string().optional(),
  version: z.int().min(0),
});

/** One subrent item given back to the supplier. */
export interface ReturnPurchaseLineInputType {
  /** The subrent item returned against. */
  uid_item: string;
  quantity: number;
  /**
   * Which locations the units leave FROM. Absent means the writer picks the
   * shelves, as a check-out does.
   */
  allocations?: MovementAllocationInputType[];
  /**
   * Which units go back, on a serialized product: exactly `quantity`,
   * ascending by number, by NUMBER only (a serial is captured on the way in,
   * never on the way out). The writer requires them on a seeded roster and
   * refuses any unit not subrented from this purchase's supplier
   * (`api-cloudrun/.claude/plans/serialized-subrent.md` § 2).
   */
  units?: MovementUnitInputType[];
}

/** Zod schema for ReturnPurchaseLineInputType. */
export const ReturnPurchaseLineInput: z.ZodType<ReturnPurchaseLineInputType> = z.object({
  uid_item: ItemUid,
  quantity: z.int().min(1),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  units: z.array(MovementUnitInput).optional(),
}).superRefine((l, ctx) => {
  if (l.allocations && l.quantity !== l.allocations.reduce((sum, a) => sum + a.quantity, 0)) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must equal the sum of per-location allocation quantities" });
  }
  if (l.units !== undefined) {
    if (l.units.length !== l.quantity) {
      ctx.addIssue({ code: "custom", path: ["units"], message: "a return that names units names exactly `quantity` of them" });
    }
    for (let i = 1; i < l.units.length; i++) {
      if (l.units[i].number <= l.units[i - 1].number) {
        ctx.addIssue({ code: "custom", path: ["units", i], message: "units must be ascending by number, each named once" });
        break;
      }
    }
    l.units.forEach((u, i) => {
      if (u.serial_number !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["units", i, "serial_number"],
          message: "a return names units by number only; a serial arrives with a unit coming in",
        });
      }
    });
  }
  const issue = allocationUnitsIssue(l.units?.map((u) => u.number), l.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
});

/**
 * Input for returning subrented units to the supplier
 * (`POST /purchases/{uid}/returns`) — the mirror of {@link ReceivePurchaseInput}.
 *
 * Each line becomes ONE `subrent_out` movement naming the purchase in
 * `sources[]`, in one transaction with the `quantity_returned` co-write. There
 * is no cost: a returned unit was never owned.
 */
export interface ReturnPurchaseInputType {
  /** The physical instant the units left for the supplier. */
  date: string;
  reference?: string;
  lines: ReturnPurchaseLineInputType[];
  uuid_session: string;
  version: number;
}

/** Zod schema for ReturnPurchaseInputType. */
export const ReturnPurchaseInput: z.ZodType<ReturnPurchaseInputType> = z.object({
  date: chicagoInstant(),
  reference: z.string().optional(),
  lines: z.array(ReturnPurchaseLineInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
}).superRefine((p, ctx) => uniqueItems(p.lines, ctx));

/**
 * Input for reversing one return (`POST /purchases/{uid}/returns/{movementUid}/reverse`)
 * — the mirror of {@link ReversePurchaseReceiptInput}: it reverses the
 * `subrent_out` AND decrements `quantity_returned` in one transaction.
 */
export interface ReversePurchaseReturnInputType {
  uuid_session: string;
  reference?: string;
  version: number;
}

/** Zod schema for ReversePurchaseReturnInputType. */
export const ReversePurchaseReturnInput: z.ZodType<ReversePurchaseReturnInputType> = z.object({
  uuid_session: z.uuid(),
  reference: z.string().optional(),
  version: z.int().min(0),
});
