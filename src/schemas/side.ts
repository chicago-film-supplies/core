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

/** The two sides. The spelling `SETTLEMENT_TARGET_SIDE` (`schemas/common.ts`) already uses. */
export const SIDES: readonly ["receivable", "payable"] = ["receivable", "payable"];
/** One {@link SIDES} member. */
export type Side = typeof SIDES[number];

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

/** The billing and credit documents, the two roles that post lines to Xero. */
export type XeroDocumentRole = "billing" | "credit";

/** One side's entries. Total over {@link SharedLineType}, so a new type is a compile error until both sides state it. */
export interface SideContract {
  /** The operator-facing name of each shared line type on this side. */
  line_labels: Readonly<Record<SharedLineType, string>>;
  /** What each shared line type may post to. */
  posting_class: Readonly<Record<SharedLineType, PostingClass>>;
  /** Whether each shared line type moves custody. */
  custody: Readonly<Record<SharedLineType, LineCustody>>;
  /** How the side's lines are taxed. */
  tax: SideTax;
  /** How each posting role's lines state their money. Xero takes no discount on a credit note, so the role decides too. */
  xero_line_money: Readonly<Record<XeroDocumentRole, XeroLineMoney>>;
  /**
   * Which custody ladder the side's bookings stand on (C11): the outbound ladder
   * (`bookings`, `CUSTODY_RULES`) or the inbound one (`bookings-inbound`,
   * `INBOUND_CUSTODY_RULES`). The api's inbound lever reads it to choose its rule
   * table; a movement learns its ladder from its own contract (`booking_ladder`).
   */
  custody_ladder: BookingLadderType;
}

/**
 * Every way the two sides differ, one total table — the pattern of
 * `ITEM_CONTRACTS` and `SETTLEMENT_CONTRACTS`. A new key is a compile error
 * until both sides state it.
 */
export const SIDE_CONTRACTS: Readonly<Record<Side, SideContract>> = {
  receivable: {
    line_labels: { sale: "Sale", rental: "Rental", service: "Service", replacement: "Replacement" },
    posting_class: { sale: "revenue", rental: "revenue", service: "revenue", replacement: "revenue" },
    custody: { sale: "custody", rental: "custody", service: "custody", replacement: "none" },
    tax: "resolved",
    xero_line_money: { billing: "unit_amount", credit: "exact_split" },
    custody_ladder: "outbound",
  },
  payable: {
    line_labels: { sale: "Buy", rental: "Subrent", service: "Charge", replacement: "Replacement" },
    posting_class: { sale: "asset_or_expensed", rental: "cost", service: "any", replacement: "any" },
    custody: { sale: "custody", rental: "custody", service: "none", replacement: "none" },
    tax: "exempt",
    xero_line_money: { billing: "exact_split", credit: "exact_split" },
    custody_ladder: "inbound",
  },
};
