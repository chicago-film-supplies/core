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
 * | `type` | what CFS gets | custody | supply | cost |
 * |---|---|---|---|---|
 * | `buy` | ownership | receipts raise `quantity_held` and basis | `inbound` until received | `amount_cents` |
 * | `subrent` | units for a hire window | `subrent_in` / `subrent_out`, never owned | `subrent` over `dates` | `billing` — fixed or activation-billed |
 * | `usage` | a carrier line on a device CFS OWNS | none | none | derived from activation spans |
 * | `direct` | freight, a fee, anything not a product | none | none | `amount_cents` |
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
 * account (`COA_ASSET_CODES`), a subrent or usage item to a Direct Costs account
 * (`COA_COST_CODES`), a direct item to any account. Both are
 * `propagate: true`, so a bill item follows its purchase item's posting until an
 * operator changes it there.
 *
 * ⚠️ **`SubrentItem.billing` is a discriminated union NESTED inside an arm of
 * the item union** (`basis: "fixed" | "activation"`) — a deliberate NEW PATTERN
 * for a stored document (owner, 2026-10-30, at the core-conformance pass). A
 * Vision unit is custody AND cost on one item: "we only pay when it's active".
 * The precedent for a payload union is `Product.cogs` and the card's sources;
 * neither sits inside another union's arm. Its walkers are pinned in
 * `tests/purchases.test.ts`.
 *
 * ## Money
 *
 * `amount_cents` is what the whole item costs, integer cents. The k-th receipt
 * or bill against an item is priced by `cumulativeShareCents`
 * (`@cfs/core/utils/purchases`), which rounds the CUMULATIVE share once, so the
 * partials sum to `amount_cents` exactly with no remainder rule. There is no
 * stored `unit_cost`: it is a display rate, derivable by `perUnitCostAt4dp`, and
 * a stored copy beside the amount it derives from is a second source of truth.
 *
 * `total_cents` is the COMMITTED amount (owner, 2026-10-30): Σ over the items
 * that state an amount up front — buy, fixed-basis subrent and direct. An
 * activation-billed subrent and a usage item have no amount and add 0; what was
 * billed against them is their bills' totals.
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
import { FirestoreId, ItemUid, OutOfServiceId, ThreadId } from "./_uid.ts";
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
 * (`purchaseItemSupplies`, `purchaseItemResolved`, …), so a fifth member is a
 * compile error at every one of them rather than a silent fall-through into
 * the buy branch — which is how a pre-`kind` purchase used to be read.
 *
 * Explicit tuple type rather than `as const` alone: core#43 is JSR's npm
 * `.d.ts` emit truncating an inferred tuple.
 */
export const PURCHASE_ITEM_TYPES: readonly ["buy", "subrent", "usage", "direct"] = [
  "buy",
  "subrent",
  "usage",
  "direct",
];
/** One {@link PURCHASE_ITEM_TYPES} member. */
export type PurchaseItemTypeType = typeof PURCHASE_ITEM_TYPES[number];
/** Zod schema for PurchaseItemTypeType. */
export const PurchaseItemTypeEnum: z.ZodType<PurchaseItemTypeType> = z.enum(PURCHASE_ITEM_TYPES);

/** The arms that name a product and are billed by a product projection on a bill. */
export const PURCHASE_PRODUCT_ITEM_TYPES: readonly ["buy", "subrent", "usage"] = ["buy", "subrent", "usage"];
/** One {@link PURCHASE_PRODUCT_ITEM_TYPES} member. */
export type PurchaseProductItemTypeType = typeof PURCHASE_PRODUCT_ITEM_TYPES[number];

// ── Subrent pieces ───────────────────────────────────────────────

/**
 * A subrent item's hire window. `start` is when the units come; `end` is when
 * they are due back to the SUPPLIER, not when the customer returns them.
 *
 * `end: null` is a STANDING subrent — open-ended, `+∞` in availability as on
 * bookings and out-of-service records (serialized-subrent slice 2, folded in
 * here; api-cloudrun#1392). The hire window doubles as the expected delivery:
 * a subrent item has no separate `expected_date`.
 *
 * Named `dates` after out-of-service, bookings and cards. The object carries no
 * label of its own; its children are labelled, so the composed heading stays
 * "Item Hire Start" rather than doubling a word.
 */
export interface PurchaseItemDates {
  start: string;
  end: string | null;
}

/** Zod schema for PurchaseItemDates. */
export const PurchaseItemDatesSchema: z.ZodType<PurchaseItemDates> = z.strictObject({
  start: chicagoInstant().meta({ column: true, label: "Hire Start" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "Hire End" }),
});

/** How a subrent's cost is decided — see {@link SubrentBilling}. */
export const SUBRENT_BILLING_BASES: readonly ["fixed", "activation"] = ["fixed", "activation"];
/** One {@link SUBRENT_BILLING_BASES} member. */
export type SubrentBillingBasisType = typeof SUBRENT_BILLING_BASES[number];

/**
 * How a subrent item's cost is decided (owner, 2026-10-28; D9).
 *
 * - **`fixed`** — a per-job subrent: the supplier quotes the hire and
 *   `amount_cents` is what it costs. Every subrent before 2026-10 is this arm.
 * - **`activation`** — pay only while a unit is ACTIVE (Vision): the cost is
 *   derived from the units' activation spans under the product's `cogs`
 *   activation entry `uid_cogs` (`Product.cogs[].uid`), so there is no amount
 *   and no rate here. `quantity_billed` then counts billed PERIODS, not units.
 *
 * A nested discriminated union rather than a nullable `amount_cents` beside a
 * nullable `uid_cogs` — the house preference for an arm over a nullable pair
 * with a refine. See the module docblock: it is the one stored union nested
 * inside another union's arm.
 */
export type SubrentBilling =
  | { basis: "fixed"; amount_cents: number }
  | { basis: "activation"; uid_cogs: string };

const subrentFixedShape = {
  basis: z.literal("fixed"),
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
};
const subrentActivationShape = {
  basis: z.literal("activation"),
  uid_cogs: z.uuid(),
};

/** Zod schema for SubrentBilling. */
export const SubrentBillingSchema: z.ZodType<SubrentBilling> = z.discriminatedUnion("basis", [
  z.strictObject(subrentFixedShape),
  z.strictObject(subrentActivationShape),
]);

/** The input twin of {@link SubrentBillingSchema} — non-strict arms, so extra keys strip. */
export const SubrentBillingInput: z.ZodType<SubrentBilling> = z.discriminatedUnion("basis", [
  z.object(subrentFixedShape),
  z.object(subrentActivationShape),
]);

/**
 * One landed cost on a BUY item: freight, duty or a fee the operator attributes
 * to the units still to arrive (api-cloudrun#1227). It is cost basis, so it
 * reaches the ledger only through the receipts that price it.
 *
 * ⚠️ **It lives on the PURCHASE ITEM, not on the bill.** 276 of 299 historic
 * bills are linked card-purchase bills with no direct items, and the receipt
 * transaction reads the purchase, never its bills. The Xero side is unchanged:
 * the freight still posts through a bill's direct item to its own account.
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
 * The keys every purchase item carries. The posting pair is `propagate: true`
 * so a bill or credit item follows its purchase item's posting (D5); `name` is
 * the product's name when ordered (or a direct item's description), a
 * point-in-time snapshot like `Movement.supplier`.
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

/** A BUY item — ownership of `quantity` units of one product. */
export interface BuyItem extends PurchaseItemBase {
  type: "buy";
  uid_product: string;
  quantity: number;
  /** What the whole item costs, integer cents. */
  amount_cents: number;
  /** An inventory asset account: 1400 for a `sale` product, 1999 for a `rental`. */
  coa_posting: COAAssetType;
  /**
   * When the supplier says this item will arrive, or `null` when nobody said.
   * A calendar date. Inbound supply (`supplyFromPurchase`) reads it.
   */
  expected_date: string | null;
  /** Units received — Σ of the receipts naming this purchase for this item, net of reversals. */
  quantity_received: number;
  /** Units billed — Σ of bill items minus Σ of credit items projecting this item. */
  quantity_billed: number;
  /** Units that will never be received — set by a short close or a cancel. */
  quantity_canceled: number;
  /** Freight, duty and fees spread onto the units still to arrive ({@link PurchaseLandedCost}). */
  landed_costs: PurchaseLandedCost[];
}

/** A SUBRENT item — `quantity` units borrowed for a hire window and given back. */
export interface SubrentItem extends PurchaseItemBase {
  type: "subrent";
  uid_product: string;
  quantity: number;
  /** A Direct Costs account; 5100 by default. */
  coa_posting: COACostType;
  billing: SubrentBilling;
  dates: PurchaseItemDates;
  quantity_received: number;
  /**
   * On a `fixed` basis, units billed; on an `activation` basis, billed PERIODS
   * (`remainingUsageToBill`, serialized-subrent § 7b), unbounded by `quantity`.
   */
  quantity_billed: number;
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
}

/**
 * A USAGE item — a carrier line on a device CFS OWNS (Verizon): CFS pays a
 * party that has no custody of anything. No quantity, no amount and no rate:
 * it names its cost entry (`uid_cogs`, `Product.cogs[].uid`), every reader
 * takes the rate from that entry, and the billable quantity is derived from the
 * units' activation spans (`remainingUsageToBill`, serialized-subrent § 7b).
 * A supplier's own device billed only while active is an activation-billed
 * {@link SubrentItem}, never a usage item beside a custody item (D9).
 */
export interface UsageItem extends PurchaseItemBase {
  type: "usage";
  uid_product: string;
  /** A Direct Costs account — the cost entry's `coa_cost` by default. */
  coa_posting: COACostType;
  uid_cogs: string;
  /** Billed periods to date. */
  quantity_billed: number;
}

/**
 * A DIRECT item — something ordered that is not a product: freight, a fee, a
 * service. Posts to any account and never touches basis (a landed cost on a buy
 * item is how freight reaches basis). `name` equals `description`, so every arm
 * answers "what is this row" from one key.
 *
 * A direct item bills ONCE, so `quantity_billed` is 0 or 1.
 *
 * Attribution, as on a bill's direct item (api-cloudrun#1360, #1364):
 * `uid_product` is the RENTAL product the spend is for, `uid_out_of_service` the
 * record a loss or damage charge is for. Both permanently optional — freight
 * attributes nothing.
 */
export interface DirectItem extends PurchaseItemBase {
  type: "direct";
  description: string;
  amount_cents: number;
  quantity_billed: number;
  uid_product?: string;
  uid_out_of_service?: string;
}

/** Union of every purchase item arm, discriminated on `type`. */
export type PurchaseItem = BuyItem | SubrentItem | UsageItem | DirectItem;

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

function bucketIssues(
  item: { quantity: number; quantity_received: number; quantity_canceled: number; quantity_billed?: number },
  ctx: z.RefinementCtx,
): void {
  // Two invariants, not one Σ: receiving and billing are independent axes, so
  // `received + billed` means nothing. Each axis is bounded by what is still
  // coming — the out-of-service `Σ breakdown ≤ quantity`, once per axis.
  if (item.quantity_received + item.quantity_canceled > item.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_received"],
      message: `received ${item.quantity_received} + canceled ${item.quantity_canceled} exceeds the ${item.quantity} ordered`,
    });
  }
  if (item.quantity_billed !== undefined && item.quantity_billed + item.quantity_canceled > item.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_billed"],
      message: `billed ${item.quantity_billed} + canceled ${item.quantity_canceled} exceeds the ${item.quantity} ordered; ` +
        "a short close that leaves more billed than received credits the excess",
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
  coa_posting: COAAssetEnum.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  expected_date: chicagoStartOfDay().nullable().meta({ column: true, label: "Expected" }),
  quantity_received: receivedKey,
  quantity_billed: billedKey,
  quantity_canceled: canceledKey,
  landed_costs: z.array(PurchaseLandedCostSchema).meta({ label: "Landed Cost" }),
}).superRefine((item, ctx) => {
  bucketIssues(item, ctx);
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
  coa_posting: COACostEnum.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  billing: SubrentBillingSchema.meta({ label: "Billing" }),
  dates: PurchaseItemDatesSchema,
  quantity_received: receivedKey,
  quantity_billed: billedKey,
  quantity_canceled: canceledKey,
  quantity_returned: z.int().min(0).meta({ column: true, label: "Returned" }),
  uid_orders: z.array(FirestoreId),
}).superRefine((item, ctx) => {
  // An activation-billed item bills PERIODS, so only a fixed one is bounded by
  // the units ordered on the billing axis.
  bucketIssues(
    item.billing.basis === "fixed" ? item : { ...item, quantity_billed: undefined },
    ctx,
  );
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

const UsageItemInner = z.strictObject({
  type: z.literal("usage").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  uid_product: productKey,
  coa_posting: COACostEnum.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  uid_cogs: z.uuid(),
  quantity_billed: billedKey,
});

const DirectItemInner = z.strictObject({
  type: z.literal("direct").meta({ column: true, label: "Type", propagate: true }),
  ...itemHead,
  description: z.string().min(1).max(4000).meta({ column: true, label: "Description", propagate: true }),
  amount_cents: amountKey,
  coa_posting: COACode.meta({ propagate: true }),
  uid_tracking_category: trackingKey,
  quantity_billed: z.int().min(0).max(1).meta({ column: true, label: "Billed" }),
  // Permanent `.optional()`: freight and fees attribute nothing (api-cloudrun#1360).
  uid_product: FirestoreId.optional().meta({ propagate: true }),
  // A `mark_lost` record's id is a MovementId, so the union, not FirestoreId.
  uid_out_of_service: OutOfServiceId.optional().meta({ propagate: true }),
});

/** Zod schema for BuyItem. */
export const BuyItemSchema: z.ZodType<BuyItem> = BuyItemInner;
/** Zod schema for SubrentItem. */
export const SubrentItemSchema: z.ZodType<SubrentItem> = SubrentItemInner;
/** Zod schema for UsageItem. */
export const UsageItemSchema: z.ZodType<UsageItem> = UsageItemInner;
/** Zod schema for DirectItem. */
export const DirectItemSchema: z.ZodType<DirectItem> = DirectItemInner;

/** Zod schema for any purchase item — discriminated on `type`. */
export const PurchaseItemSchema: z.ZodType<PurchaseItem> = z.discriminatedUnion("type", [
  BuyItemInner,
  SubrentItemInner,
  UsageItemInner,
  DirectItemInner,
]);

// ── Per-arm rules ────────────────────────────────────────────────
//
// Each is an exhaustive switch with a `never` default, so a fifth item type is a
// compile error here rather than a silent fall-through (D7). They live in the
// schema module because the document refine calls them and `utils/` imports
// `schemas/` one way only; `@cfs/core/utils/purchases` re-exports them.

function unreachableItem(item: never): never {
  throw new Error(`unknown purchase item type: ${JSON.stringify(item)}`);
}

/**
 * Has this item nothing left to happen?
 *
 * - **buy** — every unit received or canceled, and billed for exactly what was
 *   not canceled.
 * - **subrent** — the same, plus every unit received has gone back: a hire with
 *   units still in CFS's custody is not finished. An ACTIVATION-billed subrent
 *   has no billing axis to close (it bills periods as they accrue), so custody
 *   alone resolves it.
 * - **usage** — never: a carrier line accrues for as long as it exists.
 * - **direct** — billed.
 *
 * Payment is the bill's business and holds nothing open.
 */
export function purchaseItemResolved(item: PurchaseItem): boolean {
  switch (item.type) {
    case "buy":
      return item.quantity_received + item.quantity_canceled === item.quantity &&
        item.quantity_billed + item.quantity_canceled === item.quantity;
    case "subrent":
      return item.quantity_received + item.quantity_canceled === item.quantity &&
        item.quantity_returned === item.quantity_received &&
        (item.billing.basis === "activation" || item.quantity_billed + item.quantity_canceled === item.quantity);
    case "usage":
      return false;
    case "direct":
      return item.quantity_billed === 1;
    default:
      return unreachableItem(item);
  }
}

/**
 * Was this item canceled in full — nothing will come and nothing is billed?
 * A usage or direct item has no cancel bucket, so it is never canceled; a
 * purchase holding one is canceled only once that item has gone (an update).
 */
export function purchaseItemCanceled(item: PurchaseItem): boolean {
  switch (item.type) {
    case "buy":
    case "subrent":
      return item.quantity_canceled === item.quantity && item.quantity_billed === 0;
    case "usage":
    case "direct":
      return false;
    default:
      return unreachableItem(item);
  }
}

/**
 * The amount an item COMMITS up front — the term of the purchase's
 * `total_cents` (owner, 2026-10-30). An activation-billed subrent and a usage
 * item commit nothing: their cost is decided as they accrue.
 */
export function purchaseItemCommittedCents(item: PurchaseItem): number {
  switch (item.type) {
    case "buy":
    case "direct":
      return item.amount_cents;
    case "subrent":
      return item.billing.basis === "fixed" ? item.billing.amount_cents : 0;
    case "usage":
      return 0;
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

/** The product an item names, or `undefined` — a direct item's `uid_product` is attribution, not an order. */
export function purchaseItemProduct(item: PurchaseItem): string | undefined {
  switch (item.type) {
    case "buy":
    case "subrent":
    case "usage":
      return item.uid_product;
    case "direct":
      return undefined;
    default:
      return unreachableItem(item);
  }
}

/**
 * Derive `query_by_products` — the distinct products the items ORDER, in first
 * appearance order. A direct item's attribution is not an order and is left
 * out. The one author of the mirror, called by every writer.
 */
export function deriveQueryByProducts(items: readonly PurchaseItem[]): string[] {
  return [...new Set(items.map(purchaseItemProduct).filter((u): u is string => u !== undefined))];
}

/** Derive `query_by_orders` — the distinct union of the subrent items' `uid_orders`, in first-seen order. */
export function deriveQueryByOrders(items: readonly PurchaseItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.type === "subrent" ? i.uid_orders : [])))];
}

/** Derive `query_by_item_types` — the distinct item types, in first-seen order. */
export function deriveQueryByItemTypes(items: readonly Pick<PurchaseItem, "type">[]): PurchaseItemTypeType[] {
  return [...new Set(items.map((i) => i.type))];
}

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
 * The keys every item input may carry. `uid` names a stored item to keep;
 * absent (or a uid the purchase does not hold) is a NEW item, minted by the
 * writer, so an update matches rows by identity rather than by product.
 *
 * `coa_posting` and `uid_tracking_category` follow the line-tracking-uid rule
 * (`api-cloudrun/src/lib/lineDenorms.ts`): absent KEEPS what is stored, or takes
 * the default on a new item; a value SETS it; and `uid_tracking_category: null`
 * CLEARS it. The defaults are the writer's (D4): a buy's is
 * `xeroPostingFor("purchase", …)`'s asset account, a subrent's 5100, a usage
 * item's its cost entry's `coa_cost`, and tracking is the product's category.
 */
interface PurchaseItemInputBase {
  uid?: string;
  uid_tracking_category?: string | null;
}

/** A buy item as an operator orders it — the buckets are the server's. */
export interface BuyItemInputType extends PurchaseItemInputBase {
  type: "buy";
  uid_product: string;
  quantity: number;
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

/** A subrent item as an operator orders it. */
export interface SubrentItemInputType extends PurchaseItemInputBase {
  type: "subrent";
  uid_product: string;
  quantity: number;
  coa_posting?: COACostType;
  billing: SubrentBilling;
  dates: PurchaseItemDates;
  /** The orders the item was raised for. Absent is `[]`: the writer states it. */
  uid_orders?: string[];
}

/** A usage item as an operator raises it. */
export interface UsageItemInputType extends PurchaseItemInputBase {
  type: "usage";
  uid_product: string;
  uid_cogs: string;
  coa_posting?: COACostType;
}

/** A direct item as an operator orders it. Its account is the operator's — there is no default. */
export interface DirectItemInputType extends PurchaseItemInputBase {
  type: "direct";
  description: string;
  amount_cents: number;
  coa_posting: COACodeType;
  uid_product?: string;
  uid_out_of_service?: string;
}

/** Union of every item input arm. */
export type PurchaseItemInputType = BuyItemInputType | SubrentItemInputType | UsageItemInputType | DirectItemInputType;

const inputHead = {
  uid: ItemUid.optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
};
const inputDates = z.object({ start: chicagoInstant(), end: chicagoInstant().nullable() });

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
    coa_posting: COACostEnum.optional(),
    billing: SubrentBillingInput,
    dates: inputDates,
    uid_orders: z.array(FirestoreId).optional(),
  }).superRefine((item, ctx) => {
    if (item.dates.end !== null && Date.parse(item.dates.end) < Date.parse(item.dates.start)) {
      ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a hire ends at or after it starts" });
    }
  }),
  z.object({
    type: z.literal("usage"),
    ...inputHead,
    uid_product: FirestoreId,
    uid_cogs: z.uuid(),
    coa_posting: COACostEnum.optional(),
  }),
  z.object({
    type: z.literal("direct"),
    ...inputHead,
    description: z.string().min(1).max(4000),
    amount_cents: z.int().min(0),
    coa_posting: COACode,
    uid_product: FirestoreId.optional(),
    uid_out_of_service: OutOfServiceId.optional(),
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
 * `billing.amount_cents` and `dates.end` move after receipt — a paid hire
 * extension — with `quantity` still floored at what is received.
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
 * `quantity − quantity_received`. `uid_items` absent closes every such item; a
 * cancel is a close of a purchase with nothing received. When the close leaves
 * an item billed beyond what was received, the writer raises a
 * `purchase-credits` document for the excess.
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
