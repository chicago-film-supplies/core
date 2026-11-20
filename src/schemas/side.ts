/**
 * The two SIDES of the business, and the one table that states every way they
 * differ — api-cloudrun's `one-document-model` plan.
 *
 * A document has a ROLE (initiator, custody, billing, credit) and a SIDE:
 *
 * | | receivable | payable |
 * |---|---|---|
 * | initiator | `orders` | `purchases` |
 * | custody | `fulfillments` | `purchase-receipts` |
 * | billing | `invoices` | `purchase-bills` |
 * | credit | `credit-notes` | `purchase-credits` |
 *
 * **The side is derived, never stored**: the collection is the discriminator,
 * as `SETTLEMENT_TARGET_SIDE` (`schemas/common.ts`) already derives a settlement row's side.
 * Engines read {@link SIDE_CONTRACTS}; they do not branch on the collection.
 *
 * 🔴 **Every entry is a LITERAL tag**, never a function. A schema module cannot
 * import `utils/` (`_breakdown.ts`), and JSR's declaration emitter drops a
 * non-literal member. A utils-side `switch` maps each tag to its behaviour.
 *
 * **Line types are SHARED, labels are per side** (owner, 2026-11-07): a payable
 * `sale` is a Buy, `rental` a Subrent, `service` a Charge. Each was already the
 * twin of a receivable type. ⚠️ On the payable side a line's type is NOT its
 * product's type — a fleet buy is a `sale` line naming a RENTAL product — so no
 * payable reader may derive the product type, stock method or asset account
 * from the line type.
 *
 * The table grows one entry per phase of that plan; only what a shipped engine
 * reads is stated here.
 *
 * @module
 */
import type { BookingLadderType } from "./transaction.ts";
import type { SettlementReasonType, SettlementTypeType } from "./common.ts";

/** The two sides. */
export const SIDES: readonly ["receivable", "payable"] = ["receivable", "payable"];
/** One {@link SIDES} member. */
export type Side = typeof SIDES[number];

/** The four document roles, one collection per side each (the table above). */
export type DocumentRole = "initiator" | "custody" | "billing" | "credit";

/**
 * Each side's collection per role — the table in this module's docblock, as
 * data. A reader that holds a role and a side names its collection from here.
 */
export interface SideCollections {
  receivable: { initiator: "orders"; custody: "fulfillments"; billing: "invoices"; credit: "credit-notes" };
  payable: { initiator: "purchases"; custody: "purchase-receipts"; billing: "purchase-bills"; credit: "purchase-credits" };
}

/** The `billing` collection on side `S`. */
export type BillingCollection<S extends Side = Side> = SideCollections[S]["billing"];
/** The `credit` collection on side `S`. */
export type CreditCollection<S extends Side = Side> = SideCollections[S]["credit"];
/** Any collection {@link SIDE_OF_COLLECTION} names. */
export type SidedCollection = SideCollections[Side][DocumentRole];

/** {@link SideCollections} as a value. */
export const SIDE_COLLECTIONS: SideCollections = {
  receivable: { initiator: "orders", custody: "fulfillments", billing: "invoices", credit: "credit-notes" },
  payable: { initiator: "purchases", custody: "purchase-receipts", billing: "purchase-bills", credit: "purchase-credits" },
};

/**
 * **Which side a document is on, read off its collection** — the one place the
 * side is derived (one-document-model ruling 131). A settlement row names its
 * targets as `{ collection, uid }` refs, and the schema refine, a collection
 * scan and the fold all hold only the row, so they read the side here.
 *
 * A literal table rather than an inversion of {@link SIDE_COLLECTIONS}: JSR's
 * declaration emitter drops a computed member, and a side test pins that the
 * two agree.
 */
export const SIDE_OF_COLLECTION: Readonly<Record<SidedCollection, Side>> = {
  orders: "receivable",
  fulfillments: "receivable",
  invoices: "receivable",
  "credit-notes": "receivable",
  purchases: "payable",
  "purchase-receipts": "payable",
  "purchase-bills": "payable",
  "purchase-credits": "payable",
};

/**
 * One side's settlement reasons: for each type, the reasons legal on it and
 * each one's label on this side (ruling 130, the `line_labels` pattern). A
 * reason is legal on a type EXACTLY when this side labels it, so one entry
 * answers both questions.
 *
 * ⚠️ **Not total over reasons**, unlike `line_labels`: `bad_debt` has no payable
 * meaning and `supplier_adjustment` no receivable one. The compiler forces a
 * decision per TYPE; `tests/side.test.ts` asserts every reason is legal on at
 * least one side.
 */
export type SettlementReasons = Readonly<
  Record<SettlementTypeType, Readonly<Partial<Record<SettlementReasonType, string>>>>
>;

/**
 * The line types BOTH sides carry (owner, 2026-11-07). The receivable side has
 * more (`surcharge`, `transaction_fee`), which a payable document does not take.
 *
 * Explicit tuple type rather than `as const` alone: core#43 is JSR's npm `.d.ts`
 * emit truncating an inferred tuple.
 */
export const SHARED_LINE_TYPES: readonly ["sale", "rental", "service", "replacement"] = [
  "sale",
  "rental",
  "service",
  "replacement",
];
/** One {@link SHARED_LINE_TYPES} member. */
export type SharedLineType = typeof SHARED_LINE_TYPES[number];

/**
 * Which accounts a line of one type may post to (its `ledger_account`):
 *
 * - `revenue` — `COA_REVENUE_CODES` (the receivable side, today read from `coa_revenue`);
 * - `asset_or_expensed` — `COA_ASSET_CODES` plus the temporary
 *   `COA_EXPENSED_ASSET_CODES` (a payable `sale`);
 * - `cost` — `COA_COST_CODES` (a payable `rental`);
 * - `any` — any `COACode` (freight, a fee, a supplier's lost-unit charge).
 */
export type PostingClass = "revenue" | "asset_or_expensed" | "cost" | "any";

/**
 * Whether a line of one type moves custody on its side. On the payable side a
 * `sale` (Buy) and a `rental` (Subrent) bring units in; a `service` (freight)
 * and a `replacement` (a supplier billing CFS for its lost unit) do not — a
 * freight line must never land on a receipt.
 */
export type LineCustody = "custody" | "none";

/**
 * How a side's lines are taxed:
 *
 * - `resolved` — the jurisdiction rule decides, per line and destination
 *   (`resolveLineTax`); an exempt customer is exempt, and a `replacement` line
 *   is taxed at the origin regardless (the receivable side).
 * - `exempt` — every line is exempt, `replacement` included: CFS buys for
 *   resale (owner, 2026-10-05). The line still resolves its class, so
 *   `taxes_base` records what it is exempt FROM (the payable side).
 */
export type SideTax = "resolved" | "exempt";

/**
 * How a Xero line states its money. `exact_split` is at most two lines that are
 * exact in cents; `unit_amount` is one line, `UnitAmount` = amount ÷ quantity,
 * with a discount rate absorbing the remainder where the line has one
 * (api-cloudrun#1211 is where it has none).
 */
export type XeroLineMoney = "exact_split" | "unit_amount";

/** The roles whose lines state an account: the initiator, its billing documents, and its credits. */
export type PostingRole = "initiator" | "billing" | "credit";

/**
 * How a line's money is stated (one-document-model ruling 40, 6e-0b4 K7): from
 * its `rates` (`rate`), or as a gross total over its quantity in
 * `price.stated_cents` (`stated`). `lineKindOf` (`schemas/_line-money.ts`) is the
 * one predicate.
 *
 * Explicit tuple type rather than `as const` alone: core#43 is JSR's npm `.d.ts`
 * emit truncating an inferred tuple.
 */
export const LINE_KINDS: readonly ["rate", "stated"] = ["rate", "stated"];
/** One {@link LINE_KINDS} member. */
export type LineKind = typeof LINE_KINDS[number];

/** One side's entries. Total over {@link SharedLineType}, so a new type is a compile error until both sides state it. */
export interface SideContract {
  /** The operator-facing name of each shared line type on this side. */
  line_labels: Readonly<Record<SharedLineType, string>>;
  /**
   * What each shared line type may post to, per posting role (F14 item 7). The
   * role decides on the receivable side: an initiator or billing line posts to
   * revenue, while a credit line may post away from the revenue it reverses (a
   * bad-debt note to 6900), so it takes any account and records the revenue it
   * reverses as `source_ledger_account`. A supplier credit posts to the account
   * of the line it credits, so the payable credit class is the billing class.
   */
  posting_class: Readonly<Record<PostingRole, Readonly<Record<SharedLineType, PostingClass>>>>;
  /** Whether each shared line type moves custody. */
  custody: Readonly<Record<SharedLineType, LineCustody>>;
  /** How the side's lines are taxed. */
  tax: SideTax;
  /**
   * How a Xero line states its money, by posting role and then line kind (ruling
   * 40). A stated line is `exact_split` on every role: its money is a total, and
   * `exact_split` sends the NET with no discount channel. A rate line is
   * `unit_amount` where Xero takes a `DiscountRate` (a receivable invoice and
   * quote) and `exact_split` elsewhere: Xero takes no discount on a credit note,
   * and a payable document is exact because nothing dedupes or discounts it. The
   * payable `initiator` row is stated and unused, as in `posting_class` (a
   * purchase posts nothing to Xero).
   */
  xero_line_money: Readonly<Record<PostingRole, Readonly<Record<LineKind, XeroLineMoney>>>>;
  /**
   * Which custody ladder the side's bookings stand on (C11): the outbound ladder
   * (`bookings`, `CUSTODY_RULES`) or the inbound one (`bookings-inbound`,
   * `INBOUND_CUSTODY_RULES`). The api's inbound lever reads it to choose its rule
   * table; a movement learns its ladder from its own contract (`booking_ladder`).
   */
  custody_ladder: BookingLadderType;
  /** The operator-facing name of each settlement type on this side. */
  settlement_type_labels: Readonly<Record<SettlementTypeType, string>>;
  /** Which reasons each settlement type takes on this side, and their labels. */
  settlement_reasons: SettlementReasons;
}

/**
 * Every way the two sides differ, one total table — the pattern of
 * `ITEM_CONTRACTS` and `SETTLEMENT_CONTRACTS`. A new key is a compile error
 * until both sides state it.
 */
export const SIDE_CONTRACTS: Readonly<Record<Side, SideContract>> = {
  receivable: {
    line_labels: { sale: "Sale", rental: "Rental", service: "Service", replacement: "Replacement" },
    posting_class: {
      initiator: { sale: "revenue", rental: "revenue", service: "revenue", replacement: "revenue" },
      billing: { sale: "revenue", rental: "revenue", service: "revenue", replacement: "revenue" },
      credit: { sale: "any", rental: "any", service: "any", replacement: "any" },
    },
    custody: { sale: "custody", rental: "custody", service: "custody", replacement: "none" },
    tax: "resolved",
    xero_line_money: {
      initiator: { rate: "unit_amount", stated: "exact_split" },
      billing: { rate: "unit_amount", stated: "exact_split" },
      credit: { rate: "exact_split", stated: "exact_split" },
    },
    custody_ladder: "outbound",
    settlement_type_labels: {
      payment: "Payment",
      payment_reversal: "Payment reversed",
      credit: "Credit",
      credit_reversal: "Credit reversed",
      void: "Voided",
      void_reversal: "Void reversed",
      closure: "Closed",
      closure_reversal: "Closure reversed",
      refund: "Refunded",
      refund_reversal: "Refund reversed",
    },
    // `unspecified` is legal only where receivable history carries it (the
    // 2026 backfill of payments, credits and voids); nothing new writes it.
    settlement_reasons: {
      payment: { paid: "Payment received", correction: "Correction", unspecified: "Unspecified" },
      payment_reversal: { source_retracted: "Source retracted", correction: "Correction", unspecified: "Unspecified" },
      credit: {
        bad_debt: "Bad debt",
        early_return: "Early return",
        order_adjustment: "Order adjustment",
        goodwill: "Goodwill",
        correction: "Correction",
        unspecified: "Unspecified",
      },
      credit_reversal: { source_retracted: "Source retracted", correction: "Correction", unspecified: "Unspecified" },
      void: { voided: "Invoice voided", correction: "Correction", unspecified: "Unspecified" },
      void_reversal: { source_retracted: "Source retracted", correction: "Correction", unspecified: "Unspecified" },
      closure: { zero_total: "Zero total", correction: "Correction" },
      closure_reversal: { source_retracted: "Source retracted", correction: "Correction" },
      refund: { refunded: "Refunded to customer", correction: "Correction" },
      refund_reversal: { source_retracted: "Source retracted", correction: "Correction" },
    },
  },
  payable: {
    line_labels: { sale: "Buy", rental: "Subrent", service: "Charge", replacement: "Replacement" },
    posting_class: {
      initiator: { sale: "asset_or_expensed", rental: "cost", service: "any", replacement: "any" },
      billing: { sale: "asset_or_expensed", rental: "cost", service: "any", replacement: "any" },
      credit: { sale: "asset_or_expensed", rental: "cost", service: "any", replacement: "any" },
    },
    custody: { sale: "custody", rental: "custody", service: "none", replacement: "none" },
    tax: "exempt",
    xero_line_money: {
      initiator: { rate: "exact_split", stated: "exact_split" },
      billing: { rate: "exact_split", stated: "exact_split" },
      credit: { rate: "exact_split", stated: "exact_split" },
    },
    custody_ladder: "inbound",
    settlement_type_labels: {
      payment: "Payment",
      payment_reversal: "Payment reversed",
      credit: "Supplier credit",
      credit_reversal: "Supplier credit reversed",
      void: "Voided",
      void_reversal: "Void reversed",
      closure: "Closed",
      closure_reversal: "Closure reversed",
      refund: "Supplier refund",
      refund_reversal: "Supplier refund reversed",
    },
    // No `unspecified`: every payable row has a known reason (the `refund`
    // ruling, api-cloudrun#1210).
    settlement_reasons: {
      payment: { paid: "Payment sent", correction: "Correction" },
      payment_reversal: { source_retracted: "Source retracted", correction: "Correction" },
      credit: { supplier_adjustment: "Supplier adjustment", correction: "Correction" },
      credit_reversal: { source_retracted: "Source retracted", correction: "Correction" },
      void: { voided: "Bill voided", correction: "Correction" },
      void_reversal: { source_retracted: "Source retracted", correction: "Correction" },
      closure: { zero_total: "Zero total", correction: "Correction" },
      closure_reversal: { source_retracted: "Source retracted", correction: "Correction" },
      refund: { refunded: "Refunded by supplier", correction: "Correction" },
      refund_reversal: { source_retracted: "Source retracted", correction: "Correction" },
    },
  },
};
