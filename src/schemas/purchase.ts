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
 * - **Custody lives on the inbound bookings, not here** (one-document-model
 *   C8): what a line has received and returned is DERIVED, per grain from its
 *   inbound booking and per row from the movements naming it
 *   (`custodyBySourceItem`, `@cfs/core/utils/bookings-inbound`). The one
 *   co-written bucket left is `quantity_billed`, until 6e-0b2 (ruling 42).
 * - **A line closed to 0 is removed**, as an order line is (ruling 47); there
 *   is no line status.
 * - **A derived status** in the record's vocabulary (`active | complete |
 *   canceled`), custody-only (rulings 55, 56): read off the purchase's INBOUND
 *   bookings by `derivePurchaseStatus` (`@cfs/core/utils/bookings-inbound`), and
 *   written by the writer that finalizes them. It reads another collection, so
 *   no document refine can check it, as none checks an order's.
 *
 * ## Items take the invoice's shape (api-cloudrun#1407)
 *
 * `items[]` is discriminated on `type`, the house key for a stored line union
 * (`OrderDocItem`, `InvoiceDocItem`), and the ARM is per item — there is no
 * document-level `kind`, so one purchase may mix arms:
 *
 * | `type` (label) | what CFS gets | custody | supply | priced |
 * |---|---|---|---|---|
 * | `sale` (Buy) | ownership | receipts raise `quantity_held` and basis | `inbound` until received | flat |
 * | `rental` (Subrent) | units for a hire window | `subrent_in` / `subrent_out`, never owned | `subrent` over `dates` | flat or time |
 * | `service` (Charge) | a service with no custody — a carrier line on an owned device, freight, a fee | none | none | flat or time |
 * | `replacement` | the supplier billing CFS for its unit lost in CFS's hands | none | none | flat or time |
 *
 * The types are the receivable side's, labelled per side (`SIDE_CONTRACTS`,
 * `schemas/side.ts`; stored as `buy` / `subrent` / `charge` until the
 * one-document-model Phase 1 migration). (`usage` and `direct` retired into
 * `charge`, and the nested `SubrentBilling` union into the price rule below —
 * purchases-as-documents Phase 2.)
 *
 * Each item carries its own **row identity** (`uid`, and `path` = `[uid]`
 * until a divider type exists — the writer is its one author), so one product
 * may sit on two items: a buy plus a re-order, or two hire windows. Bills and
 * credits name an item by `path` (`path_purchase_item`), the way an invoice line
 * names its order line.
 *
 * Each item also carries its own **posting** — `ledger_account` and
 * `uid_tracking_category` (`LedgerPostingCore`), stamped at write rather than
 * worked out at push. The account is constrained per type by
 * {@link payablePostingIssues}: a sale posts to an inventory asset account
 * (`COA_ASSET_CODES`, or a temporary de minimis expense account), a rental to a
 * Direct Costs account (`COA_COST_CODES`), a service or replacement to any
 * account. Both are `propagate: true`, so a bill item follows its purchase
 * item's posting until an operator changes it there.
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
 * - **time** — commits nothing on the purchase (`amount_cents` and
 *   `quantity_billed` null, money zero); each bill meters it from its
 *   destination pair's charge windows as an order line is metered, and bills in
 *   parts by COUNTS (`remainingTimeCounts`, one-document-model Phase 3).
 *
 * Either way the line's `price` carries the money `priceDocument` computes —
 * see {@link PurchaseLinePrice}.
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
 * No tax is CHARGED on a purchase (owner, 2026-10-05): stock bought for sale or
 * rent is bought resale-exempt and the tax is collected from the end user. The
 * line still carries a tax class and `taxes: []` — exemption, not absence (see
 * {@link PurchaseLinePrice}).
 *
 * The document stays one `z.strictObject` with a `superRefine` rather than a
 * root `discriminatedUnion`: no registered document schema has one, and the
 * column walker, `getInitialValues`, `getTestDoc` and the stored-defaults walk
 * all assume a root object.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoInstant, chicagoStartOfDay } from "./_datetime.ts";
import { UnitSet } from "./unit.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import {
  ActorRef,
  type ActorRefType,
  checkZeroPricedComponents,
  COA_ASSET_CODES,
  COA_COST_CODES,
  COA_EXPENSED_ASSET_CODES,
  COA_REVENUE_CODES,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  InvoiceStatusEnum,
  type InvoiceStatusType,
  OutOfServiceList,
  OutOfServiceListInput,
  type OutOfServiceEntryType,
  outOfServiceLinkIssues,
  PurchaseCreditStatusEnum,
  type PurchaseCreditStatusType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import {
  Discount,
  DiscountInput,
  type DiscountInputType,
  type DiscountType,
  PriceModifier,
  type PriceModifierType,
  TaxRef,
  type TaxRefType,
  checkDestinationJoin,
  checkLeadingDivider,
  DestinationEndpoint,
  type DestinationEndpointType,
  leadingDividerViolations,
  type OrderDatesType,
  PairInputCore,
  type OrderDocDestinationItemType,
  type OrderDocGroupItemType,
  PairCore,
  type PairCoreType,
} from "./order.ts";
import { LedgerPostingCore, LineItemCore, LineTaxCore, PayableKitLedgerAccount } from "./_items.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { type InboundBreakdown, InboundBreakdownSchema } from "./_inbound-breakdown.ts";
import { SIDE_CONTRACTS, type SharedLineType } from "./side.ts";
import {
  type PriceFormulaBasis,
  type PriceFormulaRef,
  PriceFormulaRefSchema,
  RateKey,
  type RateSnapshotType,
  RateSnapshotSchema,
} from "./price-formula.ts";

// ── Status ───────────────────────────────────────────────────────

/**
 * Never client-set: `canceled` is an operator cancel, and `active` / `complete`
 * are read off the inbound bookings by `derivePurchaseStatus`
 * (`@cfs/core/utils/bookings-inbound`, rulings 55, 56, 61). The out-of-service
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

/**
 * What a purchase status means for its inbound bookings — the twin of
 * `ORDER_STATUS_TRAITS` (one-document-model 7a, C6), cut to the two traits the
 * inbound ladder reads.
 *
 * - `authored` — an operator sets it; otherwise it is read off the bookings.
 * - `planBucket` — where a booking's unstarted units sit; `null` books no plan
 *   (custody stays, as on a canceled order).
 *
 * `Record<PurchaseStatusType, …>`, so a new status is a compile error here.
 * ⚠️ `complete`'s plan bucket is `ordered`, as a complete order's is `reserved`:
 * a raise on a complete purchase books as ordered work and reopens it.
 */
export interface PurchaseStatusTraits {
  authored: boolean;
  planBucket: "ordered" | null;
}

/** The table. See {@link PurchaseStatusTraits}. */
export const PURCHASE_STATUS_TRAITS: Readonly<Record<PurchaseStatusType, PurchaseStatusTraits>> = {
  active: { authored: false, planBucket: "ordered" },
  complete: { authored: false, planBucket: "ordered" },
  canceled: { authored: true, planBucket: null },
};

// ── Item type ────────────────────────────────────────────────────

/**
 * The item arms — the SHARED line types (`SHARED_LINE_TYPES`,
 * `schemas/side.ts`), labelled per side (owner, 2026-11-07): a payable `sale` is
 * a Buy, `rental` a Subrent, `service` a Charge, and `replacement` a supplier
 * billing CFS for a unit lost in CFS's hands. Until 2026-11 they were stored as
 * `buy` / `subrent` / `charge`. `sale` is FIRST so `getInitialValues` seeds a buy.
 *
 * ⚠️ **On this side a line's type is NOT its product's type** — a fleet buy is
 * a `sale` line naming a RENTAL product (posting to 1999). Never derive a
 * product type, stock method or asset account from it.
 *
 * 🔴 **Closed, and read through exhaustive switches.** Every reader that
 * branches on an item's arm switches over this union with a `never` default
 * (`purchaseItemSupplies`, `purchaseItemCommittedCents`, …), so a new member is a
 * compile error at every one of them rather than a silent fall-through.
 *
 * Explicit tuple type rather than `as const` alone: core#43 is JSR's npm
 * `.d.ts` emit truncating an inferred tuple.
 */
export const PURCHASE_ITEM_TYPES: readonly ["sale", "rental", "service", "replacement"] = [
  "sale",
  "rental",
  "service",
  "replacement",
];
/** One {@link PURCHASE_ITEM_TYPES} member. */
export type PurchaseItemTypeType = typeof PURCHASE_ITEM_TYPES[number];
/** Zod schema for PurchaseItemTypeType. */
export const PurchaseItemTypeEnum: z.ZodType<PurchaseItemTypeType> = z.enum(PURCHASE_ITEM_TYPES);

/**
 * The arms that ORDER a product — the payable types whose
 * `SIDE_CONTRACTS.payable.custody` is `"custody"`. The line's `uid` IS the
 * product (ruling 12), as an order line's is. A `service` line's `uid_product`
 * is attribution only, and a `replacement` line's product is its lost rental's
 * money-only twin, so neither is one.
 */
export const PURCHASE_PRODUCT_ITEM_TYPES: readonly ["sale", "rental"] = ["sale", "rental"];
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
 * expected delivery, as a Buy's pair's `delivery_start` does (C8).
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
 * 7): the formula it is priced by, the rates it snapshots, a supplier
 * discount, and the money `priceDocument` computes from them.
 *
 * - A line states its WHOLE net cost in the line's `amount_cents` (the DECLARED
 *   stated total: a buy, a fixed-cost subrent, freight or a fee) and carries
 *   `rates: []`. Measured: most stored buys cost a total that does not divide
 *   by their quantity, and every reader slices the total with
 *   `cumulativeShareCents`, so no per-unit rate is stored.
 * - The COMPUTED half is the receivable line's money (`subtotal_cents`,
 *   `subtotal_discounted_cents`, `taxes`, `total_cents`), written by
 *   `priceDocument`'s stated-total arm (one-document-model Phase 2): subtotal =
 *   `amount_cents + discount.amount_cents` (the operator's gross),
 *   discounted = `amount_cents`, total = discounted + Σ taxes. Every money
 *   reader reads it, as on an order line; `amount_cents` is the input.
 *
 * ⚠️ **A TIME line** commits nothing here: its money is zero and its rates are
 * the formula's; its bills price it from their pair's windows
 * (`priceDocument`'s time arms, one-document-model Phase 3).
 *
 * `discount` is core's `Discount`. On a payable line it records what came off
 * the operator's GROSS, so `discount.amount_cents` is declared, not derived;
 * `amount_cents` is the NET — what CFS pays, which receipts, basis and bills
 * slice.
 *
 * **Tax is EXEMPTION, not absence** (api-cloudrun's `one-document-model` plan):
 * a payable line is stamped with its type's default tax class like any other
 * priced line (`LineTaxCore`), and the payable side resolves it exempt, so
 * `taxes` is `[]`. `taxes_base` is the class's rates BEFORE the exemption, as
 * on an order line, so an exempt line records a non-empty base. A taxable
 * purchase later (consumables, use tax) then needs no new path. Neither key
 * reaches a Xero body or the bill's projection hash.
 */
export interface PurchaseLinePrice {
  price_formula: PriceFormulaRef;
  rates: RateSnapshotType[];
  discount: DiscountType | null;
  /** The taxes charged — `[]` on the payable side, which is exempt. */
  taxes: PriceModifierType[];
  /** The class's taxes before the exemption; the order line's key. */
  taxes_base?: TaxRefType[];
  /** What this supplier charges CFS for a lost unit. A subrent line only; `null` when none was stated. */
  replacement_cents?: number | null;
  /** The gross: `amount_cents + discount.amount_cents`. Computed by `priceDocument`. */
  subtotal_cents: number;
  /** The net: equal to the line's `amount_cents`. Computed by `priceDocument`. */
  subtotal_discounted_cents: number;
  /** The net plus Σ `taxes`. Computed by `priceDocument`. */
  total_cents: number;
}

/**
 * The computed money keys every payable line price carries — ONE instance per
 * key, spread by the purchase line and the bill/credit line alike, so the two
 * cannot drift (`tests/item-shape-parity.test.ts` asserts the identity).
 * Derived, so the purchase → bill merge never carries them: the pricer
 * re-derives them on every grain.
 *
 * ⚠️ Not on the `@cfs/core/schemas` barrel, like `TotalsCore`: no consumer
 * assembles a price from parts.
 */
export const PayablePriceMoneyCore: {
  subtotal_cents: z.ZodType<number>;
  subtotal_discounted_cents: z.ZodType<number>;
  total_cents: z.ZodType<number>;
} = {
  subtotal_cents: z.int().meta({ derived: true }),
  subtotal_discounted_cents: z.int().meta({ derived: true }),
  total_cents: z.int().meta({ derived: true }),
};

/** Zod schema for {@link PurchaseLinePrice}. */
export const PurchaseLinePriceSchema: z.ZodType<PurchaseLinePrice> = z.strictObject({
  price_formula: PriceFormulaRefSchema.meta({ propagate: true }),
  // One value to the purchase → bill merge, like `charge_windows`: its entries
  // carry no `uid`, and a rate set is overridden or followed as a whole.
  rates: z.array(RateSnapshotSchema).meta({ shared: "value", propagate: true, label: "Rate" }),
  discount: Discount.nullable().meta({ propagate: true, label: "Discount" }),
  // Derived by the pricer on each grain, never merged — the order line's
  // declarations (`schemas/order.ts`, `ItemPrice`).
  taxes: z.array(PriceModifier).meta({ label: "Tax", derived: true }),
  taxes_base: z.array(TaxRef).optional().meta({ label: "Base Tax", derived: true }),
  // What this supplier charges CFS for a lost unit, on a subrent line only: the
  // order line's declaration (`schemas/order.ts`, `ItemPrice`). A bill's price
  // has none, as an invoice's has none.
  replacement_cents: z.int().nullable().optional().meta({ column: true, label: "Replacement" }),
  ...PayablePriceMoneyCore,
});

/**
 * The single-document money rule (ruling 1), shared by every arm and by the
 * bill line. A refine rather than a union arm because it cuts across all four
 * line types.
 *
 * - **flat** — states its amount and no rates; its computed money is what
 *   `priceDocument`'s stated-total arm derives from that amount.
 * - **time** (one-document-model Phase 3) — carries its formula's `rates`.
 *   On a PURCHASE (`grain: "purchase"`) it commits nothing: `amount_cents` and
 *   `quantity_billed` are null and its money is zero. On a BILL or CREDIT line
 *   (`grain: "document"`) it states its amount — `rates × counts` metered from
 *   its pair's windows on a pushed document, Xero's on a linked one — and its
 *   money follows from that amount as a flat line's does.
 */
export function purchaseLineMoneyIssues(
  item: { price?: PurchaseLinePrice; amount_cents: number | null; quantity_billed?: number | null },
  grain: "purchase" | "document" = "purchase",
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const basis = item.price?.price_formula.basis ?? "flat";
  const rates = item.price?.rates ?? [];
  if (basis === "time") {
    if (rates.length === 0) issues.push({ path: ["price", "rates"], message: "a time line carries its formula's rates" });
    if (grain === "purchase") {
      if (item.amount_cents !== null) {
        issues.push({ path: ["amount_cents"], message: "a time line commits no amount; its bills decide its cost" });
      }
      if (item.quantity_billed != null) {
        issues.push({ path: ["quantity_billed"], message: "a time line counts nothing billed; it resolves on custody" });
      }
      if (item.price) issues.push(...statedTotalMoneyIssues(item.price, 0));
      return issues;
    }
    if (item.amount_cents === null) issues.push({ path: ["amount_cents"], message: "a bill or credit line states its amount" });
    else if (item.price) issues.push(...statedTotalMoneyIssues(item.price, item.amount_cents));
    return issues;
  }
  if (item.amount_cents === null) issues.push({ path: ["amount_cents"], message: "a flat line states its amount" });
  if (rates.length > 0) issues.push({ path: ["price", "rates"], message: "a flat line carries no rates" });
  if (item.quantity_billed === null) {
    issues.push({ path: ["quantity_billed"], message: "a flat line counts what is billed" });
  }
  if (item.price && item.amount_cents !== null) issues.push(...statedTotalMoneyIssues(item.price, item.amount_cents));
  return issues;
}

/**
 * The stated-total identities: the computed money is exactly what the declared
 * amount and discount give (`priceDocument`'s stated-total arm is the author;
 * this is the value assertion beside it).
 */
function statedTotalMoneyIssues(
  price: PurchaseLinePrice,
  amountCents: number,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const gross = amountCents + (price.discount?.amount_cents ?? 0);
  if (price.subtotal_discounted_cents !== amountCents) {
    issues.push({
      path: ["price", "subtotal_discounted_cents"],
      message: `price.subtotal_discounted_cents ${price.subtotal_discounted_cents} must equal the stated amount ${amountCents}`,
    });
  }
  if (price.subtotal_cents !== gross) {
    issues.push({
      path: ["price", "subtotal_cents"],
      message: `price.subtotal_cents ${price.subtotal_cents} must equal amount + discount: ${gross}`,
    });
  }
  // From the DECLARED amount, like the two above, so one wrong key is one issue.
  const total = price.taxes.reduce((sum, t) => sum + t.amount_cents, amountCents);
  if (price.total_cents !== total) {
    issues.push({
      path: ["price", "total_cents"],
      message: `price.total_cents ${price.total_cents} must equal the stated amount + Σ taxes: ${total}`,
    });
  }
  return issues;
}

function addIssues(issues: { path: (string | number)[]; message: string }[], ctx: z.RefinementCtx): void {
  for (const issue of issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
}

/**
 * The basis of an item's formula. Every STORED item carries `price` (beta B);
 * the parameter stays loose for a client's draft line, which reads as flat
 * until it names a formula.
 */
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
 * what the line had received at that moment (its row's custody, C8). The k-th receipt prices the units received
 * since the entry, `clamp(received − received_at_entry, 0, quantity)`, with
 * `cumulativeShareCents`, so the shares telescope to `amount_cents` exactly when
 * every outstanding unit arrives (`purchaseLineReceiptTargetCents`,
 * `@cfs/core/utils/purchases`).
 *
 * **Append-only, the way the item amount is.** An entry no receipt has priced
 * (received `≤ received_at_entry`) is editable and removable. One that
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
  /** The item's outstanding count (`quantity − received`) when the entry was made. */
  quantity: number;
  /** What the item had received when the entry was made (its row's custody). */
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
 * The keys every purchase item carries — the SHARED line head, posting and tax
 * cores (`schemas/_items.ts`), one instance per key across every grain that
 * spreads them (api-cloudrun's `one-document-model` plan, Phase 1).
 *
 * - **Head** — `LineItemCore` minus `quantity`. A purchase item's `quantity`
 *   is what was ORDERED and a bill item's is what it BILLS, so the two stay
 *   `propagate: false` homonyms until that plan's Phase 3 turns on the full
 *   three-way sync with `{quantity, amount_cents}` as one atom. Spreading the
 *   shared `quantity` (tagged `propagate: true`) now would make the existing
 *   purchase → bill merge overwrite a billed count with an ordered one.
 * - **Posting** — `LedgerPostingCore` (`ledger_account`, `uid_tracking_category`),
 *   which replaced `coa_posting`. The account a type may post to is
 *   `SIDE_CONTRACTS.payable.posting_class`, refined per arm by
 *   {@link payablePostingIssues}.
 * - **Tax** — `LineTaxCore`; see {@link PurchaseLinePrice} for why an exempt
 *   line still carries a class.
 *
 * `name` is the product's name when ordered (or a charge's text), a
 * point-in-time snapshot like `Movement.supplier`; `description` is free text.
 * `zero_priced` and `quantity_per_parent` are a kit component's keys, as on an
 * order line. A `stock_method: "none"` kit parent is a ROW, not a line: see
 * {@link isKitHeaderLine}.
 */
interface PurchaseItemBase {
  /**
   * The line's product's uid, or a `custom-` uid for a line no product keys
   * ({@link payableLineUid}), as an order or invoice line's (W4K, owner ruling
   * 12, 2026-11-10). NOT a row identity: one product may sit on two items, under
   * two pairs or in two groups. `path` is the identity.
   */
  uid: string;
  name: string;
  description: string;
  /**
   * Units ordered, `≥ 1`. A close lowers it, and a line closed to 0 is REMOVED
   * (ruling 47, which retired the line `status`); its inbound booking is kept
   * while it holds custody. A TIME charge is never lowered: a close ends its
   * pair's charge window instead (ruling 63).
   */
  quantity: number;
  /**
   * Self-inclusive, under its destination divider (and group, when there is
   * one): `[destination uid, ...group uid, uid]`, authored by
   * `computeItemPaths` at order depth (one-document-model Phase 3).
   */
  path: string[];
  zero_priced: boolean | null;
  quantity_per_parent?: number | null;
  /** The Xero account the item posts to — per type, see {@link payablePostingIssues}. */
  ledger_account: COACodeType;
  /** The tracking category (`tracking-categories/{uid}`), or `null` for untracked. */
  uid_tracking_category: string | null;
  /** The line's tax class, stamped from its type's default; exempt on this side. */
  uid_tax_class: string;
  uid_tax_class_override?: string | null;
}

/** A SALE (Buy) item — ownership of `quantity` units of one product. Always flat. */
export interface PurchaseSaleItem extends Omit<PurchaseItemBase, "ledger_account"> {
  type: "sale";
  /** `null` marks a kit header ({@link isKitHeaderLine}). */
  ledger_account: COACodeType | null;
  /** What the whole item costs, net, integer cents. */
  amount_cents: number;
  /**
   * The formula snapshot (always a flat one). Required since beta B: the Phase 5
   * backfill stamped it on every stored buy (2026-11-01 census, key present on
   * 415 of 415 buy lines in prod, 415 of 415 dev, 405 of 405 `test`).
   */
  price: PurchaseLinePrice;
  /**
   * Units billed — Σ of bill items minus Σ of credit items projecting this
   * item. May exceed what was ordered: over-billing is legal and flagged, never
   * refused (D5).
   */
  quantity_billed: number;
  /** Freight, duty and fees spread onto the units still to arrive ({@link PurchaseLandedCost}). */
  landed_costs: PurchaseLandedCost[];
}

/** A RENTAL (Subrent) item — `quantity` units borrowed for a hire window and given back. Flat or time. */
export interface PurchaseRentalItem extends Omit<PurchaseItemBase, "ledger_account"> {
  /** `null` marks a kit header ({@link isKitHeaderLine}). */
  ledger_account: COACodeType | null;
  type: "rental";
  /** Net whole cost on a flat line; `null` on a time line (its bills decide it). */
  amount_cents: number | null;
  price: PurchaseLinePrice;
  /** Units billed on a flat line; `null` on a time line, which resolves on custody alone (Q7). */
  quantity_billed: number | null;
  /**
   * The orders this item was raised for, possibly none. For margin and for
   * raising a subrent from an order's shortage; it is NOT a reservation, and
   * the units stay fungible across every booking.
   */
  uid_orders: string[];
}

/**
 * A SERVICE (Charge) item — something CFS pays for with no custody: a carrier
 * line on a device CFS owns (Verizon), freight, a fee, Vision's standing history
 * line. Flat (freight: one amount) or time (a carrier line).
 *
 * Its uid is its catalog SERVICE product's when it has one, as an order or
 * invoice service line's is, else `custom-` ({@link payableLineUid}). There is
 * no attribution key and no unit list (rulings 70–73, 2026-11-11): a charge that
 * costs a product sits as a ROW beneath that product's row, as a kit component
 * does, and a top-level charge costs its own product
 * (`costedProductUid`, `utils/purchases.ts`). Which units a charge covers is not
 * a fact this line states: a service product is never serialized, and a carrier
 * line follows the device it is placed under (api-cloudrun#1489 tracks a
 * unit-level installed-component link).
 */
export interface PurchaseServiceItem extends PurchaseItemBase {
  type: "service";
  /** Net whole cost on a flat line; `null` on a time line. */
  amount_cents: number | null;
  price: PurchaseLinePrice;
  /** Units billed on a flat line; `null` on a time line. */
  quantity_billed: number | null;
}

/**
 * A REPLACEMENT item — the supplier billing CFS for one of ITS units lost or
 * damaged in CFS's hands, naming the out-of-service record(s) the loss opened
 * (until 2026-11 a `charge` with a single record id). No custody: the
 * settlement movement (`return_to_supplier`) moves the units, not this line.
 * Otherwise a {@link PurchaseServiceItem}.
 *
 * ⚠️ **Its `uid` names the lost rental's money-only TWIN, never the rental**
 * (owner ruling 15, 2026-11-10): the rental's `uid_linked_replacement`, a
 * `stock_method: "none"` product, which the writer derives from the record —
 * as an invoice's replacement line names its twin by its uid. Naming the rental
 * itself would sit the line at the subrent line's own path. With no twin it
 * names no product and keys `custom-`. The lost rental stays reachable through
 * the record's `uid_product`. (The line's own `uid_product` key retired in 7a:
 * the uid is the one place a line names its product.)
 */
export interface PurchaseReplacementItem extends Omit<PurchaseServiceItem, "type"> {
  type: "replacement";
  /**
   * The records this line bills (a `mark_lost` record's id is a MovementId, so
   * `OutOfServiceId`), each with its share of `quantity` (ruling 16):
   * two records of one twin under one parent merge into one line. Follows the
   * purchase onto its bills in the `flat_money` group with `quantity` and
   * `amount_cents`, so a bill line either holds all three as the purchase does
   * or keeps all three of its own, and its shares always sum to its quantity.
   * A close that lowers `quantity` re-shares it (`fitOutOfServiceEntries`).
   * Required: it replaced the pre-W4R single `uid_out_of_service`, retired at
   * W4K's contract publish (2026-11-10).
   */
  out_of_service: OutOfServiceEntryType[];
}

/** Union of every purchase LINE arm, discriminated on `type`. */
export type PurchaseItem = PurchaseSaleItem | PurchaseRentalItem | PurchaseServiceItem | PurchaseReplacementItem;

/**
 * Any row of a purchase's `items[]`: a line ({@link PurchaseItem}) or one of
 * the order's two dividers. A purchase uses `ORDER_ITEM_LEVELS` — every line
 * sits under a destination divider, which its pair in `destinations` answers
 * (one-document-model Phase 3). Read lines through {@link purchaseLines}.
 */
export type PurchaseRow = PurchaseItem | OrderDocDestinationItemType | OrderDocGroupItemType;

/** The divider row types on either payable grain. */
export type PayableDividerType = "purchase" | "destination" | "group";

/** Is this row a line (not a divider)? */
export function isPurchaseLine<T extends { type: string }>(row: T): row is Exclude<T, { type: PayableDividerType }> {
  return row.type !== "destination" && row.type !== "group" && row.type !== "purchase";
}

/**
 * **Is this row a kit header?** A `stock_method: "none"` kit parent on a payable
 * document: stored as a sale or rental row with `ledger_account: null`, no money
 * and a flat formula, so that a kit reads the same as it does on an order. It is a
 * ROW and not a LINE: it holds no money, posts nothing and receives nothing, so
 * {@link purchaseLines} and `purchaseDocumentLines` drop it as they drop a divider.
 * A counted parent (a makeup mirror over its adapter) is an ordinary line.
 */
export function isKitHeaderLine(row: object): boolean {
  return "ledger_account" in row && row.ledger_account === null;
}

/** A purchase line that can be received, billed and posted: never a kit header. */
export type PurchasePostedItem = PurchaseItem & { ledger_account: COACodeType };

/** The lines of a purchase's rows, with dividers and kit headers dropped. */
export function purchaseLines(rows: readonly PurchaseRow[]): PurchasePostedItem[] {
  return rows.filter((r): r is PurchasePostedItem => isPurchaseLine(r) && !isKitHeaderLine(r));
}

// The shared head (one instance per key, `schemas/_items.ts`) — every key but
// `quantity`, which this side declares itself because it carries the payable
// `flat_money` merge group (see `quantityKey` below). Key ORDER is the column order: `type` stays first.
const itemHead = {
  uid: LineItemCore.uid,
  name: LineItemCore.name,
  description: LineItemCore.description,
} as const;
const itemShape = {
  path: LineItemCore.path,
  zero_priced: LineItemCore.zero_priced,
  quantity_per_parent: LineItemCore.quantity_per_parent,
  ...LedgerPostingCore,
  ...LineTaxCore,
} as const;

// `quantity` and `amount_cents` follow the purchase onto its bills by the full
// three-way rule, as an order line's do onto its invoices (owner, 2026-11-07),
// and as ONE unit (`shared_group`): a flat line's amount is a stated TOTAL, so
// an untouched bill line follows both, and a line where either was edited
// keeps both (one-document-model Phase 3). A partial bill differs from its
// purchase line on both, so it keeps both and a purchase edit never re-bills it.
// The co-written `quantity_billed` has no counterpart on a bill at all.
const flatMoney = { propagate: true, shared_group: "flat_money" } as const;
// `≥ 1`: a line closed to 0 is removed (ruling 47), never stored at 0.
const quantityKey = z.int().min(1).meta({ column: true, label: "Quantity", ...flatMoney });
const amountKey = z.int().min(0).meta({ column: true, label: "Amount", ...flatMoney });
const billedKey = z.int().min(0).meta({ column: true, label: "Billed" });

/**
 * May a payable line of `type` post to `account`? The class is
 * `SIDE_CONTRACTS.payable.posting_class[type]` (`schemas/side.ts`):
 *
 * - `asset_or_expensed` (a Buy) — `COA_ASSET_CODES`, plus the TEMPORARY
 *   `COA_EXPENSED_ASSET_CODES` (de minimis acquisitions expensed directly;
 *   owner, 2026-11-07);
 * - `cost` (a Subrent) — `COA_COST_CODES`;
 * - `any` (a Charge or Replacement) — any `COACode`.
 *
 * One rule for the purchase, bill and credit lines alike. Until 2026-11 a bill
 * line took any account while the purchase's buy took an asset one; the
 * census found the bills' non-asset buys were all de minimis acquisitions
 * (6500 / 6300) plus one mis-coding (6000) the owner recodes.
 */
export function payablePostingIssues(
  type: SharedLineType,
  account: number | null,
): { path: (string | number)[]; message: string }[] {
  if (account === null) return [];
  const cls = SIDE_CONTRACTS.payable.posting_class[type];
  const allowed: readonly number[] | null = cls === "asset_or_expensed"
    ? [...COA_ASSET_CODES, ...COA_EXPENSED_ASSET_CODES]
    : cls === "cost"
    ? COA_COST_CODES
    : cls === "revenue"
    ? COA_REVENUE_CODES
    : null;
  if (allowed === null || allowed.includes(account)) return [];
  return [{
    path: ["ledger_account"],
    message: `a payable ${type} line posts to one of ${allowed.join(", ")}, not ${account}`,
  }];
}

/** A kit header holds no money: a `null` account requires a flat line stating $0. */
export function kitHeaderIssues(
  item: { ledger_account: number | null; amount_cents: number | null; price: { price_formula: { basis: string } } },
): { path: (string | number)[]; message: string }[] {
  if (item.ledger_account !== null) return [];
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (item.amount_cents !== 0) issues.push({ path: ["amount_cents"], message: "a kit header holds no money" });
  if (item.price.price_formula.basis !== "flat") issues.push({ path: ["price", "price_formula"], message: "a kit header is flat" });
  return issues;
}

/**
 * A `zero_priced` payable line carries no charge. `checkZeroPricedAmount` reads
 * `rates`, which a flat payable line does not have, so it would pass vacuously here.
 */
export function zeroPricedMoneyIssues(
  item: { zero_priced: boolean | null; amount_cents: number | null; price: { rates: readonly { amount_cents: number }[] } },
): { path: (string | number)[]; message: string }[] {
  if (item.zero_priced !== true) return [];
  if (item.price.rates.some((r) => r.amount_cents !== 0) || (item.amount_cents !== null && item.amount_cents !== 0)) {
    return [{ path: ["amount_cents"], message: "a zero-priced line carries no charge" }];
  }
  return [];
}

/** Only a subrent states what its supplier charges for a lost unit. */
function replacementIssues(item: { price: { replacement_cents?: number | null } }): { path: (string | number)[]; message: string }[] {
  return item.price.replacement_cents != null
    ? [{ path: ["price", "replacement_cents"], message: "only a subrent line states a replacement" }]
    : [];
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`. Each arm's refine sits HERE, on the Inner const: a
// refine on an exported alias never runs inside the union (`invoice.ts`,
// `checkZeroPricedAmount`).
const SaleItemInner = z.strictObject({
  type: z.literal("sale").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  quantity: quantityKey,
  ...itemShape,
  ledger_account: PayableKitLedgerAccount,
  amount_cents: amountKey,
  price: PurchaseLinePriceSchema,
  quantity_billed: billedKey,
  landed_costs: z.array(PurchaseLandedCostSchema).meta({ label: "Landed Cost" }),
}).superRefine((item, ctx) => {
  storedUidIssue(item, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  addIssues(payablePostingIssues(item.type, item.ledger_account), ctx);
  addIssues(kitHeaderIssues(item), ctx);
  addIssues(zeroPricedMoneyIssues(item), ctx);
  addIssues(replacementIssues(item), ctx);
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

const RentalItemInner = z.strictObject({
  type: z.literal("rental").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  quantity: quantityKey,
  ...itemShape,
  ledger_account: PayableKitLedgerAccount,
  amount_cents: amountKey.nullable(),
  price: PurchaseLinePriceSchema,
  quantity_billed: billedKey.nullable(),
  uid_orders: z.array(FirestoreId),
}).superRefine((item, ctx) => {
  storedUidIssue(item, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  addIssues(payablePostingIssues(item.type, item.ledger_account), ctx);
  addIssues(kitHeaderIssues(item), ctx);
  addIssues(zeroPricedMoneyIssues(item), ctx);
});

// The no-custody arms' shared keys; `replacement` adds a required record.
const noCustodyShape = {
  quantity: quantityKey,
  ...itemShape,
  amount_cents: amountKey.nullable(),
  price: PurchaseLinePriceSchema,
  quantity_billed: billedKey.nullable(),
} as const;

function noCustodyIssues(
  item: PurchaseServiceItem | PurchaseReplacementItem,
  ctx: z.RefinementCtx,
): void {
  storedUidIssue(item, ctx);
  addIssues(purchaseLineMoneyIssues(item), ctx);
  addIssues(payablePostingIssues(item.type, item.ledger_account), ctx);
  addIssues(replacementIssues(item), ctx);
  if (item.type === "replacement") {
    for (const [path, message] of outOfServiceLinkIssues(item)) {
      ctx.addIssue({ code: "custom", path, message });
    }
  }
}

const ServiceItemInner = z.strictObject({
  type: z.literal("service").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  ...noCustodyShape,
}).superRefine((item, ctx) => noCustodyIssues(item, ctx));

const ReplacementItemInner = z.strictObject({
  type: z.literal("replacement").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  ...noCustodyShape,
  // A whole value in the `flat_money` group: it follows with `quantity` and
  // `amount_cents` as one unit, so a bill line's shares stay its quantity's.
  // Required since W4K's contract publish (it replaced `uid_out_of_service`).
  out_of_service: OutOfServiceList.meta({ seed: false, shared: "value", ...flatMoney }),
}).superRefine((item, ctx) => noCustodyIssues(item, ctx));

/** Zod schema for PurchaseSaleItem. */
export const PurchaseSaleItemSchema: z.ZodType<PurchaseSaleItem> = SaleItemInner;
/** Zod schema for PurchaseRentalItem. */
export const PurchaseRentalItemSchema: z.ZodType<PurchaseRentalItem> = RentalItemInner;
/** Zod schema for PurchaseServiceItem. */
export const PurchaseServiceItemSchema: z.ZodType<PurchaseServiceItem> = ServiceItemInner;
/** Zod schema for PurchaseReplacementItem. */
export const PurchaseReplacementItemSchema: z.ZodType<PurchaseReplacementItem> = ReplacementItemInner;

/** Zod schema for any purchase item — discriminated on `type`. */
export const PurchaseItemSchema: z.ZodType<PurchaseItem> = z.discriminatedUnion("type", [
  SaleItemInner,
  RentalItemInner,
  ServiceItemInner,
  ReplacementItemInner,
]);

/** Zod schema for any {@link PurchaseRow} — a line or a destination/group divider. */
export const PurchaseRowSchema: z.ZodType<PurchaseRow> = z.discriminatedUnion("type", [
  DestinationDividerArm,
  GroupDividerArm,
  SaleItemInner,
  RentalItemInner,
  ServiceItemInner,
  ReplacementItemInner,
]);

// ── Per-arm rules ────────────────────────────────────────────────
//
// Each is an exhaustive switch with a `never` default, so a new item type is a
// compile error here rather than a silent fall-through (D7). They live in the
// schema module because the document refine calls them and `utils/` imports
// `schemas/` one way only; `@cfs/core/utils/purchases` re-exports them.

function unreachableItem(item: never): never {
  throw new Error(`unknown purchase item type: ${JSON.stringify(item)}`);
}

/**
 * The amount an item COMMITS up front — the term of the purchase's
 * `total_cents` (owner, 2026-10-30): a flat line's net amount, and 0 for a time
 * line, whose cost is decided as it accrues.
 */
export function purchaseItemCommittedCents(item: PurchaseItem): number {
  switch (item.type) {
    case "sale":
      return item.amount_cents;
    case "rental":
    case "service":
    case "replacement":
      return item.amount_cents ?? 0;
    default:
      return unreachableItem(item);
  }
}

/**
 * The product an item ORDERS — a sale or rental line's uid — or `undefined`: a
 * service line's `uid_product` is attribution, and a replacement's twin is not
 * an order.
 */
export function purchaseItemProduct(item: PurchaseItem): string | undefined {
  switch (item.type) {
    case "sale":
    case "rental":
      return item.uid;
    case "service":
    case "replacement":
      return undefined;
    default:
      return unreachableItem(item);
  }
}

/** The prefix a payable line no product keys carries, as an order or invoice custom line's (`order-lines.ts`). */
const CUSTOM_LINE_PREFIX = "custom-";

/** The payable line fields {@link payableLineUid} reads. */
export interface PayableLineUidFields {
  type: string;
  uid: string;
}

const isCustomUid = (uid: string): boolean => uid.startsWith(CUSTOM_LINE_PREFIX);
/** A uid shaped like a catalog document's: a Firestore id, as a product's is. */
const isCatalogUid = (uid: string): boolean => FirestoreId.safeParse(uid).success;

/**
 * The `uid` a payable line takes: its product's, as an order or invoice line's
 * is (one-document-model W4K, owner ruling 12). Since 7a the uid is the ONLY
 * place a line names its product: no line carries `uid_product` (owner,
 * 2026-11-11), so the payable line has the order line's shape exactly.
 *
 * - `sale` / `rental` → its own uid, which names the product.
 * - `service` / `replacement` → its own uid when it names a catalog product (a
 *   `service` product; a replacement's lost-rental TWIN, ruling 15), else a
 *   `custom-` uid. A line already carrying one keeps it; any other becomes
 *   `custom-` + its old uid, so a re-key is deterministic and repeatable.
 *
 * Which catalog product a service line may name (a `service` product, never
 * the rental it costs) is the WRITER's check: it needs the product's type.
 *
 * @throws when a `sale` or `rental` line carries a `custom-` uid, which every
 *   schema arm for those types refuses.
 */
export function payableLineUid(line: PayableLineUidFields): string {
  if (line.type === "sale" || line.type === "rental") {
    if (isCustomUid(line.uid)) throw new Error(`payableLineUid: a ${line.type} line names no product`);
    return line.uid;
  }
  if (isCustomUid(line.uid) || isCatalogUid(line.uid)) return line.uid;
  return `${CUSTOM_LINE_PREFIX}${line.uid}`;
}

/**
 * Why a stored payable line's `uid` is not {@link payableLineUid}'s, or `null`:
 * a `sale` or `rental` line's uid is a product's (never `custom-`); a `service`
 * or `replacement` line's names a catalog product or is `custom-`.
 *
 * Attached to every stored purchase line arm and, through `documentItemsIssues`
 * (`schemas/purchase-bill.ts`), to every bill and supplier-credit line.
 */
export function payableLineUidIssue(line: PayableLineUidFields): string | null {
  if (line.type === "sale" || line.type === "rental") {
    return isCustomUid(line.uid) ? `a ${line.type} line's uid is its product's, not ${line.uid}` : null;
  }
  return isCustomUid(line.uid) || isCatalogUid(line.uid)
    ? null
    : `a ${line.type} line's uid names a catalog product or is custom-, not ${line.uid}`;
}

/** {@link payableLineUidIssue} as a stored line arm's refine, at the line's `uid`. */
function storedUidIssue(line: PayableLineUidFields, ctx: z.RefinementCtx): void {
  const message = payableLineUidIssue(line);
  if (message !== null) ctx.addIssue({ code: "custom", path: ["uid"], message });
}

/**
 * Why a line INPUT carries a uid that cannot be its product, or `null`: a
 * `sale` or `rental` input names its product BY its uid, so a `custom-` one is
 * refused. Any `service` or `replacement` input uid is accepted: the writer
 * keeps a catalog one (after checking the product's type) and mints `custom-`
 * for the rest.
 */
export function payableInputUidIssue(line: { type: string; uid: string }): string | null {
  if ((line.type === "sale" || line.type === "rental") && isCustomUid(line.uid)) {
    return `a ${line.type} line names its product by its uid, not ${line.uid}`;
  }
  return null;
}

/**
 * Derive `query_by_products` — the distinct products the items ORDER, in first
 * appearance order. Attribution is not an order and is left out. The one author
 * of the mirror, called by every writer.
 */
export function deriveQueryByProducts(rows: readonly PurchaseRow[]): string[] {
  return [...new Set(purchaseLines(rows).map(purchaseItemProduct).filter((u): u is string => u !== undefined))];
}

/** Derive `query_by_orders` — the distinct union of the rental items' `uid_orders`, in first-seen order. */
export function deriveQueryByOrders(rows: readonly PurchaseRow[]): string[] {
  return [...new Set(purchaseLines(rows).flatMap((i) => (i.type === "rental" ? i.uid_orders : [])))];
}

/** Derive `query_by_item_types` — the distinct LINE types, in first-seen order (dividers are not a type of purchase). */
export function deriveQueryByItemTypes(rows: readonly Pick<PurchaseRow, "type">[]): PurchaseItemTypeType[] {
  return [...new Set(rows.filter(isPurchaseLine).map((i) => i.type as PurchaseItemTypeType))];
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

/**
 * A purchase's destination pair — the side-neutral {@link PairCoreType}, with
 * no customer flags, jurisdiction or exchange leg (one-document-model Phase 3).
 *
 * - `delivery` — where the goods come INTO CFS's hands: the store by default; a
 *   customer's address on a drop ship; the supplier's when CFS collects.
 * - `collection` — on a subrent, where they go BACK: the store by default, or
 *   the supplier's when CFS returns them there. `null` when nothing goes back.
 * - `dates` — the ORDER's shape (api-cloudrun#1469): possession runs
 *   `delivery_start` → `collection_start`, `delivery_end` and `collection_end`
 *   follow their starts (a real window later, api-cloudrun#943), `days_active`
 *   is counted, and `charge_windows` defaults to one window over possession.
 *   Supply reads `delivery_start` → `collection_end`, as a booking's hold does.
 *   A Buy's expected arrival IS its pair's `delivery_start` (C8, which retired
 *   the line `expected_date`): two buys expected on different days sit under
 *   two pairs.
 *   A standing hire states neither collection bound (`+∞` in supply); a pair
 *   with no hire states no dates at all.
 */
export type PurchaseDestination = PairCoreType;

/** Zod schema for {@link PurchaseDestination}. */
export const PurchaseDestinationSchema: z.ZodType<PurchaseDestination> = z.strictObject({ ...PairCore }).superRefine(
  (pair, ctx) => hireOrderIssue(pair.dates, ctx),
);

/**
 * A hire's SUPPLY end (`collection_end`) is not before its start: the rule the
 * stored and the input pair share. Possession's own order (`collection_start`
 * after `delivery_start`) is `applyDateEdit`'s, which every writer runs.
 */
function hireOrderIssue(
  dates: { delivery_start: string | null; collection_end: string | null },
  ctx: z.RefinementCtx,
): void {
  const { delivery_start: start, collection_end: end } = dates;
  if (start !== null && end !== null && Date.parse(end) < Date.parse(start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "collection_end"], message: "a hire ends at or after it starts" });
  }
}

/**
 * The pair a purchase line sits under — the destination divider at `path[0]`
 * — or `undefined` when the document carries no such pair.
 */
export function purchaseLinePair(
  purchase: Pick<Purchase, "destinations">,
  item: Pick<PurchaseItem, "path">,
): PurchaseDestination | undefined {
  return purchase.destinations.find((d) => d.uid === item.path[0]);
}

/**
 * A subrent line's hire window, read off its pair — `{start, end}` with a null
 * `end` open-ended — or `null` when the pair states no start.
 */
export function purchaseHireWindow(
  purchase: Pick<Purchase, "destinations">,
  item: Pick<PurchaseItem, "path">,
): PurchaseItemDates | null {
  const pair = purchaseLinePair(purchase, item);
  if (!pair || pair.dates.delivery_start === null) return null;
  return { start: pair.dates.delivery_start, end: pair.dates.collection_end };
}

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
  /**
   * The store the goods come to (`stores/{uid}`) — the order's key, and REQUIRED
   * where the order's is optional nullable (C8): a purchase always names its
   * store, and tax ORIGIN reads it. A uid only, as on the order; a reader names
   * it from its stores cache.
   */
  uid_store: string;
  /** The day the order was placed. A calendar date. */
  date: string;
  date_fs: FirestoreTimestampType;
  /**
   * What the purchase is FOR, operator-typed, `""` for none — the order's
   * `subject`, on the payable side (owner, 2026-11-11: one model, no divergence
   * by default). It reaches the receipt and the bills by the shared-field merge.
   * `pii: "mask"`: operators type shoot addresses into it on the order.
   */
  subject: string;
  /** The supplier's order or quote number, or `null`. */
  reference: string | null;
  /** Internal note, or `null` for none. */
  notes: string | null;
  /**
   * The lines under their dividers ({@link PurchaseRow}). Every line sits under
   * a destination divider, and each divider is answered by one pair in
   * {@link Purchase.destinations} (one-document-model Phase 3).
   */
  items: PurchaseRow[];
  /**
   * The purchase's destination pairs ({@link PurchaseDestination}): where the
   * goods arrive (`delivery`) and, for a subrent, where they go back
   * (`collection`), with the hire window on `dates`. One per destination
   * divider, joined by `uid`.
   */
  destinations: PurchaseDestination[];
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
   * purchase writer's transaction rather than range-read them. Required since
   * beta B (2026-11-01 census, 308 of 308 prod, 300 of 300 `test`; dev's one
   * dev-native seed purchase repaired): a create states `[]`.
   */
  query_by_bills: string[];
  /**
   * The bills raised against this purchase — `{ uid, number, status }`, the twin
   * of `order.invoices[]` (one-document-model ruling 32): display, Typesense
   * search/sort/filter, and a client read without opening each bill. Its uids
   * are exactly {@link query_by_bills}. Converged wherever a bill's status moves
   * (create, settle, void, close, reopen, the Xero webhook), with an eventarc
   * backstop on `purchase-bills`.
   *
   * Required since the 6e-0a backfill (2026-11-11); a new purchase is born with `[]`.
   */
  bills: Array<{ uid: string; number: number; status: InvoiceStatusType }>;
  /**
   * The supplier credits raised against this purchase — the twin of
   * `order.credit_notes[]`. Its uids are exactly {@link query_by_credits}. A
   * credit names this purchase as its first `sources` entry
   * (`derivePurchaseCreditSources`). Required since the 6e-0a backfill.
   */
  credits: Array<{ uid: string; number: number; status: PurchaseCreditStatusType }>;
  /** Uid list of {@link credits}. */
  query_by_credits: string[];
  /**
   * The purchase's inbound bookings' `breakdown`s summed — the order's
   * `bookings_breakdown`, on the supplier ladder (7a, owner 2026-11-11). Written
   * by the purchase finalize from committed bookings. A SUMMARY only: it adds
   * Buys and Subrents, whose `stocked` means different things (terminal for a
   * Buy, held for return on a Subrent), so no leg rule reads it; the receipt's
   * `due_at` reads the bookings themselves.
   */
  bookings_breakdown: InboundBreakdown;
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
 * asserted directly rather than through a recompute: each `path` non-empty,
 * self-inclusive, and once per document. A `uid` may repeat across parents.
 */
function itemIdentityIssues(items: readonly { uid: string; path: readonly string[] }[], ctx: z.RefinementCtx): void {
  const paths = new Set<string>();
  items.forEach((item, i) => {
    if (item.path.length === 0 || item.path.at(-1) !== item.uid) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path is self-inclusive: it ends in its own uid" });
    }
    const key = item.path.join("/");
    if (paths.has(key)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path appears once per document" });
    }
    paths.add(key);
  });
}

function checkPurchase(p: Purchase, ctx: z.RefinementCtx): void {
  itemIdentityIssues(p.items, ctx);
  // Dividers alone order nothing: a purchase orders at least one LINE.
  if (purchaseLines(p.items).length === 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a purchase orders at least one item" });
  }
  checkLeadingDivider("purchase")(p, ctx);
  checkDestinationJoin(p, ctx);
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

  const total = purchaseLines(p.items).reduce((sum, item) => sum + purchaseItemCommittedCents(item), 0);
  if (p.total_cents !== total) {
    ctx.addIssue({
      code: "custom",
      path: ["total_cents"],
      message: `total_cents ${p.total_cents} must equal the items' committed ${total}`,
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
  uid_store: FirestoreId.meta({ column: true, label: "Store" }),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date", ...homonym }),
  date_fs: FirestoreTimestamp.meta(homonym),
  // Bare `z.string()`, as on the order, fulfillment and invoice (`tests/subject-parity.test.ts`).
  subject: z.string().meta({ pii: "mask", column: true, label: "Subject", linkTo: "purchaseDetail", propagate: true }),
  reference: z.string().max(200).nullable().meta({ column: true, label: "Reference", ...homonym }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" }).nullable(),
  // A component (a charge placed under the product it costs, a kit's part)
  // states `zero_priced`, and only a component may be flagged — as on the order,
  // invoice, fulfillment and receipt (C15 item 1). The writer refused both
  // before; this is what lets a corpus re-parse see a stored violation.
  items: z.array(PurchaseRowSchema).min(1).meta({ label: "Item" }).superRefine(checkZeroPricedComponents),
  destinations: z.array(PurchaseDestinationSchema).min(1).meta({ label: "Destination" }),
  total_cents: z.int().min(0).meta({ column: true, label: "Total", ...homonym }),
  query_by_products: z.array(FirestoreId).meta({ derived: true }),
  query_by_orders: z.array(FirestoreId).meta({ derived: true }),
  query_by_item_types: z.array(PurchaseItemTypeEnum).meta({ derived: true }),
  query_by_bills: z.array(FirestoreId).meta({ derived: true }),
  // 6e-0a (ruling 32): required once the backfill stated them everywhere.
  bills: z.array(z.strictObject({
    uid: FirestoreId,
    number: z.int().meta({ column: true, label: "#" }),
    status: InvoiceStatusEnum.meta({ column: true, label: "Status" }),
  })).meta({ label: "Bill" }),
  credits: z.array(z.strictObject({
    uid: FirestoreId,
    number: z.int().meta({ column: true, label: "#" }),
    status: PurchaseCreditStatusEnum.meta({ column: true, label: "Status" }),
  })).meta({ label: "Supplier Credit" }),
  query_by_credits: z.array(FirestoreId).meta({ derived: true }),
  // The inbound bookings' breakdowns summed, the order's `bookings_breakdown`
  // twin (7a, owner 2026-11-11). Written by `finalize-purchase`; a summary for
  // display, never a leg rule (it sums Buys and Subrents, whose keys differ).
  bookings_breakdown: InboundBreakdownSchema.meta({ derived: true }),
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
    columns: ["number", "date", "supplier.name", "subject", "status", "total_cents"],
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
  /** What this supplier charges CFS for a lost unit. A subrent line only. */
  replacement_cents?: number | null;
}

/**
 * The keys every item input carries. `uid` is the line's product's uid on a
 * line naming one (refined on each arm, {@link payableInputUidIssue}), and the
 * row's identity is its `path`: an update pairs rows with the stored ones by
 * path, then by uid and ancestry, as an order's does. Both `uid` and `path` are
 * required: the uid is the path's last segment.
 *
 * `uid_tracking_category` takes the SAME rule as an order or invoice line's
 * (`resolveLinePosting`, `api-cloudrun/src/lib/lineDenorms.ts`): absent KEEPS
 * what is stored (a new item takes the product's category); `null` returns it to
 * the product's category — never "untracked"; a uid SETS it and must name a
 * live category. `ledger_account` is absent-KEEPS, value-SETS, with the writer's
 * default on a new item (D4): a sale's is `xeroPostingFor("purchase", …)`'s asset
 * account, a rental's 5100, and a `service` or `replacement` charge's its
 * nearest ancestor LINE's account as the writer resolves it in the same build
 * (ruling 74): a charge placed under a row costs that row, so it posts where the
 * row posts until the operator states otherwise. A top-level charge has no
 * default, so absent on a new one is a 400. Whichever account is stated, the
 * arm's {@link payablePostingIssues} class binds.
 *
 * `description` absent KEEPS what is stored and is `""` on a new item;
 * `uid_tax_class_override` absent KEEPS, `null` clears it. The line's
 * `uid_tax_class` is the writer's, stamped from its type's default class.
 */
interface PurchaseItemInputBase {
  uid: string;
  /** The row's identity, its last segment the `uid`; the first names the pair it sits under. */
  path: string[];
  description?: string;
  /** A kit component's flag, as on an order line's input. The writer states `false` for a component that leaves it out. */
  zero_priced?: boolean | null;
  /** A kit component's ratio to its direct parent. */
  quantity_per_parent?: number | null;
  uid_tracking_category?: string | null;
  uid_tax_class_override?: string | null;
  price?: PurchaseLinePriceInputType;
}

/** A sale (Buy) item as an operator orders it — the buckets are the server's. */
export interface PurchaseSaleItemInputType extends PurchaseItemInputBase {
  type: "sale";
  quantity: number;
  /** The whole cost — GROSS when `price.discount` is set. */
  amount_cents: number;
  /** `null` is a stored kit header echoed back; the writer decides what a `none` product holds. */
  ledger_account?: COACodeType | null;
  /**
   * The item's WHOLE landed-cost set. Absent keeps what is stored, so a client
   * that never names landed costs cannot erase them: this is a replacement, and
   * a default here would delete what the client did not restate. Present: a
   * stored entry missing from it is removed, which the writer refuses once a
   * receipt has priced it.
   */
  landed_costs?: PurchaseLandedCostInputType[];
}

/**
 * A rental (Subrent) item as an operator orders it. `amount_cents` on a flat line
 * only (gross when discounted). Its hire window is its pair's dates, stated on
 * `destinations[]`, never on the line (one-document-model Phase 5b).
 */
export interface PurchaseRentalItemInputType extends PurchaseItemInputBase {
  type: "rental";
  quantity: number;
  amount_cents?: number | null;
  /** `null` is a stored kit header echoed back; the writer decides what a `none` product holds. */
  ledger_account?: COACodeType | null;
  /** The orders the item was raised for. Absent is `[]`: the writer states it. */
  uid_orders?: string[];
  /** Retired — see `retiredUnitsKey`. Present is a 400. */
  uid_units?: never;
}

/**
 * A service (Charge) item as an operator raises it. Its account is the
 * operator's, except that a charge PLACED under a line and stating none takes
 * that line's (ruling 74); see {@link PurchaseItemInputBase}.
 */
export interface PurchaseServiceItemInputType extends PurchaseItemInputBase {
  type: "service";
  name: string;
  quantity?: number;
  amount_cents?: number | null;
  /** Absent KEEPS on an amend; on a new item the writer's default, which only a placed charge has. */
  ledger_account?: COACodeType;
  /** Retired — see `retiredUnitsKey`. Present is a 400. */
  uid_units?: never;
}

/**
 * A replacement item as an operator raises it: a {@link PurchaseServiceItemInputType}
 * naming its record(s) in `out_of_service`. Its uid names the lost rental's twin
 * when the writer derives one (ruling 15), else the writer mints `custom-`.
 */
export interface PurchaseReplacementItemInputType extends Omit<PurchaseServiceItemInputType, "type"> {
  type: "replacement";
  /** Shares sum to `quantity` when it is stated. */
  out_of_service: OutOfServiceEntryType[];
}

/** Union of every item input arm. */
export type PurchaseItemInputType =
  | PurchaseSaleItemInputType
  | PurchaseRentalItemInputType
  | PurchaseServiceItemInputType
  | PurchaseReplacementItemInputType;

const PurchaseLinePriceInput: z.ZodType<PurchaseLinePriceInputType> = z.object({
  uid_price_formula: FirestoreId.optional(),
  rates: z.array(z.object({ rate_key: RateKey, amount_cents: z.int().min(0) })).optional(),
  discount: DiscountInput.nullable().optional(),
  replacement_cents: z.int().nullable().optional(),
});
const inputHead = {
  uid: ItemUid,
  path: z.array(ItemUid).min(1),
  description: LineItemCore.description.optional(),
  zero_priced: z.boolean().nullable().optional(),
  quantity_per_parent: z.number().min(0).nullable().optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
  uid_tax_class_override: FirestoreId.nullable().optional(),
  price: PurchaseLinePriceInput.optional(),
};

function inputPostingIssue(
  item: { type: SharedLineType; ledger_account?: number | null; price?: PurchaseLinePriceInputType },
  ctx: z.RefinementCtx,
): void {
  if (item.ledger_account !== undefined) addIssues(payablePostingIssues(item.type, item.ledger_account), ctx);
  if (item.type !== "rental" && item.price?.replacement_cents != null) {
    ctx.addIssue({ code: "custom", path: ["price", "replacement_cents"], message: "only a subrent line states a replacement" });
  }
}

/**
 * `uid_units` on a line input, declared only so a payload still carrying it is
 * REFUSED rather than stripped. The input is a stripping `z.object`, so without
 * this a client naming units would get a 200 and a line that names nothing.
 * A charge lost it to ruling 73 (2026-11-11), a Subrent to ruling 79
 * (2026-11-12): a purchase line names no units, as an order line names none;
 * units are named at the custody step and held on the inbound booking. Same
 * shape as `retiredKey` in `schemas/booking.ts`, including the OpenAPI meta its
 * comment explains.
 */
function retiredUnitsKey(why: string) {
  return z.never({ error: `"uid_units" is retired: ${why}` })
    .meta({ type: "null", not: {}, description: `Retired: ${why}. Present is a 400.` })
    .optional();
}

const noCustodyInput = {
  ...inputHead,
  name: LineItemCore.name,
  quantity: z.int().min(1).optional(),
  amount_cents: z.int().min(0).nullable().optional(),
  // Optional, not nullable: `null` is a kit header's, and a charge is never one.
  ledger_account: COACode.optional(),
  uid_units: retiredUnitsKey("a charge names no units; place it under the product row it costs"),
};

/** A line input names its product by its uid ({@link payableInputUidIssue}). */
function inputUidIssue(item: { type: string; uid: string }, ctx: z.RefinementCtx): void {
  const message = payableInputUidIssue(item);
  if (message !== null) ctx.addIssue({ code: "custom", path: ["uid"], message });
}

function noCustodyInputIssues(
  item: PurchaseServiceItemInputType | PurchaseReplacementItemInputType,
  ctx: z.RefinementCtx,
): void {
  inputPostingIssue(item, ctx);
  inputUidIssue(item, ctx);
}

// Un-annotated so both unions below can list them flat: an annotated union cannot
// nest inside another discriminated union (`order.ts`'s `OrderItem` arms).
const saleItemInputArm = z.object({
  type: z.literal("sale"),
  ...inputHead,
  quantity: z.int().min(1),
  amount_cents: z.int().min(0),
  ledger_account: COACode.nullable().optional(),
  landed_costs: z.array(PurchaseLandedCostInput).optional(),
}).superRefine((item, ctx) => {
  inputPostingIssue(item, ctx);
  inputUidIssue(item, ctx);
  const named = new Set<string>();
  item.landed_costs?.forEach((entry, k) => {
    if (entry.uid === undefined) return;
    if (named.has(entry.uid)) {
      ctx.addIssue({ code: "custom", path: ["landed_costs", k, "uid"], message: "a landed cost uid appears once per item" });
    }
    named.add(entry.uid);
  });
});

const rentalItemInputArm = z.object({
  type: z.literal("rental"),
  ...inputHead,
  quantity: z.int().min(1),
  amount_cents: z.int().min(0).nullable().optional(),
  ledger_account: COACode.nullable().optional(),
  uid_orders: z.array(FirestoreId).optional(),
  uid_units: retiredUnitsKey("a purchase line names no units; name them on the receipt's custody step"),
}).superRefine((item, ctx) => {
  inputPostingIssue(item, ctx);
  inputUidIssue(item, ctx);
});

const serviceItemInputArm = z.object({ type: z.literal("service"), ...noCustodyInput })
  .superRefine((item, ctx) => noCustodyInputIssues(item, ctx));

const replacementItemInputArm = z.object({
  type: z.literal("replacement"),
  ...noCustodyInput,
  out_of_service: OutOfServiceListInput.meta({ seed: false }),
}).superRefine((item, ctx) => {
  noCustodyInputIssues(item, ctx);
  for (const [path, message] of outOfServiceLinkIssues(item)) {
    ctx.addIssue({ code: "custom", path, message });
  }
});

/** Zod schema for PurchaseItemInputType — non-strict arms, so extra keys strip. */
export const PurchaseItemInput: z.ZodType<PurchaseItemInputType> = z.discriminatedUnion("type", [
  saleItemInputArm,
  rentalItemInputArm,
  serviceItemInputArm,
  replacementItemInputArm,
]);

/** A divider row as a client sends it on a purchase. */
interface PurchaseDividerInputBase {
  uid: string;
  path: string[];
  name?: string;
  description?: string;
}

/** A destination divider as a client sends it on a purchase; `uid` is its pair's. */
export interface PurchaseDestinationRowInputType extends PurchaseDividerInputBase {
  type: "destination";
}

/** A group divider as a client sends it on a purchase. */
export interface PurchaseGroupRowInputType extends PurchaseDividerInputBase {
  type: "group";
}

/** One row of a purchase's `items` input: a line, or one of the two dividers. */
export type PurchaseRowInputType =
  | PurchaseItemInputType
  | PurchaseDestinationRowInputType
  | PurchaseGroupRowInputType;

// Stripping `z.object`s, as the bill's are: the strict order and invoice divider
// arms are a ruling for those two documents, and `tests/input-strictness.test.ts`
// refuses a new strict input node. `uid` is `z.uuid()`, the stored arm's type;
// `ItemUid` would parse here and then fail at storage. Name bounds are the stored
// arms' (`_dividers.ts`).
const destinationRowInputArm = z.object({
  type: z.literal("destination"),
  uid: z.uuid(),
  path: z.array(ItemUid).min(1),
  name: z.string().max(200).meta({ pii: "mask" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
});

const groupRowInputArm = z.object({
  type: z.literal("group"),
  uid: z.uuid(),
  path: z.array(ItemUid).min(1),
  name: z.string().min(1).max(100).meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
});

/**
 * Zod schema for {@link PurchaseRowInputType}. Line arms first, because
 * `getInitialValues` resolves a union by its first arm.
 */
export const PurchaseRowInput: z.ZodType<PurchaseRowInputType> = z.discriminatedUnion("type", [
  saleItemInputArm,
  rentalItemInputArm,
  serviceItemInputArm,
  replacementItemInputArm,
  destinationRowInputArm,
  groupRowInputArm,
]);

/**
 * A destination pair as a client sends it to a purchase: the side-neutral
 * {@link PairInputCore} and a required `uid`, its destination divider's.
 *
 * The input twin of {@link PurchaseDestination}, in the order's date shape:
 * `dates.delivery_start` → `dates.collection_start` is a subrent's hire
 * (possession), `collection_end` its supply end, and `charge_windows` what a
 * time line meters.
 *
 * `delivery` is required and `collection` required-nullable, as on an order:
 * `null` is no return leg, and the store is stated as `uid: null`.
 */
export interface PurchaseDestinationInputType {
  uid: string;
  dates: OrderDatesType;
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType | null;
}

/**
 * Zod schema for {@link PurchaseDestinationInputType}. `OrderDates` checks no
 * boundary against another, so the collection bounds are both-or-neither here:
 * a `collection_end` left null reads as `+∞` supply, so a stated
 * `collection_start` obliges an end; and a stated `collection_end` obliges a
 * `collection_start`.
 *
 * ⚠️ **The second half refuses the retired hire shape** (`delivery_start` →
 * `collection_end`, the rest null) rather than translating it — no backwards
 * compatibility (owner, api-cloudrun#1469). Accepted, that body would store a
 * hire with no possession end, no charge window and nothing for a time line to
 * meter. The order and invoice inputs carry no such cross-field rule; this one
 * exists only so an old client fails loudly.
 */
export const PurchaseDestinationInput: z.ZodType<PurchaseDestinationInputType> = z.object({
  uid: z.uuid(),
  ...PairInputCore,
}).superRefine(purchaseDestinationInputIssues);

/** The rules a payable pair input carries, shared with a bill's pair input. */
export function purchaseDestinationInputIssues(
  pair: Pick<PurchaseDestinationInputType, "dates">,
  ctx: z.RefinementCtx,
): void {
  hireOrderIssue(pair.dates, ctx);
  const { collection_start: start, collection_end: end } = pair.dates;
  if (start === null) {
    if (end !== null) {
      ctx.addIssue({ code: "custom", path: ["dates", "collection_start"], message: "a hire with a collection end states its collection start" });
    }
    return;
  }
  if (end === null) {
    ctx.addIssue({ code: "custom", path: ["dates", "collection_end"], message: "a hire with a collection start states its end" });
  } else if (Date.parse(end) < Date.parse(start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "collection_end"], message: "a hire ends at or after its collection starts" });
  }
}

/**
 * A row named twice in one write is ambiguous: which one is kept? Keyed on the
 * PATH, the row identity: a line's uid is its product's (W4K), and one product
 * legitimately sits in two groups or under two pairs.
 */
function uniqueRowPaths(items: readonly { path: readonly string[] }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = item.path.join("/");
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "a row path appears once per write" });
    }
    seen.add(key);
  });
}

/**
 * The whole-array rules a purchase's `items` input carries: it leads with a
 * destination divider, and holds a line.
 *
 * ⚠️ **The leading-divider rule is also what refuses an old flat body.** A line's
 * arm strips, so a stale `dates` is dropped rather than refused, and only this
 * refine and the required `path` stop a hire window being lost silently. Neither
 * may be relaxed.
 */
function purchaseRowsIssues(items: readonly PurchaseRowInputType[], ctx: z.RefinementCtx): void {
  uniqueRowPaths(items, ctx);
  for (const v of leadingDividerViolations(items, "purchase", false)) {
    ctx.addIssue({
      code: "custom",
      path: ["items", 0, "type"],
      message: `a purchase must lead with a ${v.expected} divider, not ${v.found ?? "an untyped row"}`,
    });
  }
  if (items.length > 0 && items.every((row) => row.type === "destination" || row.type === "group")) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a purchase holds at least one line" });
  }
}

/**
 * Input for creating a purchase.
 *
 * `supplier` is a uid only — the server resolves the name, as
 * `CreateTransactionInput.supplier` does, so a snapshot never disagrees with
 * its document. `uid_store` is stored as sent. Items of any arm may mix (D3).
 *
 * ⚠️ **`store` → `uid_store` (C8) has no safe order between the API and the
 * manager**: a required key on a stripping input. It ships under the 7a
 * window's manager freeze.
 */
export interface CreatePurchaseInputType {
  supplier: { uid: string };
  uid_store: string;
  date: string;
  subject?: string;
  reference?: string | null;
  notes?: string | null;
  /**
   * The whole array in its order: dividers and lines. `computeItemPaths` authors
   * each stored path from the rows' positions and parents.
   */
  items: PurchaseRowInputType[];
  /** One per destination divider, joined `pair.uid === divider.uid`. */
  destinations: PurchaseDestinationInputType[];
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
  uid_store: FirestoreId,
  date: chicagoStartOfDay(),
  subject: z.string().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  items: z.array(PurchaseRowInput).min(1),
  destinations: z.array(PurchaseDestinationInput).min(1, "At least one destination is required"),
  uuid_session: z.uuid(),
}).superRefine((p, ctx) => purchaseRowsIssues(p.items, ctx));

/**
 * Input for amending a purchase — a PATCH.
 *
 * `items`, when present, is the complete next array of dividers and lines, paired
 * with the stored rows by path (then uid and ancestry, `pairItemsAcrossRebuild`),
 * never by uid alone: a line's uid is its product's. A stored item absent from it is removed — refused once it has any
 * receipt, bill or return. A named item may not change `type`. On a buy the
 * writer refuses to cut `quantity` below what is received or billed, and to
 * change `amount_cents` once it has any receipt or bill: a price that moved
 * after goods or a bill exist is a short close plus a new item, because every
 * receipt already carries its share of the old price. Those are cross-document
 * facts the writer holds, so they are not refined here.
 *
 * ⚠️ **A SUBRENT item's price is not frozen by a receipt**, because its receipts
 * carry no cost (`subrent_in` is cost-forbidden). So on a subrent the writer lets
 * `amount_cents` and its pair's `dates.collection_end` move after receipt — a
 * paid hire extension — with `quantity` still floored at what is received.
 *
 * `destinations`, when present, states the listed pairs. Absent keeps every
 * stored pair as it is.
 */
export interface UpdatePurchaseInputType {
  date?: string;
  subject?: string;
  reference?: string | null;
  notes?: string | null;
  items?: PurchaseRowInputType[];
  destinations?: PurchaseDestinationInputType[];
  version: number;
}

/** Zod schema for UpdatePurchaseInputType. */
export const UpdatePurchaseInput: z.ZodType<UpdatePurchaseInputType> = z.object({
  date: chicagoStartOfDay().optional(),
  subject: z.string().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  items: z.array(PurchaseRowInput).min(1).optional(),
  destinations: z.array(PurchaseDestinationInput).min(1, "At least one destination is required").optional(),
  version: z.int().min(0),
}).superRefine((p, ctx) => {
  if (p.items) purchaseRowsIssues(p.items, ctx);
});

/**
 * Input for a short close or a cancel.
 *
 * Lowers each named buy or subrent item's `quantity` to what was received and a
 * flat charge's to what was billed, restating its money; a line with nothing
 * left is REMOVED, its inbound booking kept while it holds custody
 * (`purchaseLineCloseOutcome`, ruling 47). A time charge keeps its quantity and
 * its pair's charge window ends (ruling 63). `path_purchase_items` absent closes
 * every such item; a cancel is a close of a purchase with nothing received. Billed beyond what was received is
 * a diff entry the operator credits by hand; a close raises no credit.
 */
export interface ClosePurchaseInputType {
  /** The lines to close, each by its path (row identity; a uid repeats once a line is keyed by its product). */
  path_purchase_items?: string[][];
  version: number;
}

/** Zod schema for ClosePurchaseInputType. */
export const ClosePurchaseInput: z.ZodType<ClosePurchaseInputType> = z.object({
  path_purchase_items: z.array(z.array(ItemUid).min(1)).min(1).optional(),
  version: z.int().min(0),
});

// ── Subrent extension input (one-document-model ruling 57) ───────

/** One row of a subrent extension: the units of one leg-A subrent row CFS keeps. */
export interface ExtendSubrentLineType {
  /** The row's CURRENT path on leg A. */
  path: string[];
  /** Units to move onto leg B; at most the row's quantity, and at most what is stocked on A. */
  quantity: number;
  /**
   * Which units CFS keeps, on a `serialized` product: exactly `quantity` numbers,
   * each in leg A's inbound booking `units.stocked`. Required for a serialized
   * product and refused for any other (the operator picks, the server never
   * infers; serial-tracking D3).
   */
  units?: number[];
  /**
   * What the supplier charges for the extension on a FLAT line, integer cents,
   * on top of the moved units' share of the line's amount (owner, 2026-11-12:
   * "split, then add"). Required on a flat line (0 is a free extension) and
   * refused on a time line, whose rates meter leg B's window as an order's do.
   */
  extension_cents?: number;
}

/**
 * The body of `POST /purchases/{uid}/extensions`: CFS keeps some of a subrent
 * leg's units past the supplier's collection (ruling 57, the twin of
 * {@link ExtendRentalInputType} on an order).
 *
 * The write mints leg B (A's delivery, the new collection), moves each row's
 * `quantity` from A to B and rebooks the units' custody from A's inbound booking
 * to B's (`subrent_rebook_out` / `subrent_rebook_in`), so the bill meters each
 * window. A flat line's amount is split at the partition (A keeps the share of
 * its remaining units, B takes the moved units' share, each rounded on the
 * cumulative amount so they sum to the original) and B adds `extension_cents`.
 *
 * Its own schema rather than the order's: `extension_cents` has no order
 * meaning, since an order line is always priced by its rates. Undo takes
 * {@link UndoRentalExtensionInput} unchanged (the version alone).
 *
 * A `z.object`, as the order's: an api older than a field strips it.
 */
export interface ExtendSubrentInputType {
  /** Leg A: the pair whose units CFS keeps. */
  uid_pair_from: string;
  /** Where the supplier collects the new leg from; `null` is leg A's own collection endpoint. */
  collection: DestinationEndpointType | null;
  /** The new collection; it must be later than leg A's. */
  collection_start: string;
  /** Defaults to `collection_start`. */
  collection_end?: string | null;
  lines: ExtendSubrentLineType[];
  /** The purchase's version, as for `PUT /purchases/{uid}`. */
  version: number;
}

/** Zod schema for {@link ExtendSubrentInputType}. */
export const ExtendSubrentInput: z.ZodType<ExtendSubrentInputType> = z.object({
  uid_pair_from: z.uuid(),
  collection: DestinationEndpoint.nullable(),
  collection_start: chicagoInstant(),
  collection_end: chicagoInstant().nullable().optional(),
  lines: z.array(
    z.object({
      path: z.array(z.string()).min(2),
      quantity: z.int().min(1),
      units: UnitSet.optional(),
      extension_cents: z.int().min(0).optional(),
    }).refine((l) => l.units === undefined || l.units.length === l.quantity, {
      message: "a line that names units names exactly `quantity` of them",
      path: ["units"],
    }),
  ).min(1),
  version: z.int().min(0),
});
