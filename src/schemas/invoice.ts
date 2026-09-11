/**
 * Invoice document schema — Firestore collection: invoices
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { LineItemCore } from "./_items.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import {
  type RenderParamsContext,
  RenderParamsContextSchema,
} from "./template-version.ts";
import {
  ActorRef,
  type ActorRefType,
  checkItemPriceFormula,
  checkPriceBaseUnit,
  checkZeroPricedAmount,
  checkZeroPricedComponents,
  COARevenueEnum,
  type COARevenueType,
  DOC_LINE_ITEM_TYPES,
  type DocLineItemTypeType,
  DocumentOrganizationSnapshot,
  type DocumentOrganizationSnapshotType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  InvoiceStatusEnum,
  type InvoiceStatusType,
  isLineItemType,
  PriceFormulaEnum,
  type PriceFormulaType,
  TaxedAsEnum,
  type TaxedAsType,
  TimestampFields,
} from "./common.ts";
import {
  DestinationPairCore,
  Discount,
  DiscountInput,
  type DiscountInputType,
  type DiscountType,
  type DocDestinationType,
  type OrderDocDestinationItemType,
  type OrderDocGroupItemType,
  PriceModifier,
  type PriceModifierType,
  TaxRef,
  type TaxRefType,
  TotalsCore,
} from "./order.ts";

export { type InvoiceStatusType } from "./common.ts";
const InvoiceStatus: z.ZodType<InvoiceStatusType> = InvoiceStatusEnum;

// ── Status contracts ────────────────────────────────────────────

/**
 * What one invoice status admits, on every axis anything in CFS asks about.
 *
 * Five hand-written status sets used to live in four repos, and three of them
 * were textually identical while a fourth looked identical and was not. As
 * columns they stop looking like duplicates of each other and start being
 * separate answers to separate questions — which is what makes collapsing them
 * safe where a naive merge was not.
 */
export interface InvoiceStatusContract {
  /**
   * Statuses an **operator** may move to via `PUT /invoices/{uid}`.
   *
   * **Not the legal transition graph**, and the distinction is load-bearing.
   * `derivePaymentStatus` produces `issued → part_paid → paid`, and both
   * `markInvoiceVoidedFromXero` and the CRMS void hook force `→ void` from any
   * state; none of those appear here, and all of them are correct. Applying
   * this column to a Xero-authoritative path would break it.
   */
  operator_moves: readonly InvoiceStatusType[];
  /**
   * Has the invoice **ever** reached Xero? `INVOICE_STATUSES \ {draft}`.
   *
   * `void` is a member and that is deliberate: `selectXeroInvoiceTwin` lets a
   * void CFS invoice adopt a VOIDED Xero twin, so excluding it would strand
   * every void invoice at `xero_id == null` and bury the exact divergence
   * `reconcile-xero-invoice-links.ts` exists to find.
   */
  reached_xero: boolean;
  /**
   * Is the invoice **currently** live in Xero — i.e. is a Xero counterpart
   * expected to exist and be non-VOIDED? The near-twin of `reached_xero`; the
   * two differ only on `void`, which is the whole reason both exist.
   */
  live_in_xero: boolean;
  /**
   * Is the embedded snapshot frozen — no longer rewritten by an organization
   * name/address cascade? Neither `reached_xero`'s nor `live_in_xero`'s
   * complement; a third question.
   *
   * This column is why `"voided"` — a string that is not a member of
   * {@link InvoiceStatusType} — silently matched nothing in three org-cascade
   * queries and re-wrote every VOID invoice on any org edit.
   */
  settled: boolean;
  /**
   * May an operator record a further payment against it? Deliberately excludes
   * `paid`: without that, a payment against a fully-settled invoice drives
   * `amount_due` negative, and `derivePaymentStatus` then re-derives `paid`
   * from it and absorbs the overpayment silently.
   */
  accepts_payment: boolean;
}

/**
 * The per-status contract table.
 *
 * The `Readonly<Record<InvoiceStatusType, …>>` annotation is what enforces
 * totality: a sixth status is a type error **here**, at the declaration, which
 * forces an answer to all five questions rather than defaulting four of them.
 * No separate parity guard — a `T extends keyof typeof TABLE` assertion beside
 * this would read `T extends T` and could not fail.
 *
 * Deliberately **not** carrying an `amounts` column. Two status↔amounts rules
 * were proposed and both were killed by paging all 962 prod invoices:
 * `paid ⟹ amount_due <= 0` fails on 20 of 813, and `issued ⟹ amount_paid == 0`
 * fails on **75 of 98** — a bucket whose money matches Xero to the cent and
 * whose `status` is what is stale. The arithmetic identity that did survive
 * (`amount_paid + amount_credited + amount_due == total`, exempting `void`)
 * ships separately as a `superRefine`, because it is the one rule that does not
 * mention status.
 */
export const INVOICE_STATUS_CONTRACTS: Readonly<
  Record<InvoiceStatusType, InvoiceStatusContract>
> = {
  draft: {
    operator_moves: ["issued", "void"],
    reached_xero: false,
    live_in_xero: false,
    settled: false,
    accepts_payment: false,
  },
  issued: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: false,
    accepts_payment: true,
  },
  part_paid: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: false,
    accepts_payment: true,
  },
  paid: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: true,
    accepts_payment: false,
  },
  void: {
    operator_moves: [],
    reached_xero: true,
    live_in_xero: false,
    settled: true,
    accepts_payment: false,
  },
};

/**
 * May an operator move `from` to `to` via `PUT /invoices/{uid}`?
 *
 * Read this rather than the column, so the manager cannot offer a button the
 * server will 400 — and so a status outside the vocabulary answers `false`
 * instead of throwing on an undefined lookup.
 */
export function canOperatorTransition(from: string, to: string): boolean {
  const contract = (INVOICE_STATUS_CONTRACTS as Record<
    string,
    InvoiceStatusContract | undefined
  >)[
    from
  ];
  return contract?.operator_moves.some((s) => s === to) ?? false;
}

/** Every status whose contract answers `true` for `column`. */
function statusesWhere(
  column: "reached_xero" | "live_in_xero" | "settled" | "accepts_payment",
): InvoiceStatusType[] {
  return (Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[])
    .filter((s) => INVOICE_STATUS_CONTRACTS[s][column]);
}

/**
 * Statuses whose Xero counterpart is expected to exist and be non-VOIDED.
 *
 * Was three textually identical copies — `lib/xeroQuoteStatus.ts`,
 * `services/invoices.ts` and `api-cloudrun/scripts/audit-xero-quotes.ts`, the last carrying
 * a "keep in lockstep" comment that nothing enforced.
 */
export const LIVE_IN_XERO_STATUSES: readonly InvoiceStatusType[] =
  statusesWhere("live_in_xero");

/**
 * Statuses that have **ever** reached Xero. Includes `void` — see
 * {@link InvoiceStatusContract.reached_xero}. NOT interchangeable with
 * {@link LIVE_IN_XERO_STATUSES}, which is exactly the mistake this pair exists
 * to prevent.
 */
export const REACHED_XERO_STATUSES: readonly InvoiceStatusType[] =
  statusesWhere("reached_xero");

/** Statuses whose embedded snapshot is frozen against org-cascade rewrites. */
export const SETTLED_STATUSES: readonly InvoiceStatusType[] = statusesWhere(
  "settled",
);

/** Statuses that still admit a further payment. Excludes `paid` deliberately. */
export const ACCEPTS_PAYMENT_STATUSES: readonly InvoiceStatusType[] =
  statusesWhere(
    "accepts_payment",
  );

// Invoice item types are a superset of order item types — they add the "order"
// divider. That superset had a name here (`InvoiceItemTypeType`, an alias of
// `ITEM_TYPES`) for exactly one purpose: typing the flat input schema's
// `type` field. Both input unions are discriminated now, so each arm names its
// own literal and the combined enum has no consumer left. The vocabulary itself
// still lives in `schemas/common.ts` (`ITEM_TYPES` / `ITEM_CONTRACTS`).

// ── Payment tracking: GONE, not deprecated ──────────────────────
//
// `Invoice.payments[]` and its `InvoicePayment` type were deleted here on
// 2026-08-03. Settlement lives in the top-level append-only `settlements`
// collection, which is what made credit notes expressible at all: Xero settles
// an invoice two ways — cash (`Payments[]`) and credit allocation
// (`CreditNotes[]`) — and this array could only ever model the first. Invoice
// #1322 recorded $4,495.62 as cash collected that was never collected, and
// every reconciliation reported it clean because CFS and Xero agreed on the one
// number they could both express.
//
// The field survived one beta past its replacement purely as PARSE TOLERANCE:
// `InvoiceSchema` is a `z.strictObject`, so an undeclared `payments` would have
// failed validation on the next write of any document still carrying one. That
// is now moot — `migrate-payments-to-settlements.ts --drop-legacy` stripped it
// from all 967 prod / 968 dev invoices on 2026-08-02, and
// `audit-settlement-totals.ts` reports both envs clean. A strict object is the
// enforcement: an invoice cannot acquire a `payments` array again.
//
// `PAYMENT_STATUSES` and `UpdatePaymentInput` went with it — the endpoints they
// typed (`POST /invoices/{uid}/payments`, `PATCH .../payments/{payment_uid}`)
// no longer exist, because correcting an append-only journal is another append.

// ── Item price ───────────────────────────────────────────────────

/** Pricing breakdown for a single invoice line item. */
export interface InvoiceDocItemPriceType {
  base_cents: number;
  /** See {@link OrderDocItemPriceType.base_percent} — same biconditional. */
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  /**
   * Intrinsic (pre-override) tax snapshot — see
   * {@link OrderDocItemPriceType.taxes_base}, whose semantics this shares
   * exactly. Projected from the source order line, or set at build time on an
   * invoice-native line.
   *
   * ⚠️ **It is no longer a revert buffer.** It existed because the doc-level
   * `tax_profile` override rewrote `taxes` and nothing else, so a revert had
   * nothing to restore from. `tax_profile` is deleted and the jurisdiction rule
   * is total — `assignLineTaxes` writes both fields on every document write —
   * so the field now carries the meaning it always described: the tax this line
   * would attract were the customer not exempt. (`materializeDocumentTax` also
   * has no early return any more; it reprices unconditionally.)
   *
   * Optional, and it will stay optional: no invoice line written before
   * 2026-08 carries one.
   */
  taxes_base?: TaxRefType[];
  total_cents: number;
}

const InvoiceDocItemPrice: z.ZodType<InvoiceDocItemPriceType> = z.strictObject({
  base_cents: z.int().meta({ column: true, label: "Base Price" }),
  base_percent: z.number().nullable().optional(),
  // 🔴 `.int()`, matching `OrderDocItemPrice.chargeable_days`. A count of days
  // has no fractional value that means anything, which is `CLAUDE.md` § *Stored
  // money is integer cents* — "an INTEGRAL quantity is `z.int()` … a count of
  // things — units, documents, attempts, days". This grain admitted 2.5. 0 of
  // 1,040 stored invoices carry a fractional value in either project, and 0
  // across the 23 committed `invoice`+`quote` fixtures in `templates`.
  chargeable_days: z.number().int().nullable().meta({
    column: true,
    label: "Chargeable Days",
  }),
  formula: PriceFormulaEnum.meta({
    column: true,
    label: "Formula",
  }),
  subtotal_cents: z.int().meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().meta({
    column: true,
    label: "Discounted Subtotal",
  }),
  discount: Discount.nullable().meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax" }),
  // Labelled for the same reason the order side's is: `TaxRef` carries `name`
  // and `rate` as columns, so every key holding one inherits two columns and has
  // to name them, or the pre-override snapshot collides with the live `taxes`.
  taxes_base: z.array(TaxRef).optional().meta({ label: "Base Tax" }),
  total_cents: z.int().meta({ column: true, label: "Total" }),
}).superRefine(checkPriceBaseUnit);

// ── Line items ───────────────────────────────────────────────────

/** A billable line item on an invoice. */
export interface InvoiceDocLineItemType {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: InvoiceDocItemPriceType;
  path: string[];
  /**
   * Was this line included at no charge as part of its parent product?
   *
   * ⭐ **Mirrored from `OrderDocLineItemType.zero_priced` so the invoice line
   * carries the same fact as the order line it is projected from**
   * (`manager#421`). The manager's `isZeroPricedComponent` on this side read it
   * through a CAST — the schema had no such key, so the predicate could only
   * ever return `false`, and four guards plus a collapse rule below it were
   * dead. The cast is what hid it: without one it would have been a compile
   * error the day this schema was written.
   *
   * ⚠️ **Same shape as the order's — `.nullable().optional()`, deliberately.**
   * Making it required here would make an invoice line STRICTER than the order
   * line it mirrors, which is the opposite of the alignment this exists for; a
   * divider row and a plain top-level rental have no meaningful boolean.
   *
   * ⭐ **EMITTED since 2026-09-10**, unconditionally as `?? null`, by
   * `projectOrderItemToInvoiceItem` and by `api-cloudrun`'s hand-mirrored
   * `buildInvoiceItems`. The corpus was backfilled first — 1,037 of 1,040 prod
   * invoices, 9,590 rows — because `invoiceItemDifferences` compares top-level
   * KEY SETS and `buildOrderLine` writes the key on every order line, so an emit
   * ahead of the backfill would have made every paired line differ at once.
   *
   * ⚠️ **The key is present on every line, valued `null` where the order line
   * states nothing.** Absence means a line written before the backfill, not "no
   * answer" — a component with no answer is what the core#100 refine refuses.
   */
  zero_priced?: boolean | null;
  coa_revenue?: COARevenueType | null;
  /**
   * @see `OrderDocLineItemType.taxed_as`. Mirrored onto the invoice so an
   * order→invoice projection round-trips it, and so `invoiceItemsMatch` can
   * compare it rather than report every affected line `out_of_sync` forever —
   * that comparator matches on KEY SETS, and a comparable field present on one
   * side only has caused exactly that three times (`base_percent`, `crms_id`,
   * `price.discount_percent`: 8,015 of 8,978 paired lines).
   */
  taxed_as?: TaxedAsType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_opportunity_id?: number | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_id?: number | string | null;
  /**
   * Operator-set on substitution line items. Carries the path of the
   * substituted-for ORDER line at the moment of substitution — locked then, and
   * never re-derived. It is the record that this invoice deliberately diverges
   * from its order, not a live pointer.
   *
   * ⚠️ **The invoice's divergence is a MONEY concern and moves no bookings** —
   * that is the one place it differs from `FulfillmentLineItemType`'s field of
   * the same name, whose divergence is a physical fact.
   *
   * **Why `.optional()` rather than the repo's preferred bare `.nullable()`**
   * (`CLAUDE.md` § *Making a field REQUIRED*, and the ruling in
   * `tests/stored-optionality.test.ts`):
   *
   * 1. **No writer can supply it on every line.** It is meaningful only where a
   *    substitution happened; `null` on the other ~8,900 stored lines would be
   *    filler to satisfy a requirement, which is the "never reach for
   *    `.nullable()` as a cushion" clause rather than an exception to it.
   * 2. 🔴 **The tightening procedure is not even executable here.** Step 1 is a
   *    both-environment key-presence census, whose only oracle is `orderBy` —
   *    and this field sits inside an ARRAY OF MAPS, which `orderBy` cannot
   *    reach. That is `stored-optionality.test.ts`'s own
   *    `array-member-uncensusable`.
   * 3. **Its twin is already spelled this way.**
   *    `FulfillmentLineItemType.path_substituted_for` is plain `.optional()`,
   *    and this field's entire job is to mean the same thing on a second
   *    surface. Two spellings of one fact is the defect
   *    {@link INVOICE_ONLY_ITEM_FIELDS} records under `crms_id`.
   * 4. **Absence cannot reach the state the ruling protects against.** Every
   *    consumer is already absence-shaped — `pickInvoiceOnlyFields` skips
   *    `undefined`, `projectOrderItemToInvoiceItem` spreads conditionally, and
   *    `invoiceItemDifferences` counts `undefined` as not-present — so no path
   *    hands a literal `undefined` to a write boundary.
   */
  path_substituted_for?: string[];
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`.
const InvoiceDocLineItemInner = z.strictObject({
  // The six shared fields come from `_items.ts` as ONE instance each. Two of
  // them are a TIGHTENING here and nowhere else: this grain declared `name` as a
  // bare `z.string()` and `quantity` as `z.int()` with no lower bound, so an
  // invoice line could store an empty name and a negative quantity that the
  // order line it was billed from could not. Cleared by
  // `api-cloudrun/scripts/audit-document-grain-parity.ts` — 0 offenders in
  // either project — and by the 154 line items across the 23 committed
  // `invoice`+`quote` fixtures in `templates`.
  // 🔴 **SPREAD, not per key** — the six shared fields, one instance each, from
  // `_items.ts`, in one canonical order at the head of every grain. A grain that
  // omits one is now a compile error; `tests/item-shape-parity.test.ts` still
  // holds the SHADOWING case, which no spread can catch.
  type: z.enum(DOC_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...LineItemCore,
  price: InvoiceDocItemPrice,
  coa_revenue: COARevenueEnum.nullable().optional(),
  taxed_as: TaxedAsEnum.nullable().optional().meta({
    column: true,
    label: "Taxed As",
  }),
  tracking_category: z.string().nullable().optional(),
  xero_id: z.uuid().nullable().optional(),
  xero_tracking_option_id: z.uuid().nullable().optional(),
  crms_opportunity_id: z.int().nullable().optional(),
  crms_id: z.union([z.int(), z.string()]).nullable().optional(),
  // Plain `.optional()`, matching `FulfillmentLineItem.path_substituted_for`
  // exactly — see the interface docblock for why this one is not `.nullable()`.
  path_substituted_for: z.array(ItemUid).optional(),
}).superRefine(checkItemPriceFormula).superRefine(checkZeroPricedAmount);

// 🔴 `checkZeroPricedAmount` moved onto the **Inner** const on 2026-09-09, and
// until then it never ran when an invoice document parsed. It was attached here,
// to the exported alias, while `InvoiceDocItem`'s discriminated union below is
// built from the un-refined `InvoiceDocLineItemInner` — so `validateBeforeWrite`
// on an invoice never asked whether a `zero_priced` line carried a charge. The
// order grain has always attached it to its Inner (`order.ts`), which is why the
// two grains disagreed. Fulfillment attaches it too, but there it is vacuous:
// a fulfillment line has no `price`, so the check returns early.
//
// Cleared to land by the census: 0 invoice lines in either project carry
// `zero_priced === true` with a non-zero `base_cents`, and 0 across the fixture
// corpus. This is a tightening of what PARSES, not a new field — it belongs in
// the census-gated set even though nothing about it looks like a migration.
export const InvoiceDocLineItem: z.ZodType<InvoiceDocLineItemType> =
  InvoiceDocLineItemInner;

// ── Order divider ───────────────────────────────────────────────

/** Order divider item — scopes invoice items to a source order for multi-order invoices. */
export interface InvoiceDocOrderItemType {
  uid: string;
  type: "order";
  name: string;
  path: string[];
  description: string;
}

const InvoiceDocOrderItemInner = z.strictObject({
  // Option B: the order divider's identity IS the source order's Firestore doc-id
  // (order.uid), not a synthesized UUID — so this is z.string(), not z.uuid().
  uid: ItemUid,
  type: z.literal("order"),
  // Machine-generated, not operator-typed: 218/218 order dividers in the dev
  // replica are literally `Order #NNN`. See `OrderDocLineItem.name`.
  name: z.string().max(200).meta({ pii: "none" }).default(""),
  path: z.array(ItemUid).default([]),
  description: z.string().meta({ pii: "none" }),
});

/** Zod schema for an order divider item. */
export const InvoiceDocOrderItem: z.ZodType<InvoiceDocOrderItemType> =
  InvoiceDocOrderItemInner;

// ── Item union ──────────────────────────────────────────────────

/** Union of all item types stored in an invoice document. */
export type InvoiceDocItemType =
  | InvoiceDocLineItemType
  | OrderDocGroupItemType
  | OrderDocDestinationItemType
  | InvoiceDocOrderItemType;

/**
 * Zod schema for any invoice document item — discriminated on `type`.
 *
 * The invoice side never carried a second `transaction_fee` claimant, so it was
 * always discriminable; it stayed a plain union only because the order side
 * wasn't. See `OrderDocItem`.
 */
export const InvoiceDocItem: z.ZodType<InvoiceDocItemType> = z
  .discriminatedUnion("type", [
    InvoiceDocLineItemInner,
    GroupDividerArm,
    DestinationDividerArm,
    InvoiceDocOrderItemInner,
  ]);

/**
 * Type guard that narrows an invoice doc item to a billable line item (excludes
 * structural dividers).
 *
 * The narrowing target is invoice-specific, but the DECISION is not: it is
 * `ITEM_CONTRACTS[type].kind`, shared with `isLineItem` in `order.ts`. Written
 * out by hand this read `!== "destination" && !== "group" && !== "order"` — one
 * clause longer than the order guard, which is exactly the kind of difference
 * that looks like a bug and is not.
 */
export function isInvoiceLineItem(
  item: InvoiceDocItemType,
): item is InvoiceDocLineItemType {
  return isLineItemType(item.type);
}

// ── Totals ───────────────────────────────────────────────────────

/**
 * Invoice-level totals with settlement tracking.
 *
 * `amount_paid`, `amount_credited` and `amount_due` are a **co-written
 * projection** of the `settlements` journal — produced only by
 * `recomputeSettlementTotals`, written in the same transaction as the settlement
 * that changed them, and rebuildable from the log by
 * `api-cloudrun/scripts/repair-invoice-settlement-totals.ts`. They are not a denormalization
 * to apologise for; they are the target architecture, and the same shape
 * `stock/{P}` already has against the movement journal.
 *
 * `total` is NOT part of that projection — it derives from `items[]`. So the
 * rebuild is deliberately **partial**: it repairs the settlement-fed fields
 * without re-pricing anything.
 */
export interface InvoiceDocTotalsType {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  amount_paid_cents: number;
  /**
   * Value settled by credit note rather than cash. **Sits beside `total` and
   * never reduces it** — keeping "billed 18,196 / collected 16,000 / wrote off
   * 2,196" legible is the entire point.
   *
   * Optional so the compiler forces `?? 0` at every read until the migration has
   * stamped the ~962 pre-existing invoices.
   */
  amount_credited_cents?: number;
  /**
   * Value annulled by voiding the invoice. **The third settlement bucket**, and
   * the reason `amount_due_cents` on a void invoice is now derived like every
   * other invoice's instead of being assigned.
   *
   * A void used to be a *field override*: `amount_due_cents` was set to 0 while
   * the journal still folded to `total`. That forced the identity refine below
   * to exempt void invoices, which made the exemption a blind spot — an invoice
   * voided by a path that forgot to zero the balance looked exactly like one
   * that had zeroed it correctly, and 7 prod invoices sat that way undetected
   * (api-cloudrun#436). As a `void` settlement row the fold produces the 0
   * itself, so the identity holds on every invoice and the class becomes
   * visible to the corpus audit.
   *
   * Optional for the same reason as `amount_credited_cents`: the field postdates
   * the corpus, and `validateBeforeWrite` persists the RAW doc, so a schema
   * default would never materialize — it would only hide the absence from the
   * compiler at every read.
   */
  amount_void_cents?: number;
  amount_due_cents: number;
}

// The six shared fields come from `TotalsCore` (`schemas/order.ts`) as ONE
// instance each, referenced per key rather than spread: this grain orders
// `discount_amount_cents` THIRD where the order puts it first, and a schema's
// key order is its Firestore column order. `tests/totals-parity.test.ts` holds
// the anti-drift guarantee the syntax cannot.
const InvoiceDocTotals: z.ZodType<InvoiceDocTotalsType> = z.strictObject({
  subtotal_cents: TotalsCore.subtotal_cents,
  subtotal_discounted_cents: TotalsCore.subtotal_discounted_cents,
  discount_amount_cents: TotalsCore.discount_amount_cents,
  taxes: TotalsCore.taxes,
  transaction_fees: TotalsCore.transaction_fees,
  total_cents: TotalsCore.total_cents,
  amount_paid_cents: z.int().meta({
    column: true,
    label: "Amount Paid",
  }),
  // Bare `.optional()` with NO default, deliberately: ~962 prod invoices
  // predate the field, and `validateBeforeWrite` persists the RAW doc, so a
  // schema default would never materialize anyway — it would only hide the
  // absence from the compiler at every read.
  amount_credited_cents: z.int().optional().meta({
    column: true,
    label: "Amount Credited",
  }),
  // Same: bare `.optional()`, no default. See the interface docblock.
  amount_void_cents: z.int().optional().meta({
    column: true,
    label: "Amount Voided",
  }),
  // Unbounded on purpose: an over-credited invoice must stay negative.
  amount_due_cents: z.int().meta({
    column: true,
    label: "Amount Due",
  }),
});

// ── Destinations ────────────────────────────────────────────────

/**
 * Destination pair on an invoice — mirrors the order's `DocDestinationType`
 * with a `uid_order` scope field so multi-order invoices can carry pairs
 * from several orders and have them selectively synced per source order.
 * Carries `dates` (rendered on the invoice) snapshotted from the source order.
 *
 * ⭐ **A new field on this pair is now ONE edit, and it is not in this file.**
 * It used to be four, of which the compiler caught one. The `extends` below hands
 * over the TYPE; `InvoiceDocDestination` restated the same six keys by hand and
 * inherited nothing, so a field added to the order's pair type-checked here and
 * was then REFUSED at write. That is not hypothetical — it is how both flags kept
 * a `.default(false)` the order grain had already removed (core#101, 16 absent
 * flags across 8 prod invoices). The schema now spreads `DestinationPairCore`, so
 * declaring a field there lands it on both grains.
 *
 * The other three enumerators have all become walks and need no edit either:
 * `toInvoiceDestinationPair` projects with `Object.entries` (its docblock says the
 * spread is deliberate — do not tidy it into a field list), `pairsMatch`
 * destructures `{ uid_order, dates, ...rest }` and compares `rest`, and
 * api-cloudrun's CRMS invoice webhook map is deleted.
 *
 * ⚠️ **What a new field still needs is an override RULING**: whether it belongs in
 * `INVOICE_OVERRIDABLE_PAIR_FIELDS` (`@cfs/core/utils/invoices`) — payload the
 * invoice owns and `carryOverridablePairFields` reconciles — or is order-authored
 * and freezes the pair when it differs. That is a policy call, and no shape can
 * make it.
 */
export interface InvoiceDocDestinationType extends DocDestinationType {
  uid_order: string;
}

export const InvoiceDocDestination: z.ZodType<InvoiceDocDestinationType> = z
  .strictObject({
    // The one key the invoice grain adds: which of a multi-order invoice's source
    // orders this pair is scoped to. It sits FIRST, which is what makes the spread
    // below order-preserving — `uid_order` was already the first key here, and
    // `DestinationPairCore` is the rest of this object in its existing order.
    uid_order: FirestoreId,
    // 🔴 **THIS LIST USED TO INHERIT NOTHING.** It restated `DocDestination`'s six
    // keys by hand, and had already drifted: it kept `z.boolean().default(false)`
    // on `customer_collecting` / `customer_returning` after `9435a15` made both
    // REQUIRED on the order grain. Nothing could see it — the TYPE is inherited
    // through `extends`, so the compiler was satisfied, and the default is inert on
    // a write, so no document ever gained the flag it let a writer omit.
    //
    // ⚠️ **The 16 absent flags this dropped default produced were REPAIRED before
    // it was removed** (core#101, 2026-09-09, prod and dev), and repaired by
    // projecting each invoice's source order rather than by writing the default —
    // it would have been wrong on 5 of the 8 documents. The tightening is only safe
    // because the census reads 0, and it reads 0 because a migration ran.
    //
    // ⚠️ The invoice's divider REUSES the order's (`adoptOrderDividerStructure`
    // keeps a divider the invoice already carries under the same uid), so a pair
    // projected by `toInvoiceDestinationPair` arrives already keyed correctly.
    ...DestinationPairCore,
  });

// ── Document schema ──────────────────────────────────────────────

/** An invoice document in the invoices Firestore collection. */
export interface Invoice {
  uid: string;
  number: number;
  status: InvoiceStatusType;
  query_by_orders: string[];
  number_orders: number[];
  /**
   * This invoice's exemption, or `null` to inherit the organization's.
   *
   * ⚠️ **Sticky**: `org.tax_exempt || doc.tax_exempt === true`, never
   * `doc ?? org` — see `Order.tax_exempt` for the full rule and why `false`
   * asserts nothing rather than un-exempting.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  tax_exempt?: boolean | null;
  /**
   * Which store this invoice sells FROM — the ORIGIN for Illinois origin
   * sourcing, and the invoice-side twin of {@link Order.uid_store}.
   * `null`/absent means the `default: true` store, so the 1,019 existing
   * invoices need no migration.
   *
   * ⚠️ **Not `booking.uid_store`**, which is per-line and records which store's
   * stock filled that line. Origin sourcing is a property of the DOCUMENT.
   *
   * ⚠️ An invoice's origin is its OWN, not its source order's. It is projected
   * from the order at create and then editable, exactly as
   * `destinations[i].jurisdiction` is — because a correction arrives on the
   * invoice (api-cloudrun#630).
   */
  uid_store?: string | null;
  date: string;
  date_fs: FirestoreTimestampType;
  due_date?: string;
  due_date_fs?: FirestoreTimestampType;
  /**
   * Required, non-nullable, and the SAME declaration as `Order.subject` and
   * `Fulfillment.subject` — `""` is "no subject" at all three grains
   * (core#97 increment 3, 2026-09-09). This grain used to be the outlier:
   * `z.string().nullable()`, because `createInvoice` wrote `input.subject ??
   * null` while `createOrder` wrote `subject: ""` and the fulfillment
   * projection wrote `orderNew.subject ?? ""`. One document, three grains, two
   * spellings of the same absence.
   *
   * 🔴 **The census did NOT license this on its own, and reading it that way
   * was the error worth recording.** `subject` measured 0 null and 0 absent
   * across all three grains in prod and dev (1,020 orders / 1,040 invoices /
   * 1,020 fulfillments, 2026-09-09) — and that is evidence about the INPUTS SO
   * FAR, not about the writer. `CreateInvoiceInputType.subject` is
   * `z.string().optional()`, so the very next invoice created without one would
   * have been written `null` and refused here. This is the `orders.crms_status`
   * trap in `core/CLAUDE.md` § *Making a field REQUIRED* verbatim: 995/995
   * present, and requiring it would 400 the native create path the first time
   * it ran. **The WRITER is what distinguishes the two cases, and it moved
   * first** — `api-cloudrun` `createInvoice` now writes `input.subject ?? ""`,
   * landed and pinned before this tightened.
   *
   * ⚠️ Note this is a bare `z.string()` and not `z.string().default("")`, which
   * is what order and fulfillment carried until this same commit. A
   * `.default()` is inert on a write (`validateBeforeWrite` discards
   * `result.data`), so its one effect was to let a writer OMIT the key — the
   * looser accepted set, and the one that yields `undefined` from
   * `docData<T>`. `getInitialValues` is unaffected: its `case "string"` already
   * returns `""`, which is why all three grains' form seeds are byte-identical
   * before and after.
   *
   * ⚠️ `CreateInvoiceInputType.subject` stays `.optional()`: a CLIENT may omit
   * it and the writer supplies `""`. Normalize at the writer, require at
   * storage — the same split `reference` and `notes` below describe, which
   * differ only in that their absence really is `null` at every grain.
   */
  subject: string;
  /**
   * ⚠️ **`.nullable()`, deliberately NOT `.optional()`** — present-and-null, never
   * absent. Under `z.strictObject` those are different accepted sets, and the
   * absent one is the state that yields `undefined`: an invoice missing this key
   * made `stageOrderInvoiceSync` hand `patch.reference = undefined` to the write
   * boundary, which 400s the whole ORDER update (api-cloudrun#850's test found
   * it). Tightened 2026-09-05 on evidence: all four invoice writers already do
   * `reference: input.reference ?? null`, all 1,037 prod invoices carry the key
   * (857 of them `null`), and its sibling `subject` above was already bare
   * `.nullable()` — so this field was the outlier, not the convention.
   *
   * `CreateInvoiceInputType.reference` stays optional: a CLIENT may omit it and
   * the writer supplies `null`. Normalize at the writer, require at storage.
   */
  reference: string | null;
  /**
   * The only notes field, and customer-facing — it replaced the
   * `external_notes` / `internal_notes` pair. `internal_notes` moved to a
   * comment on the document's own thread, where it is searchable, attributable
   * and repliable; `external_notes` was renamed to this.
   *
   * REQUIRED and bare `.nullable()`, matching `subject` / `reference` above.
   * This is the `orders.crms_id` shape in `core/CLAUDE.md` § *Making a field
   * REQUIRED*, not a tightening waiting on a census: `createInvoice` writes
   * `notes: input.notes ?? null`, so the WRITER produces the explicit `null`,
   * and `null` is a real answer — *no notes recorded* — rather than "unknown".
   * The predecessor pair was `.nullable().optional()` only because nothing
   * normalized it; key-presence was already 100% (1,037/1,037) on the strength
   * of `external_notes: input.external_notes ?? null` alone.
   *
   * `CreateInvoiceInputType.notes` stays optional: a CLIENT may omit it and the
   * writer supplies `null`. Normalize at the writer, require at storage.
   */
  notes: string | null;
  organization: DocumentOrganizationSnapshotType;
  /**
   * Required, and possibly empty — but only for a STANDALONE invoice. The lower
   * bound is real and already here; it lives on the document `.refine()` at the
   * bottom of `InvoiceSchema` rather than on the array:
   * `query_by_orders.length === 0 || destinations.length >= 1`. So an invoice
   * linked to at least one source order is held to `.min(1)` exactly as
   * `OrderDocument.destinations` and `Fulfillment.destinations` are; an invoice
   * with no source order is not.
   *
   * ⭐ **That conditional bound was a design intention, and core#97 increment 3
   * turned it into a measured one.** **31 stored invoices carry `[]` in prod and
   * dev** — 29 always did, and 2 more were repaired into it from an ABSENT key
   * on 2026-09-09 (see below), which is why the total is 31 and not 29 and why
   * nothing about the population changed. All 31 are FLAT
   * CRMS-ingested invoices: every one has a `crms_id`, an empty `number_orders`
   * and an empty `query_by_orders` (26 from the 2025-12-02 import, 5 from the
   * CRMS webhook between 2026-07-28 and 2026-08-17). **0 of 1,040 are empty AND
   * order-linked, in both projects** — so the refine is being used by precisely
   * the class it was written for, rather than exempting a population nobody had
   * looked at.
   *
   * 🔴 **So do NOT "add the missing `.min(1)`" to the array.** An unconditional
   * bound is strictly stronger than that refine and would refuse every one of
   * those 31 on its next write — 30 are `paid` and #2386 is `issued` and
   * future-dated (2026-09-17), so all of them are still writable, and the refusal would
   * surface on an operator unable to save rather than on a deploy. A pair is
   * PROJECTED from its order by `toInvoiceDestinationPair`; an invoice with no
   * order has nothing to project, and `[]` is its true state rather than a gap.
   *
   * ⭐ And it would buy nothing going forward: `createInvoice` always assigns
   * this key, `CreateInvoiceInputType.query_by_orders` is `.min(1)`, and an
   * order's own `destinations` is `.min(1)` — so a natively created invoice
   * structurally cannot have fewer than one pair. The empty array is an artifact
   * of an ingest that closed on 2026-09-04.
   *
   * 🔴 **What WAS a defect is the `.default([])`, and it is now dropped.** A
   * default is inert on a write (`validateBeforeWrite` discards `result.data`),
   * so its one effect was to let a writer omit the key entirely — which 2
   * invoices did, against a declaration that is non-optional. `docData<Invoice>`
   * casts rather than parses, so those two handed every reader `undefined` where
   * this type promises an array, and the document `.refine()` above would have
   * thrown on `inv.destinations.length` had anything actually parsed them. That
   * is `reference`'s failure above verbatim (api-cloudrun#850), and core#83's
   * class. Both were repaired to an explicit `[]` in prod and dev before this
   * dropped, by `api-cloudrun/scripts/backfill-invoice-destinations-key.ts` —
   * **a one-shot, since deleted with the pin bump that adopted this schema.**
   * ⚠️ The re-runnable check is not that script but
   * `api-cloudrun/scripts/audit-document-grain-parity.ts`, whose
   * "invoices: destinations key ABSENT" row is this field's gate and must read
   * 0, beside an "EMPTY array" row that is EXPECTED to read 31.
   */
  destinations: InvoiceDocDestinationType[];
  items: InvoiceDocItemType[];
  totals: InvoiceDocTotalsType;
  xero_id: string | null;
  uploadcare_uuid: string | null;
  pdf_generated_at: FirestoreTimestampType | null;
  /**
   * Render params the CURRENT draft PDF was rendered at — the twin of
   * `pdf_generated_at`, for the artifact `uploadcare_uuid` points at. The map
   * `resolveRenderParams` returned inside `renderDocument`, handed back by it
   * rather than re-derived. `{}` means none were recorded.
   */
  pdf_params: Record<string, boolean>;
  /**
   * The param DECLARATION `pdf_params` was resolved against, snapshotted at
   * render time — see {@link RenderParamsContext}. `null` = not recorded.
   *
   * Named for the map it describes (`pdf_params` → `pdf_params_context`), which
   * is what pairs it here: this document carries TWO params maps, and the other
   * one's context sits inside `pdf_versions[]` under `params_context`.
   */
  pdf_params_context: RenderParamsContext | null;
  pdf_versions: Array<{
    version: number;
    uploadcare_uuid: string;
    created_at: FirestoreTimestampType;
    created_by: ActorRefType;
    deleted_at: FirestoreTimestampType | null;
    /**
     * The render params this version's PDF was actually rendered at, as the
     * renderer resolved them. `{}` means none were recorded (every row written
     * before the field existed — of which there are none, the array being
     * empty corpus-wide when it landed).
     */
    params: Record<string, boolean>;
    /**
     * The param DECLARATION this row's `params` was resolved against — see
     * {@link RenderParamsContext}. `null` = not recorded.
     */
    params_context: RenderParamsContext | null;
  }>;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  /**
   * ⚠️ **1,019 of 1,019 in both environments, and it stays optional.** The
   * number describes the INGEST, not the document: `createInvoice`
   * (`api-cloudrun/src/services/invoices.ts`) writes no top-level `crms_id` at
   * all, so a natively created invoice has no key. Every stored invoice carries
   * one because every stored invoice came from CRMS.
   *
   * ⚠️ Note the asymmetry with `Order.crms_id`, which IS required-and-nullable:
   * `createOrder` stamps an explicit `null` and this writer does not. The two
   * corpora read identically and the schemas correctly differ.
   */
  crms_id?: number | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_opportunity_ids?: number[];
  /**
   * Required. `createInvoice` stamps `invoiceThreadDoc.uid` in the same
   * transaction that writes the invoice, and **1,019 of 1,019 in prod and dev
   * carry the key** (2026-08-23, `orderBy` key-presence).
   */
  uid_thread: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for an Invoice document. */
export const InvoiceSchema: z.ZodType<Invoice> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "invoiceDetail" }),
  status: InvoiceStatus.meta({ column: true, label: "Status" }),
  query_by_orders: z.array(z.string()),
  number_orders: z.array(z.int()).default([]).meta({
    column: true,
    label: "Order #",
  }),
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  tax_exempt: z.boolean().nullable().optional().meta({
    column: true,
    label: "Tax Exempt",
  }),
  uid_store: FirestoreId.nullable().optional(),
  // The ISO field carries the annotation; its `_fs` Timestamp mirror is the
  // same column under the other encoding — see `FS_MIRROR_SUFFIX`.
  date: chicagoStartOfDay().meta({
    column: true,
    label: "Date",
    serverSortVia: "date_fs",
  }),
  date_fs: FirestoreTimestamp,
  due_date: chicagoStartOfDay().optional().meta({
    column: true,
    label: "Due Date",
    serverSortVia: "due_date_fs",
  }),
  due_date_fs: FirestoreTimestamp.optional(),
  // `mask` — see the note on `subject` in `order.ts`; same field, same ruling.
  // Bare `z.string()`, identical to the other two grains as of core#97
  // increment 3 — the interface above carries the evidence and the ordering.
  subject: z.string().meta({
    pii: "mask",
    column: true,
    label: "Subject",
    linkTo: "invoiceDetail",
  }),
  // `.max(255)` matches `OrderDocument.reference` and `Fulfillment.reference`;
  // this grain was the only one without a bound. 0 of 1,040 stored invoices
  // exceed it in either project (2026-09-09 census).
  reference: z.string().max(255).nullable().meta({
    column: true,
    label: "Reference",
    linkTo: "invoiceDetail",
  }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" })
    .nullable(),
  organization: DocumentOrganizationSnapshot,
  // No `.default([])`, and the lower bound is CONDITIONAL and lives on the
  // document `.refine()` at the bottom of this schema — see the interface,
  // which carries both rulings and the populations behind them. Do not add an
  // unconditional `.min(1)` here: it is strictly stronger than that refine and
  // refuses the standalone class the refine deliberately admits. Re-run
  // `api-cloudrun/scripts/audit-document-grain-parity.ts` before changing
  // either — its "destinations key ABSENT" row is this field's gate and must
  // read 0, and its "destinations is an EMPTY array" row is EXPECTED to read 31
  // and must NOT be driven down.
  destinations: z.array(InvoiceDocDestination),
  items: z.array(InvoiceDocItem).default([]).meta({ label: "Item" })
    .superRefine(checkZeroPricedComponents),
  totals: InvoiceDocTotals,
  xero_id: z.uuid().nullable(),
  uploadcare_uuid: uploadcareRef(z.string().nullable().default(null)),
  pdf_generated_at: FirestoreTimestamp.nullable().default(null),
  // Required and no `.default({})`: a default never materializes on a write
  // (`validateBeforeWrite` discards `result.data`), so it would only license a
  // future writer to forget the stamp. `generateInvoicePdf` is the sole author.
  pdf_params: z.record(z.string(), z.boolean()),
  // Required and NULLABLE for the same reason `pdf_params` is required with no
  // `.default({})`: a default never materializes on a write, so it would only
  // license a future writer to forget the stamp. `generateInvoicePdf` is the
  // sole author of both.
  pdf_params_context: RenderParamsContextSchema.nullable(),
  // REQUIRED as of the documents-menu campaign (api-cloudrun#651), and the
  // writer is what licenses it: `createInvoice` has always written
  // `pdf_versions: []` on create (`services/invoices.ts`), so the 143 prod
  // invoices lacking the key are legacy, not output of the current create path
  // — backfilled to `[]` in the same campaign. Contrast `crms_id` four lines
  // below, same census shape and deliberately NOT tightened, because
  // `createInvoice` writes no top-level `crms_id` at all.
  // The journal now has a client: manager's Documents menu appends through
  // `saveInvoicePdfVersion` and lists these rows.
  pdf_versions: z.array(z.strictObject({
    version: z.number(),
    uploadcare_uuid: uploadcareRef(z.string()),
    created_at: FirestoreTimestamp,
    // Not a display column — this is the PDF version's author, not the
    // invoice's, and it sits inside an array nothing tabulates.
    created_by: ActorRef,
    deleted_at: FirestoreTimestamp.nullable(),
    params: z.record(z.string(), z.boolean()),
    params_context: RenderParamsContextSchema.nullable(),
  })),
  // NOT tightened — see the interface. `createInvoice` writes no top-level
  // `crms_id`; the 1,019/1,019 reading is about the CRMS ingest.
  crms_id: z.int().nullable().optional(),
  crms_opportunity_ids: z.array(z.int()).optional(),
  uid_thread: ThreadId,
  /** Optimistic-concurrency if-match token — bumped on every whole-doc write, not a revision pointer (mirrors orders/orgs/contacts). */
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).refine(
  (inv) => inv.query_by_orders.length === 0 || inv.destinations.length >= 1,
  {
    message:
      "destinations must be provided when the invoice is linked to at least one source order",
    path: ["destinations"],
  },
).refine(
  // EXACT, not a tolerance. Every operand is an integer count of cents, so
  // there is no representation error left to absorb and "within half a cent"
  // no longer describes anything — a half-cent gap is now unrepresentable, and
  // a one-cent gap is a real projection defect that the old epsilon would have
  // caught too.
  //
  // **The `void` exemption is RETIRED (api-cloudrun#436).** It read
  // `inv.status === "void" || …` because Xero closes a voided invoice's balance
  // while the journal still folded to `total` — true of the old field-override
  // model, and the cost was that the identity said nothing at all about a void
  // invoice. It could not distinguish "balance correctly zeroed" from "voided by
  // a path that forgot to zero it", which is the entire class #436 describes. A
  // void is now a `void` settlement summing into `amount_void_cents`, the fold
  // produces the 0 by itself, and the identity holds on all four buckets for
  // every invoice in the corpus.
  (inv) =>
    inv.totals.amount_paid_cents + (inv.totals.amount_credited_cents ?? 0) +
        (inv.totals.amount_void_cents ?? 0) +
        inv.totals.amount_due_cents === inv.totals.total_cents,
  {
    message:
      "amount_paid_cents + amount_credited_cents + amount_void_cents + amount_due_cents must equal total_cents exactly",
    path: ["totals", "amount_due_cents"],
  },
).meta({
  title: "Invoice",
  collection: "invoices",
  displayDefaults: {
    columns: ["number", "organization.path", "reference", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
});

// ── Input schemas ────────────────────────────────────────────────

/** Item price input — partial, server computes the rest. */
export interface InvoiceItemInputPriceType {
  base_cents?: number;
  base_percent?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  discount?: DiscountInputType | null;
  taxes?: Array<{ uid: string }>;
}

const InvoiceItemInputPrice: z.ZodType<InvoiceItemInputPriceType> = z.object({
  base_cents: z.int().optional(),
  base_percent: z.number().nullable().optional(),
  // `.int()` to match the stored `InvoiceDocItemPriceType.chargeable_days`. A count
  // of days is integral — `CLAUDE.md` § *Stored money is integer cents*.
  chargeable_days: z.int().nullable().optional(),
  formula: PriceFormulaEnum.optional(),
  discount: DiscountInput.nullable().optional(),
  taxes: z.array(z.object({ uid: FirestoreId })).optional(),
}).superRefine(checkPriceBaseUnit);

/**
 * A billable invoice line as a client sends it — the input mirror of
 * `InvoiceDocLineItem`.
 *
 * `uid_order` / `uid_delivery` / `uid_collection` are absent on purpose. The
 * flat schema this replaces accepted all three on any item; `buildInvoiceItems`
 * reads the destination pair only on a destination divider and reads `uid_order`
 * nowhere at all (the order divider's identity IS the source order's uid — the
 * transitional field was retired in Phase D, and the manager stopped sending
 * it). Prod agrees: 0 of 8,744 invoice line items carry any of the three.
 */
export interface InvoiceItemInputLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: InvoiceItemInputPriceType;
  path: string[];
  coa_revenue?: COARevenueType | null;
  /** @see `OrderDocLineItemType.taxed_as` — operator-authored, so it is accepted here. */
  taxed_as?: TaxedAsType | null;
  tracking_category?: string | null;
  /**
   * @see `InvoiceDocLineItemType.path_substituted_for`. Operator-authored, so it
   * needs an input channel: this schema is a plain `z.object` and STRIPS
   * unknown keys, and `buildInvoiceItems` rebuilds each stored line from typed
   * fields — so a field absent here is silently dropped on every PUT rather
   * than rejected.
   */
  path_substituted_for?: string[];
  /**
   * @see `InvoiceDocLineItemType.zero_priced`. NOT operator-authored — it is
   * projected from the order line — and it still needs an input channel, for
   * exactly the reason above: `buildInvoiceItems` rebuilds every stored line
   * from typed fields, so without this key here the next `PUT /invoices` would
   * strip the backfilled value off every line of that invoice, silently.
   *
   * ⚠️ The API does not trust it blindly either — `checkZeroPricedAmount` ties
   * `true` to `base_cents === 0`, so a client cannot flag a line it also
   * charges for.
   */
  zero_priced?: boolean | null;
}

// Un-annotated for `_zod.propValues`, `z.object` so unknown keys are stripped
// rather than rejected — see the note on `OrderItemLineInner`.
const InvoiceItemInputLineInner = z.object({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  //
  // 🔴 **Bounded to match the STORED schema (core#102).** Until 2026-09-09 this
  // was a bare `z.string()` while `LineItemCore.name` is `.min(1).max(100)`, so
  // a client could send `""`, pass request validation, and have the document
  // refused one layer down at `validateBeforeWrite` — an opaque failure inside
  // the write path instead of a clean rejection at the boundary. `CLAUDE.md`
  // § *Making a field REQUIRED* step 3 is the rule: tighten the input in the
  // same pass, wherever the writer cannot supply the value itself. The API
  // cannot invent an item name.
  //
  // ⭐ **`initial: ""` is what keeps "add a blank row, then type into it"
  // working**, and it is deliberately NOT a loosening of the constraint: the
  // form seeds an empty box, and a SUBMIT of `""` is still refused. ⚠️ Measured
  // 2026-09-09: it is redundant against `getInitialValues` today — `resolveField`
  // hits `case "string": return ""` whether or not the node carries `.min(1)`,
  // so all three spellings yield `{"name":""}`. Kept as an explicit statement of
  // intent, because the bound would otherwise read as forbidding a blank row.
  name: z.string().min(1).max(100).meta({ pii: "none", initial: "" })
    .optional(),
  // Line-item text — not customer data. See `OrderDocLineItem.description`.
  description: z.string().meta({ pii: "none" }).optional(),
  // `.min(0)` to match `LineItemCore.quantity`; the input admitted a negative.
  // ⚠️ **No `.meta({ initial })` beside it, and that is checked rather than
  // assumed** — no `quantity` field anywhere in the package carries one, and
  // `getInitialValues` derives `0` from `case "number"`, which is the RIGHT
  // seed. The five fields that do carry an `initial` are `z.boolean().default(true)`,
  // where the type-derived zero is wrong. Same reasoning `9435a15` recorded for
  // the destination pair's two flags.
  quantity: z.int().min(0).optional(),
  price: InvoiceItemInputPrice.optional(),
  path: z.array(ItemUid),
  coa_revenue: COARevenueEnum.nullable().optional(),
  taxed_as: TaxedAsEnum.nullable().optional(),
  tracking_category: z.string().nullable().optional(),
  path_substituted_for: z.array(ItemUid).optional(),
  zero_priced: z.boolean().nullable().optional(),
}).superRefine(checkItemPriceFormula);

/** Zod schema for a billable invoice line (input). */
export const InvoiceItemInputLine: z.ZodType<InvoiceItemInputLineType> =
  InvoiceItemInputLineInner;

/** A destination divider as a client sends it. */
export interface InvoiceItemInputDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path: string[];
}

// `z.strictObject`, unlike the line arm above — see the note on
// `OrderItemDestinationInner`: a divider has no extra stored fields for a client
// to ship back, so strictness turns "a divider carrying a price" into a 400 that
// names the key rather than a silent strip.
const InvoiceItemInputDestinationInner = z.strictObject({
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

/** Zod schema for a destination divider (invoice input). */
export const InvoiceItemInputDestination: z.ZodType<
  InvoiceItemInputDestinationType
> = InvoiceItemInputDestinationInner;

/** A group divider as a client sends it. */
export interface InvoiceItemInputGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path: string[];
}

// Strict for the same reason as the destination arm above.
const InvoiceItemInputGroupInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("group"),
  // Section header drawn from the catalog. See `GroupDividerArm.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid),
});

/** Zod schema for a group divider (invoice input). */
export const InvoiceItemInputGroup: z.ZodType<InvoiceItemInputGroupType> =
  InvoiceItemInputGroupInner;

/** An order divider as a client sends it — invoice-only, scopes items to a source order. */
export interface InvoiceItemInputOrderType {
  uid: string;
  type: "order";
  name?: string;
  description?: string;
  path: string[];
}

// Strict for the same reason as the destination arm above.
const InvoiceItemInputOrderInner = z.strictObject({
  // The divider's identity IS the source order's doc id — see
  // `InvoiceDocOrderItem`.
  uid: ItemUid,
  type: z.literal("order"),
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid),
});

/** Zod schema for an order divider (invoice input). */
export const InvoiceItemInputOrder: z.ZodType<InvoiceItemInputOrderType> =
  InvoiceItemInputOrderInner;

/** Input version of an invoice item — a line, or one of the three dividers. */
export type InvoiceItemInputType =
  | InvoiceItemInputLineType
  | InvoiceItemInputDestinationType
  | InvoiceItemInputGroupType
  | InvoiceItemInputOrderType;

/**
 * Zod schema for an invoice item (input) — discriminated on `type`, mirroring
 * the stored {@link InvoiceDocItem} union.
 *
 * `type` was itself `.optional()` here, which is why `buildInvoiceItems`
 * carried two `item.type ?? "rental"` defaults — and `rental` is the one type
 * whose stored contract demands a `price.replacement` that path never supplies,
 * so an item that omitted `type` was defaulted into the single most restrictive
 * shape. It is required now; the manager has always sent it (0 of 10,603 stored
 * invoice items lack one).
 *
 * The line arm comes first for the same `getInitialValues` reason as
 * {@link OrderItem}, and carries `checkItemPriceFormula` for the same reason —
 * it is the one contract axis an invoice price shape can answer (no
 * `stock_method`, no `price.replacement`; running the full check would reject
 * all 7,076 prod invoice rentals).
 *
 * NOTE there is deliberately no "first item must be a destination" refine on the
 * invoice side, unlike `CreateOrderInput`: 28 prod invoices legitimately start
 * with a line item — the flat CRMS invoices with no order divider at all.
 */
const InvoiceItemInputSchema: z.ZodType<InvoiceItemInputType> = z
  .discriminatedUnion("type", [
    InvoiceItemInputLineInner,
    InvoiceItemInputDestinationInner,
    InvoiceItemInputGroupInner,
    InvoiceItemInputOrderInner,
  ]);

/** Input schema for POST /invoices — create an invoice from orders. */
export interface CreateInvoiceInputType {
  uid: string;
  query_by_orders: string[];
  organization: { uid: string };
  /**
   * **The only tax fact a draft states.** `tax_profile` left this input at
   * api-cloudrun#596 item 2: the server derives an invoice's tax from the
   * organization's axes and the destinations it already projects, and the
   * document-level LOCATION profiles that were once the only home for an
   * order's jurisdiction now live on `destinations[i].jurisdiction` (migrated
   * 2026-08-21, 55 documents).
   *
   * The precedent for the removal is #409, which stripped `coa_revenue` from
   * the input on the same argument: the account is server-resolved from the
   * product, and the client reads it rather than authoring it.
   *
   * Sticky with the customer's — see `CreateOrderInput.tax_exempt`.
   */
  tax_exempt?: boolean;
  /**
   * The ORIGIN axis. `null`/absent means the `default: true` store — so this is
   * additive for every existing caller. See {@link Invoice.uid_store}.
   */
  uid_store?: string | null;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  notes?: string | null;
}

/** Input schema for creating an invoice. */
export const CreateInvoiceInput: z.ZodType<CreateInvoiceInputType> = z.object({
  uid: FirestoreId,
  query_by_orders: z.array(z.string()).min(
    1,
    "At least one source order is required",
  ),
  organization: z.object({ uid: FirestoreId }),
  tax_exempt: z.boolean().optional(),
  uid_store: FirestoreId.nullable().optional(),
  items: z.array(InvoiceItemInputSchema).optional(),
  destinations: z.array(InvoiceDocDestination).optional(),
  date: chicagoStartOfDay().optional(),
  due_date: chicagoStartOfDay().optional(),
  subject: z.string().optional(),
  // Bounded at the stored maximum (core#102); `Invoice.reference` is `.max(255)`.
  reference: z.string().max(255).nullable().optional(),
  // ⚠️ `.nullable()`, not merely `.optional()` — api-cloudrun#492's shape, one
  // schema over. The STORED arm is bare `.nullable()`, so
  // `getInitialValues(InvoiceSchema)` seeds this as `null`, and the manager
  // drafts an invoice by projecting that seed straight back through this input.
  // Accepting only `undefined` therefore 400s on a payload the system itself
  // produced — `expected string, received null` — making invoice drafting
  // unreachable from the manager's own flow.
  //
  // Widening what the BOUNDARY accepts and nothing downstream: every reader
  // already treats `null` and absent identically, and a widening cannot break an
  // older client because it never rejects what was previously valid.
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
});

/** Input schema for PUT /invoices/:uid — partial update. */
export interface UpdateInvoiceInputType {
  status?: InvoiceStatusType;
  /**
   * The EXEMPTION axis. Absent = leave unchanged; `false` = this invoice
   * asserts none. No `null` arm, for the reason on `UpdateOrderInput`.
   *
   * ⚠️ There is deliberately no `tax_profile` here, and there is none on
   * {@link CreateInvoiceInputType} either any more — an invoice's profile was
   * never editable after create, and it stopped being writable at all at
   * api-cloudrun#596 item 2.
   */
  tax_exempt?: boolean;
  /**
   * The ORIGIN axis. Absent = leave unchanged; `null` = fall back to the
   * `default: true` store. See {@link Invoice.uid_store}.
   */
  uid_store?: string | null;
  items?: InvoiceItemInputType[];
  /**
   * The JURISDICTION axis, per destination pair — **and only that.** The
   * consumer reads `destinations[i].jurisdiction` off each pair, matched by
   * `(uid_order, uid)`, and ignores every other field: the rest of a pair is
   * projected from its source order and is not the invoice's to state.
   *
   * ⚠️ **`uid` is therefore REQUIRED on every pair a caller sends, and it is the
   * pair's own identity — its destination divider's uid, not `delivery.uid`.**
   * The match was on the two ENDPOINT uids until api-cloudrun#663, which made
   * this arm unusable for its main purpose: correcting a pair's address changed
   * the very key the correction was addressed by, so the edit landed on nothing.
   * A caller echoing the stored pair back gets this right for free.
   *
   * ⚠️ **Present-vs-absent and `null` are different verbs.** An absent
   * `jurisdiction` key preserves the stored one; an explicit `null` CLEARS the
   * override so the pair falls back to the customer's claim and then the
   * derivation. Same shape as `due_date` below, for the same reason.
   *
   * ⚠️ This field was declared and **silently discarded** by
   * `api-cloudrun/src/services/invoices.ts` until api-cloudrun#630 — a wrong
   * jurisdiction on an invoice could not be corrected by any call.
   */
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  /**
   * Explicit `null` **clears** the due date; an absent key preserves it.
   *
   * The null arm exists on the UPDATE input only, and that asymmetry is the
   * point: it is a wire-level clear VERB, not a storable value. {@link Invoice}
   * keeps `due_date` plainly `.optional()` and a cleared invoice simply loses
   * both `due_date` and `due_date_fs` — which is already a reachable document
   * shape, because `createInvoice` writes neither key when no due date is
   * supplied. {@link CreateInvoiceInputType} takes no null for the same reason:
   * omitting the field is how you create an invoice without a due date.
   *
   * ⚠️ **Whoever consumes this must clear the `_fs` MIRROR too.** `null !==
   * undefined`, `new Date(null)` is the epoch, and `Timestamp.fromDate` accepts
   * it — so a naive `if (input.due_date !== undefined)` arm stamps
   * `due_date_fs = 1970-01-01` into the field `serverSortVia` sorts on, with no
   * error anywhere. Guarded in `api-cloudrun/src/services/invoices.ts`.
   *
   * Origin: chicago-film-supplies/manager#326 — clearing the control wrote `""`,
   * which fails `chicagoStartOfDay()`, so the store aborted before any request
   * and the field showed an error indicator with no message.
   */
  due_date?: string | null;
  subject?: string;
  reference?: string | null;
  notes?: string | null;
  version: number;
}

/** Input schema for updating an invoice. */
export const UpdateInvoiceInput: z.ZodType<UpdateInvoiceInputType> = z.object({
  status: InvoiceStatus.optional(),
  tax_exempt: z.boolean().optional(),
  uid_store: FirestoreId.nullable().optional(),
  items: z.array(InvoiceItemInputSchema).optional(),
  destinations: z.array(InvoiceDocDestination).optional(),
  date: chicagoStartOfDay().optional(),
  // `.nullish()`, not `.optional()` — null is the clear verb. See the interface.
  // `""` stays rejected, which is what manager#326 needs: an empty control must
  // send null, not an empty string.
  due_date: chicagoStartOfDay().nullish(),
  subject: z.string().optional(),
  // Bounded at the stored maximum (core#102); `Invoice.reference` is `.max(255)`.
  reference: z.string().max(255).nullable().optional(),
  // ⚠️ `.nullable()`, not merely `.optional()` — api-cloudrun#492's shape, one
  // schema over. The STORED arm is bare `.nullable()`, so
  // `getInitialValues(InvoiceSchema)` seeds this as `null`, and the manager
  // drafts an invoice by projecting that seed straight back through this input.
  // Accepting only `undefined` therefore 400s on a payload the system itself
  // produced — `expected string, received null` — making invoice drafting
  // unreachable from the manager's own flow.
  //
  // Widening what the BOUNDARY accepts and nothing downstream: every reader
  // already treats `null` and absent identically, and a widening cannot break an
  // older client because it never rejects what was previously valid.
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  version: z.int().min(0),
});
