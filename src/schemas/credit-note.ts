/**
 * CreditNote document schema — Firestore collection: `credit-notes`
 *
 * The **value instrument**: a credit issued to an organization, with lines, tax,
 * a number and a remaining balance. Where it gets *applied* is not stored here —
 * an allocation is a `settlements` document, and `where("uid_credit_note","==",uid)`
 * is an ordinary query. Three of the four platforms surveyed (TigerBeetle, Odoo,
 * Xero) make the allocation its own record; the one that doesn't, ERPNext, is the
 * one whose seam is its documented failure source.
 *
 * **A first-class collection, not an invoice variant.** `Invoice` carries a
 * `query_by_orders` min-1 + destinations refine a credit note has no analogue
 * for, the Xero push targets a different endpoint, and `Discount.amount` is
 * `.min(0)` with sign-naive item math — so Odoo's positive-amount-with-a-type
 * trick would mean threading a direction sign through `calculateItemSubtotal`
 * and the totals sum. Against ~4 notes a year, a union would make all 962
 * invoices carry credit-note columns.
 *
 * **`credit-notes`, not `credits`.** Both fit the kebab-case-plural convention,
 * but `credit` is the most overloaded word in this space — it is the
 * double-entry *side*, it is TigerBeetle's `credits_pending`/`credits_posted`,
 * and it is the accounting sense throughout `chart-of-accounts`. A collection
 * called `credits` would collide head-on with the ledger vocabulary the moment
 * CFS owns its ledger, which is the stated destination.
 *
 * **Organization-scoped, not contact-scoped.** Xero's model is contact-scoped,
 * but CFS has no contact-scoped billing document and every invoice carries the
 * denormalized `organization` block. A contact-scoped document could not reuse
 * it and would lose the `organization.name` Typesense sort.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  DocumentOrganizationSnapshot,
  type DocumentOrganizationSnapshotType,
  checkItemPriceFormula,
  checkLinePrice,
  COARevenueEnum,
  type COARevenueType,
  DOC_LINE_ITEM_TYPES,
  type DocLineItemTypeType,
  DocSource,
  type DocSourceType,
  ExchangedForList,
  type ExchangedForEntryType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  SETTLEMENT_CONTRACTS,
  type SettlementReasonType,
  type SubstitutedForEntryType,
  SubstitutedForList,
  TimestampFields,
} from "./common.ts";
import {
  type PriceFormulaRef,
  PriceFormulaRefSchema,
  RateSnapshotSchema,
  type RateSnapshotType,
  TierCountSchema,
  type TierCountType,
} from "./price-formula.ts";
import { checkItemsLineMoney } from "./_line-money.ts";
import {
  Discount,
  type DiscountType,
  PriceModifier,
  type PriceModifierType,
} from "./order.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import { BillingDividerArm, DestinationSectionDividerArm, GroupDividerArm, OrderDividerArm } from "./_dividers.ts";
import {
  InvoiceDocDestination,
  type InvoiceDocDestinationItemType,
  type InvoiceDocDestinationType,
  type InvoiceDocOrderItemType,
} from "./invoice.ts";
import { checkDestinationJoin, leadingDividerViolations, type OrderDocGroupItemType } from "./order.ts";

// ── Posting ──────────────────────────────────────────────────────

/** Xero's Bad Debt account. The one posting account a `reason` determines. */
export const COA_BAD_DEBT = 6900;

/**
 * Where a credit line posts, from the two facts that decide it.
 *
 * **Bad debt is not a revenue reversal, and that is the whole rule.** The money
 * *was* owed — the sale stands — and the write-off moves it to Bad Debt so it
 * can be written off: `DR 6900 / CR A/R`. Everything else is a return or an
 * allowance, where the customer never owed the money and the revenue itself is
 * reversed: `DR <the line's own revenue account> / CR A/R`. `early_return` is
 * the clearest case of the second kind.
 *
 * **New notes derive this; history does not obey it.** Of the 12 notes in the
 * live tenant, 8 agree and 4 are miscodings the owner has ruled historic rather
 * than sanctioned — CN-1007 books a bad-debt write-off to 4210 (revenue), and
 * CN-1010/1011/1012 book a customer credit to 6000 General Operating Expenses
 * on a free-text line whose `TaxType` is `INPUT`, a *purchase* tax type on a
 * receivable. CFS stores the corrected account and leaves Xero alone; the
 * divergence is recorded as a comment on the note's thread, and
 * `audit-credit-note-posting.ts` reports it. Xero still holds the original, so
 * nothing is lost by correcting.
 *
 * That is also why `coa_posting` is STORED rather than derived on read: the
 * stored value is what CFS asserts, this function is what CFS intends, and an
 * audit comparing them against Xero is a real guard precisely because the three
 * come from different places. Deriving on read would make the check a
 * restatement of its own oracle.
 *
 * `correction` is deliberately absent: it is bidirectional — an operator may be
 * adding a credit they missed or removing one that never happened — so its
 * posting depends on what is being corrected. Callers must supply it.
 *
 * @returns the account code, or `null` when the rule has no opinion.
 */
export function deriveCreditPostingAccount(
  reason: SettlementReasonType,
  coaRevenue: number | null,
): number | null {
  if (reason === "bad_debt") return COA_BAD_DEBT;
  if (reason === "correction" || reason === "unspecified") return null;
  return coaRevenue;
}

// ── Status ───────────────────────────────────────────────────────

// The status vocabulary lives in `schemas/common.ts` beside `InvoiceStatusEnum`, so
// `order.ts` can mirror it (`order.credit_notes[]`) without importing this file,
// which imports `order.ts` (6e-0a, api-cloudrun#1455).
export { CreditNoteStatusEnum, type CreditNoteStatusType } from "./common.ts";
import { CreditNoteStatusEnum, type CreditNoteStatusType, deriveCreditStatus } from "./common.ts";

/**
 * What one credit-note status admits (api-cloudrun#1169). Until this table the
 * note's transitions were implicit in its writers, and the manager offered Void
 * on any non-void note while the API 409'd it whenever an allocation was live.
 *
 * Read by `creditNoteActionsFor` (`@cfs/core/utils/invoice-actions`). Each
 * column is a STATUS gate only: the action also needs its own runtime condition
 * (no live allocation to void, remaining credit to allocate), which the ruleset
 * checks and this table cannot state.
 */
export interface CreditNoteStatusContract {
  /**
   * May an operator void it? Void is the only operator move a note has — it is
   * created `issued`, and `applied` is derived from its balance. `void` is
   * terminal.
   */
  voidable: boolean;
  /**
   * May its credit be allocated to an invoice? `applied` is excluded because it
   * IS `remaining_credit_cents === 0` (the refine below), so there is nothing to
   * allocate; `draft` because it has not reached Xero. Also the status gate for
   * recording a cash refund (`record_refund`), which spends credit exactly as an
   * allocation does (api-cloudrun#1207).
   */
  accepts_allocation: boolean;
}

/**
 * The per-status credit-note contract. `Readonly<Record<CreditNoteStatusType, …>>`
 * makes a fifth status a type error here, at the declaration — the same
 * totality `INVOICE_STATUS_CONTRACTS` relies on.
 */
export const CREDIT_NOTE_STATUS_CONTRACTS: Readonly<
  Record<CreditNoteStatusType, CreditNoteStatusContract>
> = {
  draft: { voidable: true, accepts_allocation: false },
  issued: { voidable: true, accepts_allocation: true },
  applied: { voidable: true, accepts_allocation: false },
  void: { voidable: false, accepts_allocation: false },
};

/**
 * Why this credit was issued — the `credit` arm of {@link SETTLEMENT_CONTRACTS},
 * **derived rather than re-listed**, so the document and the settlements it
 * spawns can never offer different reasons.
 *
 * The reason lives on the *document* and is denormalized onto each settlement:
 * one credit note allocated across three invoices has one reason, and authoring
 * it three times invites three answers.
 */
export const CREDIT_NOTE_REASONS: readonly SettlementReasonType[] =
  SETTLEMENT_CONTRACTS.credit.reasons;

// ── Item price ───────────────────────────────────────────────────

/** Pricing breakdown for a single credit-note line. */
export interface CreditNoteDocItemPrice {
  /** See {@link OrderDocItemPriceType.price_formula}. */
  price_formula: PriceFormulaRef | null;
  /** See {@link OrderDocItemPriceType.rates} — the snapshot the line owns. */
  rates: RateSnapshotType[];
  /** See {@link OrderDocItemPriceType.counts} — frozen when the line is priced. */
  counts: TierCountType[];
  /** See {@link OrderDocItemPriceType.base_percent} — same biconditional. */
  base_percent?: number | null;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total_cents: number;
}

const CreditNoteDocItemPriceSchema: z.ZodType<CreditNoteDocItemPrice> = z.strictObject({
  price_formula: PriceFormulaRefSchema.nullable(),
  rates: z.array(RateSnapshotSchema).meta({ label: "Rate" }),
  counts: z.array(TierCountSchema),
  base_percent: z.number().nullable().optional(),
  subtotal_cents: z.int().meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().meta({ column: true, label: "Discounted Subtotal" }),
  discount: Discount.nullable().meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax" }),
  total_cents: z.int().meta({ column: true, label: "Total" }),
}).superRefine((price, ctx) => checkLinePrice(price, ctx));

// ── Line items ───────────────────────────────────────────────────

/**
 * A credited line.
 *
 * **`coa_revenue` is required, not optional.** A credit spanning lines with
 * different revenue accounts (#1689 hits 4000 and 4100; #1322 is all 4210)
 * cannot be posted correctly from a document-level amount, and apportioning it
 * afterwards is inferring cause from effect — the thing `schemas/transaction.ts` warns
 * against. This is also the gap Xero *has*: its allocation view carries
 * `LineItems: []`, and Odoo's users pay OCA for a module that adds line-level
 * provenance.
 *
 * **No dividers.** A credit note has no destinations and bills no orders, so the
 * whole `ORDER_ITEM_LEVELS` / `INVOICE_ITEM_LEVELS` hierarchy — and the `path`
 * machinery that goes with it — has nothing to organize here. Lines are flat.
 *
 * ## `coa_revenue` and `coa_posting` are TWO facts, and a line has both
 *
 * They are routinely different, and collapsing them loses real information.
 * Measured on the live tenant: CN-1009 writes off 35 lines whose products are
 * rentals — `product.price.coa_revenue` 4000 Rental Income — and every one of
 * them posts to **6900 Bad Debt**. Store only the posting account and the
 * revenue attribution that tracking-category rollups and the tax tables depend
 * on is gone; store only the revenue account and the write-off is invisible.
 *
 * - **`coa_revenue`** — the revenue account of the *thing being credited*.
 *   Product-sourced, same vocabulary as the invoice line it mirrors. Never the
 *   account the credit posts to, and — since the owner ruling of 2026-08-20 —
 *   never an input to what the line is taxed either.
 * - **`coa_posting`** — where this credit lands in the ledger. Any account in
 *   the `chart-of-accounts` catalog, including the expense range, which is
 *   exactly why it cannot be `COARevenueEnum`: that enum is shared with
 *   `Product.price.coa_revenue`, and widening it would make a catalog product
 *   whose revenue account is Bad Debt Expense representable.
 */
export interface CreditNoteDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: CreditNoteDocItemPrice;
  /**
   * The revenue account of the thing credited. **Nullable**, matching
   * `InvoiceDocLineItemType` — a credit can be raised on a free-text line with no
   * catalog product behind it, and the live tenant already holds one (CN-1012's
   * sole line has no `ItemCode`). A schema stricter than the invoice it credits
   * cannot represent the corpus.
   */
  coa_revenue?: COARevenueType | null;
  /**
   * The account this credit posts to. See {@link deriveCreditPostingAccount} —
   * new notes derive it, history stores what actually happened.
   *
   * ⚠️ **Retiring (ruling 34, Phase 8's rename folded in): `ledger_account` is
   * its new name** and {@link coa_revenue}'s is `source_ledger_account`. Beta H1
   * declares both spellings optional, every writer writes only the new one,
   * every reader reads through {@link creditLinePostingAccount} /
   * {@link creditLineSourceAccount}; the migration renames the stored keys and
   * beta H2 deletes these two.
   */
  coa_posting?: number;
  /** Where this credit posts — {@link coa_posting}'s new name (ruling 34). */
  ledger_account?: COACodeType;
  /**
   * The revenue account of the thing credited — {@link coa_revenue}'s new name
   * (ruling 34). AR only: an AR credit can post away from the revenue it
   * reverses (bad debt to 6900), so it records both accounts.
   */
  source_ledger_account?: COARevenueType | null;
  /**
   * The `tracking-categories` document the credited thing reports under — copied
   * from the invoice line it credits (`InvoiceDocLineItemType.uid_tracking_category`).
   * Replaced the stored name and Xero option id. The credit-note Xero body sends
   * no tracking today; the line carries the uid so it can.
   */
  uid_tracking_category: string | null;
  xero_id: string | null;
  /**
   * The invoice line this credits, when the credit was raised from one.
   * **Retired** (ruling 34): 146 of 147 stored lines hold `null`, and the pointer
   * is {@link uid_billing} + {@link path_billing_item}. Optional in beta H1,
   * deleted in H2.
   */
  uid_invoice_item?: string | null;
  /**
   * The `path` of the invoice line this credits — its row identity on that
   * invoice (api-cloudrun#680 R1).
   *
   * `uid_invoice_item` alone is ambiguous: `item.uid` repeats within one
   * document, and an invoice holding a product in a full-window section and in
   * a date-extension section carries it twice. A credit selects and caps by
   * this path when present.
   *
   * ⚠️ Absent on every note stored before 2026-09-15; readers fall back to
   * `uid_invoice_item`. No writer may set it until prod API and prod manager
   * both run the beta that declares it (the schema is strict).
   */
  path_invoice_item?: string[];
  /**
   * **The billing document this line credits** (ruling 34, one name on both
   * sides): an invoice's uid here, a bill's on a supplier credit. Set together
   * with {@link path_billing_item} by every writer raising the credit from a
   * billing row; absent on a goodwill or bad-debt line (ruling 104). It replaces
   * {@link path_invoice_item}, which could not say WHICH invoice.
   *
   * A pointed line sits under that document's `billing` divider:
   * `path[0] === uid_billing` (ruling 107).
   */
  uid_billing?: string;
  /** The `path` of the billing row credited, on its own document (ruling 34). */
  path_billing_item?: string[];
  /**
   * The row's identity on this note, self-inclusive (ruling 107):
   * `[uid_billing, ...billing row path]` for a pointed line, `[uid]` for a flat
   * historic one. **Optional in beta H1**: the 147 stored lines carry none (prod,
   * 2026-11-17) and none repeats a `uid` within its note, so the migration
   * writes `[uid]` on each flat line and H2 requires it.
   */
  path?: string[];
  /**
   * This line reverses BILLING at {@link path_invoice_item} — it credits units
   * the invoices billed beyond the order, so quantity accounting must stop
   * counting them as billed (api-cloudrun#1028).
   *
   * 🔴 **This marker, and nothing else, is what lets a credit note NET against
   * what the invoices bill.** It is deliberately not inferred from `reason`:
   * `bad_debt` is a write-off and `order_adjustment` covers loss-and-damage, so
   * netting by reason would make the remaining invoice offer to RE-BILL units that
   * were written off rather than returned — CN-1009 alone credits ~35 lines at
   * full quantity. A reason says why money moved; only this says that the
   * BILLING was reversed.
   *
   * ⚠️ **Units only.** A credit of DAYS (a shortened charge window) is not netted
   * by this — see `utils/quantityAccounting.ts`.
   *
   * 🔴 **REQUIRED, deliberately — there is no absent-means-false.** An optional
   * marker would be a declared guard that is opt-in: a writer that says nothing
   * gets the netting behaviour by default, and the one fact a reader most needs
   * (*did anyone actually decide this line reverses billing?*) becomes
   * unaskable. Every line states it.
   *
   * ⚠️ **Requiring it obliges a MIGRATION IN THE SAME SITTING as the deploy**, and
   * that is the whole cost of this choice. The grain is a `z.strictObject` and
   * 146 stored line rows predate the field, so between the two there is no safe
   * order: requiring it first makes every stored note fail a whole-document
   * write, and backfilling first makes the still-deployed API reject the unknown
   * key. This is the api-cloudrun#443 class exactly, so it takes #443's answer —
   * `api-cloudrun/scripts/backfill-credit-note-reverses-billing.ts`, run against a
   * project immediately before that project's API takes the pin, never as a
   * follow-up.
   *
   * ⚠️ **The backfilled value is DERIVED, not a plausible default.** The only
   * writer that ever sets this true is the over-billing offer, which did not
   * exist before this beta — so no stored line can be reversing billing, and
   * `false` is a fact about the corpus. That is what makes the backfill legal
   * under this package's own *"find the value's AUTHOR"* rule, and it is why this
   * field could be required in one step where `path_invoice_item` beside it could
   * not: that one's value is a row identity nothing ever recorded
   * (api-cloudrun#1045).
   */
  reverses_billing: boolean;
  /**
   * The invoice row's `substituted_for` (`InvoiceDocLineItemType.substituted_for`),
   * SLICED to the units this line credits — the order lines the credited units
   * stood in for (ruling 84 of the one-document-model plan, api-cloudrun#1455).
   * A credit row is a billing row of sign −1, so it carries the pointers its
   * source row bills under, and one fold reads both.
   *
   * ⚠️ **Entries stay ORDER-relative**, exactly as on the invoice line: a credit
   * line has no dividers, so they resolve through the order its
   * {@link path_invoice_item} leads with (`path_invoice_item[0]`, an order
   * divider's uid), never through a path of this document.
   *
   * **Optional FOREVER, not mid-expand.** The 146 lines stored before this field
   * name no invoice row ({@link path_invoice_item} is absent, ruling 53), so
   * there is no source row to copy from and no value to backfill. The invoice's
   * spelling — plain `.optional()`, array-member-uncensusable — so a copy and its
   * source agree on what absence means. Untagged: `CreditNoteSchema` is in none of
   * `classifySharedFields`' pairs.
   */
  substituted_for?: SubstitutedForEntryType[];
  /**
   * The invoice row's `exchanged_for` (`InvoiceDocLineItemType.exchanged_for`),
   * copied AS STATED — never sliced: it names the rows an exchange line goes out
   * against, which a credit of some of its units does not change (ruling 84).
   * ORDER-relative and optional forever, for {@link substituted_for}'s reasons.
   *
   * No document refine checks it: the invoice's `checkInvoiceExchangedFor` reads
   * the order block the line sits in, and a credit line sits in none.
   */
  exchanged_for?: ExchangedForEntryType[];
}

const CreditNoteDocLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none", column: true }),
  description: z.string().meta({ pii: "none", column: true, label: "Description" }),
  // **REQUIRED — the inert `.default(0)` came off 2026-09-11 (core#95 batch 7),
  // alongside `LineItemCore.quantity` on the other three grains.** ⚠️ This grain
  // is a SEPARATE declaration that merely shares the leaf name: it spells
  // `z.int()` where the others spell `z.number().int().min(0)`, so it admits a
  // negative quantity they do not. That divergence is left exactly as it was —
  // a bound is a different change from a presence tightening, and folding one
  // into the other is how a batch stops being reviewable. 146 of 146 stored
  // credit-note line rows state the key in both projects.
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  // Optional until H2 (the interface docblock); `seed: false` so a form seed
  // does not state a path its writer has not computed.
  path: z.array(ItemUid).min(1).optional().meta({ seed: false }),
  price: CreditNoteDocItemPriceSchema,
  // Beta H1 (ruling 34): both spellings optional, `seed: false` on the old ones
  // so a form seed states only the new; the migration renames, H2 deletes.
  coa_revenue: COARevenueEnum.nullable().optional().meta({ seed: false }),
  coa_posting: COACode.optional().meta({ seed: false }),
  ledger_account: COACode.optional(),
  source_ledger_account: COARevenueEnum.nullable().optional(),
  uid_tracking_category: FirestoreId.nullable(),
  xero_id: z.uuid().nullable(),
  uid_invoice_item: ItemUid.nullable().optional().meta({ seed: false }),
  // `seed: false`: `[]` fails `.min(1)`, so the form seed must omit the key (core#125).
  path_invoice_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
  // The payable pair's spelling (`purchase-bill.ts`), paired-presence refined below.
  uid_billing: FirestoreId.optional().meta({ seed: false }),
  path_billing_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
  reverses_billing: z.boolean(),
  // See the interface docblock. The invoice line's spelling, field for field:
  // `substituted_for` plain `.optional()`; `exchanged_for` `seed: false`, so a form
  // seed omits the key rather than stating an empty take-back list its source
  // row never stated.
  substituted_for: SubstitutedForList.optional(),
  exchanged_for: ExchangedForList.optional().meta({ seed: false }),
}).superRefine(checkItemPriceFormula).superRefine((line, ctx) => {
  for (const issue of creditLineShapeIssues(line)) ctx.addIssue({ code: "custom", ...issue });
  if (creditLinePostingAccount(line) === undefined) {
    ctx.addIssue({ code: "custom", path: ["ledger_account"], message: "a credit line states the account it posts to" });
  }
});

/** Zod schema for a credit-note line item. */
export const CreditNoteDocLineItem: z.ZodType<CreditNoteDocLineItem> = CreditNoteDocLineItemInner;

// ── The renamed keys: one reader per pair (beta H1, deleted in H2) ─────────

/** Where a credit line posts: `ledger_account`, else the retiring `coa_posting`. */
export function creditLinePostingAccount(
  line: Pick<CreditNoteDocLineItem, "ledger_account" | "coa_posting">,
): number | undefined {
  return line.ledger_account ?? line.coa_posting;
}

/** The revenue account credited: `source_ledger_account`, else the retiring `coa_revenue`. */
export function creditLineSourceAccount(
  line: Pick<CreditNoteDocLineItem, "source_ledger_account" | "coa_revenue">,
): COARevenueType | null {
  return line.source_ledger_account !== undefined ? line.source_ledger_account : line.coa_revenue ?? null;
}

/**
 * The billing row a credit line names: `uid_billing` + `path_billing_item`, else
 * the retiring `path_invoice_item` (whose invoice it cannot name, so `uid` is
 * `undefined`). `null` for an unpointed line.
 */
export function creditLineBillingPointer(
  line: Pick<CreditNoteDocLineItem, "uid_billing" | "path_billing_item" | "path_invoice_item">,
): { uid?: string; path: string[] } | null {
  if (line.path_billing_item !== undefined) return { uid: line.uid_billing, path: line.path_billing_item };
  if (line.path_invoice_item !== undefined) return { path: line.path_invoice_item };
  return null;
}

/** A credit note's Xero `CreditNoteID`: `xero_id`, else the retiring `xero_credit_note_id`. */
export function creditNoteXeroId(note: Pick<CreditNote, "xero_id" | "xero_credit_note_id">): string | null {
  return note.xero_id !== undefined ? note.xero_id : note.xero_credit_note_id ?? null;
}

/**
 * **The credit line's shape rules, both sides** (ruling 34; Q4 ruling 106, Q6
 * ruling 108), keyed on the POINTER rather than the document type:
 *
 * - the pointer pair is set together (the payable rule, `purchase-bill.ts`);
 * - a time-basis line naming no billing row states the time it moves of its own
 *   (`counts` non-empty) — an unpointed credit, like an invoice line, prices
 *   itself;
 * - a line naming a billing row states only the time it takes BACK: empty
 *   `counts` = whole units of the named row, non-empty = time per unit, which
 *   only a time-basis row has (a flat row's `[flat 1/1]` copied onto a units
 *   credit would read as a time credit).
 *
 * "A credit naming an extension-section row states counts" needs the billing
 * row, so the fold, not this refine, holds it.
 */
export function creditLineShapeIssues(line: {
  uid_billing?: string;
  path_billing_item?: string[];
  path_invoice_item?: string[];
  price: { price_formula: { basis: string } | null; counts: readonly unknown[] };
}): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if ((line.uid_billing === undefined) !== (line.path_billing_item === undefined)) {
    issues.push({ path: ["path_billing_item"], message: "uid_billing and path_billing_item are set together" });
  }
  const pointed = line.path_billing_item !== undefined || line.path_invoice_item !== undefined;
  const time = line.price.price_formula?.basis === "time";
  const counts = line.price.counts.length;
  if (!pointed && time && counts === 0) {
    issues.push({ path: ["price", "counts"], message: "a time line naming no billing row states the counts it moves" });
  }
  if (pointed && !time && counts > 0) {
    issues.push({
      path: ["price", "counts"],
      message: "a credit naming a billing row states only the time it takes back, which a flat row has none of",
    });
  }
  return issues;
}

// ── Rows ─────────────────────────────────────────────────────────

/**
 * A credit's `billing` divider row (ruling 107) — see `BillingDividerArm`
 * (`schemas/_dividers.ts`), declared once for both credit row unions.
 */
export interface CreditDocBillingItemType {
  uid: string;
  type: "billing";
  name: string;
  path: string[];
  description: string;
}

/** Zod schema for a credit's billing divider row. */
export const CreditDocBillingItem: z.ZodType<CreditDocBillingItemType> = BillingDividerArm;

/**
 * Any row of an AR credit note's `items[]` (ruling 34 item 1): a line, or a
 * billing / order / destination / group divider, at
 * `CREDIT_NOTE_ITEM_LEVELS` (`@cfs/core/utils/invoices`). A historic note holds
 * lines only (ruling 53 keeps it flat).
 */
export type CreditNoteDocItemType =
  | CreditNoteDocLineItem
  | CreditDocBillingItemType
  | InvoiceDocOrderItemType
  | InvoiceDocDestinationItemType
  | OrderDocGroupItemType;

/** Zod schema for {@link CreditNoteDocItemType}. */
export const CreditNoteDocItem: z.ZodType<CreditNoteDocItemType> = z.discriminatedUnion("type", [
  CreditNoteDocLineItemInner,
  BillingDividerArm,
  OrderDividerArm,
  DestinationSectionDividerArm,
  GroupDividerArm,
]);

const CREDIT_DIVIDER_TYPES: ReadonlySet<string> = new Set(["billing", "order", "destination", "group"]);

/** Whether a credit-note row is a line (every row but the four dividers). */
export function isCreditNoteLine(row: CreditNoteDocItemType): row is CreditNoteDocLineItem {
  return !CREDIT_DIVIDER_TYPES.has(row.type);
}

/** The lines of a credit note's rows, dividers dropped. */
export function creditNoteLines(rows: readonly CreditNoteDocItemType[]): CreditNoteDocLineItem[] {
  return rows.filter(isCreditNoteLine);
}

// ── Totals ───────────────────────────────────────────────────────

/**
 * Credit-note totals.
 *
 * Integer cents, matching `items[]` and matching the `settlements` journal the
 * allocations are drawn into. **This document used to be dollars end to end**
 * while the journal beside it was already cents — a split that was recorded as
 * an intentional boundary and was in fact just drift, and which meant the 2dp
 * census had never evaluated this corpus at all.
 *
 * **No `transaction_fees`.** A card-processing fee is charged when money is
 * taken, not when it is given back; crediting one is an `order_adjustment` line,
 * not a fee row.
 */
export interface CreditNoteDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  total_cents: number;
}

const CreditNoteDocTotalsSchema: z.ZodType<CreditNoteDocTotals> = z.strictObject({
  subtotal_cents: z.int().meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().meta({ column: true, label: "Discounted Subtotal" }),
  discount_amount_cents: z.int().meta({ column: true, label: "Discount" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax" }),
  total_cents: z.int().meta({ column: true, label: "Total" }),
});

// ── Document ─────────────────────────────────────────────────────

/** A credit note issued to an organization. */
export interface CreditNote {
  uid: string;
  /**
   * Monotonic, **never reused** — not even after a void.
   *
   * Xero frees a number when its holder is VOIDED or DELETED, and the live
   * tenant shows how routine that is: 4 of 12 notes are voided re-issues
   * (CN-1008→CN-1009, CN-1010+CN-1011→CN-1012). So **every match keys on `uid`
   * or `xero_credit_note_id`, never on `number`.**
   *
   * Stored bare. `CN-` is presentation only: no collection in this package
   * stores a prefixed string number, and `"CN-0001"` would break
   * `default_sorting_field: "number"`.
   */
  number: number;
  status: CreditNoteStatusType;
  reason: SettlementReasonType;
  /** The accounting issue date, and one of the two inputs to the allocation-date rule. */
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  /**
   * The only notes field, and customer-facing — it replaced the
   * `external_notes` / `internal_notes` pair, on the same terms as
   * {@link Invoice.notes}. REQUIRED and bare `.nullable()` because
   * `createCreditNote` writes `notes: input.notes ?? null`; `null` means *no
   * notes recorded*.
   */
  notes: string | null;
  organization: DocumentOrganizationSnapshotType;
  /** Lines and, on a note raised from billing rows, their dividers (ruling 107). */
  items: CreditNoteDocItemType[];
  /**
   * The billing documents' pairs the note's destination dividers answer to —
   * COPIES of the credited invoices' pairs, never re-derived (ruling 34 item 3),
   * as a supplier credit carries its purchase's. `[]` on a flat note. Optional in
   * beta H1 (no stored note states it); the migration writes it, H2 requires it.
   */
  destinations?: InvoiceDocDestinationType[];
  totals: CreditNoteDocTotals;
  /**
   * Value not yet consumed, in integer cents. `total_cents` minus every
   * unreversed allocation minus any cash refunded.
   *
   * A stored projection of the settlements that name this note, exactly as the
   * invoice's `amount_credited_cents` is: `creditRemainingFromJournal`
   * (`@cfs/core/utils/invoices`) over every `credit` and `refund` row and their
   * reversals. The writers apply deltas under compare-and-set; the fold is what
   * `audit-credit-note-remaining.ts` checks them against and what a lost-claim
   * repair rebuilds from.
   *
   * ⚠️ **This was NOT rebuildable until api-cloudrun#1207, and the reason is
   * worth keeping.** A cash refund consumes a note without touching any invoice,
   * and a `Settlement` used to require an invoice, so a refund appended no row at
   * all. CN-1013 ($485.06) and CN-1016 ($62.16) sat `applied` with zero rows
   * naming them, and a fold would have handed $547.22 of credit already paid out
   * in cash back (api-cloudrun#469). A `refund` settlement names the note and no
   * invoice, and the backfill gives those two notes their rows — so a fold is
   * sound only once the corpus holds every refund. Never rebuild a note from a
   * journal you have not audited.
   */
  remaining_credit_cents: number;
  sources: DocSourceType[];
  query_by_sources: string[];
  /**
   * Xero's `CreditNoteID` — the header key every billing and credit document
   * spells `xero_id` (ruling 34 item 8). Beta H1: optional beside the retiring
   * {@link xero_credit_note_id}; read through {@link creditNoteXeroId}.
   */
  xero_id?: string | null;
  /** Retiring (ruling 34): renamed `xero_id`, deleted in beta H2. */
  xero_credit_note_id?: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** The row keys {@link deriveCreditNoteSources} reads: a divider's `type`, a line's pointer. */
export interface CreditSourceRow {
  type?: string;
  uid_billing?: string;
  path_billing_item?: string[];
  path_invoice_item?: string[];
}

/** The billing-document facts {@link deriveCreditNoteSources} reads: an invoice and the orders it bills. */
export interface CreditNoteBillingSource {
  uid: string;
  query_by_orders: readonly string[];
}

/**
 * **The one author of an AR credit note's `sources`** (one-document-model
 * ruling 32), the twin of `derivePurchaseCreditSources`: the orders it credits,
 * then each invoice it credits, in the order given. `query_by_sources` is
 * `<collection>:<uid>` of each, so `orders:<uid>` is what an order-scoped read
 * (`order.credit_notes[]`, the over-billing cap) queries on.
 *
 * Which orders: for each invoice, the order a pointed line's
 * `path_invoice_item[0]` names (an order divider's uid IS its order's uid), kept
 * only when the invoice bills that order — an invoice-authored subtree's first
 * segment names no order. An invoice that holds a line with NO pointer
 * contributes every order it bills, because the line cannot say which (ruling
 * 52: the 13 notes stored before 2026-09-15 point no line, and are backfilled
 * from the invoices their allocations name). Over-naming is the safe direction:
 * a missing `orders:` key hides a credit from its order, an extra one only
 * lists it there.
 *
 * The order (ruling 34 item 8): the orders in order of first appearance, then
 * each invoice in line order. A line's `uid_billing` says which invoice its
 * pointer is on; a retiring `path_invoice_item` cannot, so it is matched against
 * every invoice. (The docblock this replaced claimed every note credits at most
 * one invoice; CN-1015 credits two, harmless only because its lines are
 * unpointed.)
 */
export function deriveCreditNoteSources(
  billing: readonly CreditNoteBillingSource[],
  items: readonly CreditSourceRow[],
): Pick<CreditNote, "sources" | "query_by_sources"> {
  const lines = items.filter((r) => r.type === undefined || !CREDIT_DIVIDER_TYPES.has(r.type));
  const pointers = lines.map(creditLineBillingPointer);
  // Each billing document in line order (the first line naming it), then any
  // the caller named that no line does (a historic note's allocations).
  const lineOrder = pointers.flatMap((p) => p?.uid ?? []);
  const invoiceUids = [...new Set([...lineOrder, ...billing.map((b) => b.uid)])];
  const byUid = new Map(billing.map((b) => [b.uid, b]));
  const anyUnpointed = pointers.some((p) => p === null);
  const orders: string[] = [];
  for (const uid of invoiceUids) {
    const invoice = byUid.get(uid);
    if (invoice === undefined) continue;
    // A pointer names its invoice (`uid_billing`); a retiring `path_invoice_item`
    // cannot, so it is matched against every invoice, as before ruling 34.
    const pointed = pointers.flatMap((p) => p !== null && (p.uid === undefined || p.uid === uid) ? [p.path[0]] : []);
    const named = anyUnpointed
      ? invoice.query_by_orders
      : invoice.query_by_orders.filter((o) => pointed.includes(o));
    for (const o of named) if (!orders.includes(o)) orders.push(o);
  }
  const sources: DocSourceType[] = [
    ...orders.map((uid) => ({ collection: "orders" as const, uid })),
    ...invoiceUids.filter((uid) => byUid.has(uid)).map((uid) => ({ collection: "invoices" as const, uid })),
  ];
  return { sources, query_by_sources: sources.map((s) => `${s.collection}:${s.uid}`) };
}

function checkCreditNote(cn: CreditNote, ctx: z.RefinementCtx): void {
  if (!CREDIT_NOTE_REASONS.includes(cn.reason)) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: `"${cn.reason}" is not a credit reason ` +
        `(expected one of: ${CREDIT_NOTE_REASONS.join(", ")})`,
    });
  }

  // The stored status IS the derivation (`deriveCreditStatus`, one function for
  // both sides, ruling 34 Q1): `applied` exactly when nothing remains of a credit
  // that had value, so a $0 note is `issued` (ruling 103). A voided note is
  // exempt: voiding strands the balance rather than consuming it, which is
  // exactly what the three VOIDED notes in the live tenant look like.
  const derived = deriveCreditStatus(cn, cn.remaining_credit_cents, cn.totals.total_cents);
  if (cn.status !== derived) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: `a credit note with this balance is ${derived}, not ${cn.status}`,
    });
  }

  // A pointed line sits under the billing divider of the document it names
  // (ruling 107). Only checked once the line states its path (H2 requires it).
  cn.items.forEach((row, i) => {
    if (!isCreditNoteLine(row) || row.uid_billing === undefined || row.path === undefined) return;
    if (row.path[0] !== row.uid_billing) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "a line naming a billing row sits under that document's billing divider: path[0] is uid_billing" });
    }
  });
  // The leading-divider rule runs only on a note holding a divider row (ruling
  // 34 item 2): the 13 historic flat notes stay legal.
  const divided = cn.items.some((r) => !isCreditNoteLine(r));
  for (const v of leadingDividerViolations(cn.items, "credit_note", divided)) {
    ctx.addIssue({ code: "custom", path: ["items", 0, "type"], message: `a credit note holding dividers must lead with a billing or ${v.expected} divider, not ${v.found ?? "an untyped row"}` });
  }
  if (cn.destinations !== undefined) checkDestinationJoin({ items: cn.items, destinations: cn.destinations }, ctx);
  if (cn.remaining_credit_cents > cn.totals.total_cents) {
    ctx.addIssue({
      code: "custom",
      path: ["remaining_credit_cents"],
      message: "remaining_credit_cents cannot exceed the credit note's total_cents",
    });
  }
}

/** Zod schema for a CreditNote. */
export const CreditNoteSchema: z.ZodType<CreditNote> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "creditNoteDetail", serverSortVia: "number" }),
  status: CreditNoteStatusEnum.meta({ column: true, label: "Status" }),
  reason: z.enum(
    CREDIT_NOTE_REASONS as unknown as [SettlementReasonType, ...SettlementReasonType[]],
  ).meta({ column: true, label: "Reason" }),
  // `chicagoStartOfDay()`, matching `Invoice.date` — this is an accounting
  // calendar date, not an instant. (A settlement's `date` is the opposite case
  // and uses `chicagoInstant()`; the two semantics are why both factories exist.)
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  // Bare `.nullable()` — the dropped `.default(null)` is core#95 batch 10.
  // 13 of 13 in both projects already carry the key (`createCreditNote`
  // writes `reference: input.reference ?? null`).
  reference: z.string().nullable().meta({ column: true, label: "Reference", linkTo: "creditNoteDetail" }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" }).nullable(),
  organization: DocumentOrganizationSnapshot,
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  items: z.array(CreditNoteDocItem).meta({ label: "Item" }),
  // Optional in beta H1 (the interface docblock).
  destinations: z.array(InvoiceDocDestination).optional().meta({ label: "Destination" }),
  totals: CreditNoteDocTotalsSchema,
  remaining_credit_cents: z.int().meta({ column: true, label: "Remaining Credit" }),
  // Bare `z.array(DocSource)` — the dropped `.default([])` is core#95 batch
  // 10. 13 of 13 in both projects already carry the key (`createCreditNote`
  // writes a literal `sources: []`).
  sources: z.array(DocSource),
  query_by_sources: z.array(z.string()),
  xero_id: z.uuid().nullable().optional(),
  xero_credit_note_id: z.uuid().nullable().optional().meta({ seed: false }),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkCreditNote)
  // A credit note is priced once, at creation (`priceCreditNote`). Once it is
  // applied or void its money has moved, and it keeps what it stored — see
  // `checkItemsLineMoney`.
  .superRefine((cn, ctx) => {
    // A line naming a billing row is priced as a PART of that row (first-come,
    // ruling 34 item 6), not from its own counts, so only unpointed lines are
    // checked here; dividers carry no price and are skipped anyway.
    if (cn.status !== "applied" && cn.status !== "void") {
      checkItemsLineMoney(cn.items.map((r) => isCreditNoteLine(r) && creditLineBillingPointer(r) === null ? r : {}), ctx);
    }
  }).meta({
  title: "Credit Note",
  collection: "credit-notes",
  displayDefaults: {
    columns: [
      "number",
      "date",
      "organization.path",
      "reason",
      "totals.total_cents",
      "remaining_credit_cents",
    ],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});
