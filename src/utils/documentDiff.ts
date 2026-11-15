/**
 * **Document diffs** — where an order, its fulfillment and its invoices differ
 * from each other, computed from the documents alone (manager#467).
 *
 * Every detail view shows the other two documents' differences: the order view
 * shows the fulfillment and the invoices, the invoice view shows the order and
 * the fulfillment, the fulfillment view shows the order and the invoices. This
 * is the ONE author of that answer, so the three views cannot disagree with each
 * other, and the API can recompute it before a sync write.
 *
 * ⚠️ **Named *diff*, never *divergence*** — manager's store already uses that
 * word for unsaved local edits against the server snapshot.
 *
 * ## The join is `path`, through the ORDER's path space
 *
 * - **order ↔ fulfillment**: a fulfillment row's `path` IS its order line's path
 *   (`projectItem` copies it; measured on prod 2026-09-13, 10,033 of 10,034 rows).
 * - **order ↔ invoice**: an invoice line under order divider `O` has path
 *   `[O, ...orderPath]`.
 * - **invoice ↔ fulfillment**: both map into the order's path space, so they
 *   compare at the same order-relative key. There is no direct link.
 *
 * 🔴 **Never a product uid.** `item.uid` repeats within one document, so a line
 * present on only one side is simply *only here*; there is no fallback join
 * (`cfs-items` skill, invariant 4 — a cross-document view compares stored paths
 * and never recomputes them).
 *
 * ## What is compared (owner ruling, 2026-09-16 — this REVERSED 2026-09-13)
 *
 * **Every field the two documents share, read off the two schemas.** The diff
 * walks the same key intersection the SYNC merges (`orderInvoiceSharedFields`),
 * so a new shared field is compared by construction and the two can never
 * disagree about what "overridden" means.
 *
 * ⚠️ **The rule it replaced was "money, quantity and dates only", and it was not
 * arbitrary** — comparing labels put rows on hundreds of settled prod invoices
 * whose catalog names moved after invoicing. That cost is accepted: label rows
 * return. What is NOT acceptable is a hand-maintained list of compared fields,
 * because a field absent from it was invisible to every diff view with nothing
 * saying so, and the list could drift from the sync's own answer.
 *
 * 🔴 **The exchange is not one-for-one: DERIVED money is now compared NOWHERE.**
 * An invoice is repriced in its own context — its jurisdiction, its tax date —
 * so `subtotal_cents`, `total_cents`, `taxes`, `taxes_base` and a discount's
 * `amount_cents` can differ from the order's with no operator edit and no
 * quantity split. Reporting that is G2, the false override this whole campaign
 * exists to delete, and the suppression is therefore unconditional. A real
 * change still reports through its CAUSE — a declared input (`rates`,
 * `base_percent`), a discount's `rate`/`type`, a line's tax class — never
 * through its arithmetic. A price key is judged at the classification's LEAF
 * grain, so `price.discount.rate` and `price.discount.amount_cents` are told
 * apart (core#118).
 *
 * A fulfillment carries no price, so every comparison with a fulfillment is
 * quantity and existence only.
 *
 * **Destination pairs compare EVERY payload field** (owner decision, same day) —
 * addresses, contacts, collecting/returning flags, dates, jurisdiction. Only the
 * pair's identity (`uid`) and scope (`uid_order`) are skipped. An equality check
 * enumerates what it skips, never what it takes, so a new pair field is compared
 * by construction (the rule `pairsMatch` states). The one exception: a
 * comparison involving a fulfillment skips `jurisdiction`, a tax fact the
 * fulfillment carries read-only and does not own.
 *
 * ## A one-sided leg or kit reports ONCE
 *
 * A leg on only one of the order and the fulfillment is one pair-level
 * `not_on_source` / `only_on_source` entry, and the rows under it are not
 * listed again. The same holds one level down: a kit parent on one side only
 * reports once and its components are suppressed. An exchange leg is simply such a
 * pair — a reader tells it apart by the pair's own `exchange`, so there is no
 * dedicated kind. Between an order and an INVOICE, a leg the order owns is not
 * compared for presence: an invoice that DECLINED it (core#126) is aligned and
 * its lines are ordinary `quantity` entries at `invoiced: 0`, and one whose
 * skeleton is broken is reported once, in `unaligned`. A leg the INVOICE authored
 * (`invoiceAuthoredSubtrees`, core#124) is the one exception — the skeleton
 * match ignores it, so it reports here, once, like any one-sided leg. A group
 * the invoice authored reports its lines one by one (`not_on_source` /
 * `only_on_source`), the way any invoice-only line does.
 *
 * ## Quantity against invoices is judged on the SUM of invoices
 *
 * An order is routinely billed across several invoices, so "invoice A lacks this
 * line" says nothing when invoice B carries it, and "invoice A bills 3 of 5"
 * says nothing when invoice B bills the other 2. So:
 *
 * - **how many units each document states** is ONE `quantity` entry per line —
 *   ordered / fulfilled / invoiced, with the money not yet invoiced for the
 *   missing units and for a date extension — read off the per-line account
 *   (`accountInitiator` over `billedByPath`, `utils/quantityAccounting.ts`). A line no invoice carries is
 *   the same entry with `invoiced: 0`. See {@link DocumentQuantityEntry} for
 *   when it is emitted;
 * - **differences in a line's TERMS** — base price, discount rate, formula —
 *   stay per invoice, each invoice its own source row;
 * - **a line a SIBLING invoice carries** produces nothing on an invoice view;
 * - **a line an invoice carries that the order or fulfillment lacks** stays per
 *   invoice (`only_on_source` on the order/fulfillment view, `not_on_source` on
 *   the invoice view).
 *
 * **Exchange units are shown, never owed.** A line carrying `exchanged_for` goes to
 * the customer in place of a lost, damaged or dirty unit and bills at $0 unless
 * an operator prices it, so it never gets a `quantity` entry.
 *
 * **Lost and damaged records** (the optional `outOfService` source) are not
 * presence rows. An invoice line carrying `out_of_service` is skipped by
 * the line comparison, and each record gets its own `quantity` entry at the
 * row that owns its booking: `fulfilled` is its billable units, `invoiced` what
 * its replacement lines bill.
 *
 * Initiator ↔ billing line differences, on both sides, come from ONE comparer
 * ({@link billingLineFields}, one-document-model F10): the shared fields the
 * side's sync merges, minus `derived`, `homonym` and the account's fields. It
 * replaced an order ↔ invoice comparer built on the invoice sync badge's
 * `invoiceItemDifferences` + `explainInvoiceItemDifferences` and a separate
 * purchase ↔ bill one. The badge's explanation arms cover only `derived`
 * fields, which this never reports, so it still cannot report a difference the
 * badge explains away. Census 2026-11-15: no stored document's field entries
 * moved, in prod, dev or `test`.
 *
 * ## A substitution is ONE difference, never a pair of presence entries
 *
 * A picker or an invoice can carry Y in place of the order's X
 * (a `substituted_for` entry names X's order path). Reported by presence alone,
 * that is X `not_on_source` + Y `only_on_source` (+ X not invoiced) — two or
 * three unrelated-looking rows for one substitution. Instead:
 *
 * - **the document without the substitute** gets one `substituted` entry at X,
 *   and neither X's absence, Y's presence nor either subtree's is reported;
 * - **the document with the substitute** gets one `substituted` entry at Y, and
 *   Y's components (which exist on no order line) are not reported;
 * - **against invoices**, an aligned invoice that substituted X covers X, so X
 *   is invoiced.
 *
 * Only when the other side carries X. A Y whose X is on neither document is an
 * ordinary presence difference, and is reported as one.
 *
 * ## Lifecycle: void invoices are not compared, and a canceled order is not billed
 *
 * - **A `void` invoice is dropped before anything is compared**: it bills
 *   nothing, covers nothing, and produces no line, pair or unaligned entry —
 *   the same rule `computeOrderInvoiceCoverage` follows. Viewing a void invoice
 *   therefore yields an empty map; the caller says so rather than showing a
 *   clean table.
 * - **A canceled order is not compared against its invoices** — no line
 *   differences, no `quantity` entries. There is nothing left to bill, and every
 *   line of a live invoice still matches the order's items, so a per-line
 *   comparison would read as in sync. Instead each live invoice on it is ONE
 *   `live_invoice_on_canceled_order` entry in `status`, from whichever side is
 *   viewed. (A canceled order with only void invoices is consistent: nothing.)
 *
 * Pure: no reads. A source the caller did not pass (no permission, not loaded)
 * yields no entries — never an "in sync" answer.
 */
import type {
  Purchase,
  PurchaseBill,
  PurchaseCredit,
  PurchaseDocumentItem,
  PurchaseItem,
  Side,
  DocDestinationType,
  Fulfillment,
  FulfillmentItemType,
  Invoice,
  InvoiceDocDestinationType,
  InvoiceDocItemType,
  Order,
  OrderDocItemType,
} from "../schemas/mod.ts";
import {
  billsOutOfService,
  deriveQueryByPurchases,
  exchangedForKey,
  exchangedForOf,
  isDividerItemType,
  isFulfillableItemType,
  purchaseCreditPurchaseUid,
} from "../schemas/mod.ts";
import {
  canonicalizePayload,
  extensionSectionTargets,
  type InvoiceItem,
  invoiceAuthoredSubtrees,
  isInExtensionSection,
  isInInvoiceAuthoredSubtree,
  orderInvoiceSharedFields,
  orderLineClaims,
  projectOrderItemToInvoiceItem,
} from "./invoices.ts";
import type { LineItem } from "./orders.ts";
import {
  projectPurchaseLineForBill,
  purchaseBillSharedDocFields,
  purchaseBillSharedLineFields,
} from "./purchase-documents.ts";
import { formulaMoneyMismatch } from "../schemas/_line-money.ts";
import type { PurchaseLineCustody } from "./bookings-inbound.ts";
import type { PricingFormulas } from "./price-document.ts";
import {
  collectSubstitutionAnchors,
  isAtOrBelow,
  isInSubstitutedSubtree,
  isRemovedBySubstitution,
  type MaybeSubstitution,
  type ExchangeEntry,
  standInUnits,
  type SubstitutionAnchor,
} from "./substitutions.ts";
import {
  accountInitiator,
  type AccountedCreditNote,
  type AccountedCreditNoteItem,
  type AccountedInitiator,
  BILLING_FOLD,
  type BilledByPath,
  billedByPath,
  type CustodyOnlyAccount,
  type CustodyRow,
  type DocumentDiffOutOfService,
  fulfillmentCustody,
  type InitiatorAccount,
  type LineAccount,
  orderOutOfServiceInputs,
  type OutOfServiceInput,
  purchaseCustody,
  substitutionCredit,
} from "./quantityAccounting.ts";
import { orderFulfillmentSharedFields, type SharedField } from "./shared-fields.ts";

/** The three document kinds a diff can be viewed from or sourced from. */
export type DocumentKind = "order" | "fulfillment" | "invoice" | "purchase" | "bill" | "credit_note" | "purchase_credit";

/** The kinds a diff can be VIEWED from. A credit document is a source of netting, never a view. */
export type DocumentViewKind = Exclude<DocumentKind, "credit_note" | "purchase_credit">;

/** Which document a diff entry is against — enough to link to it and to CAS a later sync. */
export interface DocumentRef {
  kind: DocumentKind;
  uid: string;
  number: number;
  version: number;
}

/**
 * What one source says about one key of the viewed document.
 *
 * - `differs` — the same path on both sides, a compared field disagrees
 * - `not_on_source` — on the viewed document, absent from the source
 * - `only_on_source` — on the source, absent from the viewed document
 * - `pair_field` — a destination pair's compared field disagrees
 * - `doc_field` — a DOCUMENT-level shared field disagrees (organization, subject,
 *   reference, `tax_exempt`, `uid_store`) — not a row, so it is filed on its own
 *
 * The two presence kinds are named for the sentence the UI reads them as
 * ("not on the fulfillment", "only on the invoice"). They were `only_here` /
 * `missing_here` until core#118.
 */
export interface DocumentSourceDiffEntry {
  kind: "differs" | "not_on_source" | "only_on_source" | "pair_field" | "doc_field";
  source: DocumentRef;
  /** Empty for `not_on_source` / `only_on_source`. */
  fields: DocumentDiffField[];
}

/** One compared field. `here` is the viewed document's value, `there` the source's. */
export interface DocumentDiffField {
  field: string;
  here: unknown;
  there: unknown;
}

/**
 * A substitution between the viewed document and one source. Filed at
 * whichever of the two lines the viewed document carries — `replaced` on the
 * side without the substitute, `substitute` on the side with it — so the entry always
 * lands on a row. The other key names the source's line.
 *
 * Both keys are in the VIEWED document's path space, like every map key.
 */
export interface DocumentSubstitutionEntry {
  kind: "substituted";
  source: DocumentRef;
  /** X — the line the substitution replaced. */
  replaced: string;
  /** Y — the line carried in its place. */
  substitute: string;
}

/**
 * An invoice row that bills an order line from ANOTHER position (core#125): an
 * operator dragged it into another group or destination of its order block, or
 * split units off into a new group, and the row's `path_order_item` names the
 * order line it is. One difference, never `not_on_source` at the row plus an
 * unbilled order line.
 *
 * Filed at whichever of the two the viewed document carries — at the row on
 * the invoice view, at the order line on the order and fulfillment views. Both
 * keys are in the VIEWED document's path space, like every map key.
 *
 * `fields` are the row's TERMS against the order line's, compared exactly as a
 * same-path line's would be (empty against a fulfillment, which carries no
 * terms). How many units are billed is the `quantity` entry's, summed over every
 * row claiming the line — several may, and the line may also stay at its own
 * path (a split).
 */
export interface DocumentMovedEntry {
  kind: "moved";
  source: DocumentRef;
  /** The invoice row, where it sits. */
  row: string;
  /** The order line it bills. */
  order_line: string;
  fields: DocumentDiffField[];
}

/**
 * How many units the three documents each state at one line — **ordered**,
 * **fulfilled**, **invoiced**, in the documents' own words — emitted when they
 * disagree (core#118).
 *
 * It replaced three kinds that each carried one pair of the three numbers:
 * `billed` (ordered vs invoiced), `fulfilled` (fulfilled vs invoiced) and
 * `uninvoiced` (invoiced is zero). Three entries on one row could state one
 * fact twice, and a reader had to join them to see the row.
 *
 * 🔴 **The three are MEANT to disagree, and the entry picks no winner.** The
 * order is the quote, the fulfillment is what happened, the invoice is what is
 * billed; all three are mutable. An invoice billing exactly what was quoted
 * while a unit more went out the door is aligned with the order and not with
 * reality, and the operator needs both facts to decide.
 *
 * Emitted only when at least one ALIGNED invoice for the order was passed: an
 * order not yet invoiced is not flagged line by line, and an unaligned invoice
 * cannot vouch for or against any line. Then it is emitted when invoiced
 * differs from ordered, when the order's window adds days to units already
 * invoiced, or when fulfilled differs from BOTH of the others. The last clause
 * is deliberately narrow: fulfilled agreeing with ordered adds nothing the
 * ordered-vs-invoiced half does not already say.
 *
 * Summed across invoices: an order is routinely billed across several, so
 * "this invoice bills 3 of 5" says nothing when a sibling bills the other 2.
 * The invoice view therefore needs the sibling invoices passed in
 * (`order.invoices`); without them a line billed on a sibling reads as not
 * invoiced.
 *
 * ⚠️ Advisory. Nothing refuses a write on it.
 */
export interface DocumentQuantityEntry {
  kind: "quantity";
  /** Every aligned, non-void invoice the sum was taken over. */
  invoices: DocumentRef[];
  /**
   * The order line's quantity. `null` where no order line is at this key — a
   * row the fulfillment carries on its own, or a lost/damaged record.
   */
  ordered: number | null;
  /**
   * The fulfillment row's quantity; for a lost/damaged record, its billable
   * units (`quantity − returned_to_service`, or 0 once canceled). `null` where
   * no fulfillment was passed, no row is at this key, or a substitution
   * explains the row (the `substituted` entry is that row's answer).
   */
  fulfilled: number | null;
  /**
   * Units the invoices bill, substitutes counted toward the line they replaced.
   * For a lost/damaged record: what its `replacement` lines bill.
   */
  invoiced: number;
  /**
   * Pre-tax cents for the `ordered − invoiced` units at the order line's
   * current terms. Signed: negative is over-invoicing. `null` with no order line.
   */
  quantity_cents: number | null;
  /** Pre-tax cents the order's current window adds to units already invoiced. `null` with no order line. */
  extension_cents: number | null;
  /**
   * Pre-tax cents for the `fulfilled − invoiced` units, at the ORDER line's
   * current terms. `null` when either the order line or the fulfilled figure is.
   */
  fulfilled_quantity_cents: number | null;
  /**
   * A live CRMS-authored invoice bills this order, so
   * `buildOverbillingCredits` refuses it and this entry's NEGATIVE money has no
   * remedy behind it (api-cloudrun#1028 gap 7).
   *
   * 🔴 **Stated here rather than left to each reader.** Deciding it needs the
   * billing invoices' `crms_id`, which `invoices` above does not carry — a
   * `DocumentRef` is `{kind, uid, number, version}`. Every reader would derive
   * the same value from the same inputs, which is the definition of a fact the
   * writer should state.
   *
   * ⚠️ **ANY live CRMS invoice, not all of them** — `buildOverbillingCredits`'
   * own refusal condition. The two must agree, or the copy and the offer refuse
   * differently on a MIXED order.
   */
  crms_blocked: boolean;
  /**
   * Set when this entry is a lost/damaged RECORD's, filed at the row that owns
   * its booking; `null` for an order line's. A row can carry both.
   */
  uid_out_of_service: string | null;
  /**
   * On a STATED line only (its money is `price.stated_cents`), on both sides:
   * what the billing documents bill for it, net of reversing credits and
   * unfloored, and what the billed units should cost at the line's stated money
   * (ruling 39). Absent on a rate line, whose money is {@link quantity_cents}.
   */
  billed_cents?: number;
  expected_cents?: number;
  /**
   * The live credit documents whose reversing rows took something back at this
   * line, on both sides (a credit note, a supplier credit). Empty on a
   * custody-only row and a lost/damaged record's entry.
   */
  credit_sources: DocumentRef[];
}

/** One entry at one key of the viewed document. Discriminated on `kind`. */
export type DocumentDiffEntry =
  | DocumentSourceDiffEntry
  | DocumentSubstitutionEntry
  | DocumentMovedEntry
  | DocumentQuantityEntry;

/**
 * Every entry kind, read off the entries rather than listed beside them. The
 * hand-kept list this replaced had already lost `fulfilled`.
 */
export type DocumentDiffKind = DocumentDiffEntry["kind"];

/**
 * The answer for one viewed document.
 *
 * Keys are `path.join("/")` in the VIEWED document's own path space, so a row
 * looks itself up by its own stored path: an invoice line's key carries its
 * order-divider prefix, an order or fulfillment line's does not. A destination
 * pair is keyed by its destination divider's path key, in the same space.
 */
export interface DocumentDiffMap {
  lines: Map<string, DocumentDiffEntry[]>;
  pairs: Map<string, DocumentDiffEntry[]>;
  /**
   * Invoice scopes whose divider structure does not match the order's, so no
   * per-line comparison is meaningful. One entry per (scope, source) rather than
   * a row per line. `scope` is the order divider uid.
   */
  unaligned: Array<{ scope: string; source: DocumentRef }>;
  /**
   * Lifecycle mismatches between the viewed document and a source — a live
   * invoice on a canceled order. One entry per (document, source) pair, never a
   * row per line: every line may still match. `source` is the invoice on the
   * order and fulfillment views, and the order on the invoice view.
   */
  status: Array<{ issue: DocumentStatusIssue; source: DocumentRef }>;
  /**
   * Document-level differences — one `doc_field` entry per source (G13).
   *
   * These belong to the DOCUMENT rather than to any row, so they are a flat list
   * rather than a keyed map: `organization`, `subject`, `reference`,
   * `tax_exempt` and `uid_store` have no path to be filed under, and before this
   * an invoice whose organization had been overridden showed nothing anywhere.
   *
   * The compared set is the doc-level shared-field classification, filtered to
   * `propagated` and `atom`. `homonym` fields are excluded because the key means
   * different things on the two documents (an order's `xero_id` is its QUOTE,
   * an invoice's is its INVOICE), and `derived` because nothing authors it by
   * hand — the same two exclusions the merge makes, from the same source.
   */
  doc: DocumentDiffEntry[];
  /**
   * Lost/damaged records whose booking no row on the order or its fulfillment
   * books — a `quantity` entry with nowhere to be filed. Listed rather than
   * dropped, so a record the documents disagree about is never invisible.
   */
  unplaced_out_of_service: DocumentQuantityEntry[];
  /**
   * Every issued or applied credit note line, filed at the row it credits —
   * keyed like {@link lines}, in the VIEWED document's path space.
   *
   * 🔴 **An annotation, not an entry, and not a ninth kind.** It is filed even
   * where {@link lines} has nothing: a REVERSING note nets in the billing fold,
   * which is exactly what clears the `quantity` entry, and the operator still
   * needs to see which note did it. A NON-reversing note is money given back,
   * not a statement that units were unbilled (`CreditNoteDocLineItem.reverses_billing`),
   * so it is shown here and never netted — `invoiced` stays gross of it.
   *
   * On the invoice view: that invoice's own rows. On the order and fulfillment
   * views: every invoice scoping the order, at the order-relative key the row
   * bills (a moved row's at the order line it claims). Quantity and identity
   * only — no derived money, the same rule as every entry here.
   */
  credits: Map<string, DocumentCredit[]>;
  /**
   * Credit notes relevant to the viewed document that name no row this can key:
   * no `path_invoice_item` and a `uid_invoice_item` that is not unique on its
   * invoice (or no invoice passed to resolve it against), or not exactly one
   * `invoices` source. Listed rather than dropped, like
   * {@link unplaced_out_of_service} — "no credit shown" must never read as "no credit".
   */
  unkeyed_credit_notes: DocumentUnkeyedCredit[];
}

/** One credit note's credit against one invoice row. @see {@link DocumentDiffMap.credits} */
export interface DocumentCredit {
  uid_credit_note: string;
  number: number;
  /** The invoice the note was raised on — the row's document. */
  uid_invoice: string;
  /** Units the note credits at this row, summed over its lines there. */
  quantity: number;
  /**
   * True when every line of the note at this row reverses billing, i.e. it was
   * netted out of `invoiced`. False means shown and NOT netted.
   */
  reverses_billing: boolean;
  /**
   * Whether the credited row bills an ORDER line at all. `false` for a row in an
   * invoice-authored subtree ({@link invoiceAuthoredSubtrees}) — a group the
   * invoice added, or kept after the order deleted it — which the billing fold
   * never counts against an order line, so netting has nothing to apply to and "not netted" says
   * nothing. `null` when the order was not passed and the question is open.
   */
  bills_order_line: boolean | null;
}

/** A credit note no row could be found for. @see {@link DocumentDiffMap.unkeyed_credit_notes} */
export interface DocumentUnkeyedCredit {
  uid_credit_note: string;
  number: number;
  /** `null` when the note does not name exactly one invoice. */
  uid_invoice: string | null;
}

/** One credit note line, as the diff reads it. */
export interface DocumentDiffCreditNoteItem extends AccountedCreditNoteItem {
  /**
   * The legacy key, read only when `path_invoice_item` is absent — and then only
   * when this uid is on exactly ONE line of the invoice, because `item.uid`
   * repeats within a document (`cfs-items` invariant 4).
   */
  uid_invoice_item: string | null;
}

/** A credit note as the diff reads it: the accounting shape plus its number. */
export interface DocumentDiffCreditNote extends AccountedCreditNote {
  number: number;
  items: readonly DocumentDiffCreditNoteItem[];
}

/** A lifecycle mismatch no per-line comparison can show. */
export type DocumentStatusIssue = "live_invoice_on_canceled_order";

/** Documents the caller holds. Any may be absent or partial. */
export interface DocumentDiffSources {
  orders?: readonly Order[];
  fulfillments?: readonly Fulfillment[];
  invoices?: readonly Invoice[];
  /**
   * The orders' `out-of-service` records (`query_by_sources` array-contains
   * `orders:<uid>`). Only lost and damaged ones are compared. Absent ⇒ no
   * record is compared, and nothing says so (a source the caller could not
   * read is silent by design).
   */
  outOfService?: readonly DocumentDiffOutOfService[];
  /**
   * Credit notes raised on the invoices passed (`query_by_sources`
   * array-contains-any `invoices:<uid>`). REVERSING lines net out of
   * `invoiced` exactly as `createOrderInvoiceCoverage` nets them, so the diff
   * and the coverage menu agree; every issued/applied line is annotated in
   * {@link DocumentDiffMap.credits}. Absent ⇒ nothing nets and nothing is
   * annotated, silent by design like {@link outOfService}.
   */
  creditNotes?: readonly DocumentDiffCreditNote[];
  /** The payable initiators. A bill view needs each purchase it bills. */
  purchases?: readonly Purchase[];
  /** Every bill of the purchases, voided ones included: sibling bills are what "billed" sums over. */
  bills?: readonly PurchaseBill[];
  /** Their supplier credits; a live credit nets out of `invoiced`. */
  purchaseCredits?: readonly PurchaseCredit[];
  /**
   * Each purchase's row custody, keyed by purchase uid: `custodyBySourceItem`
   * over that purchase's movements (one-document-model C8 — the line no longer
   * carries `quantity_received`). It fills a payable entry's `fulfilled`, which
   * is stated and never a trigger. Absent ⇒ `fulfilled: null`, unknown rather
   * than a wrong 0.
   */
  purchaseCustody?: ReadonlyMap<string, ReadonlyMap<string, PurchaseLineCustody>>;
}

/**
 * What the diff needs beyond the documents: every formula their lines name and
 * the holiday list, what an extension's counts are metered with (ruling 8: a
 * window stores no count).
 *
 * ⚠️ It carried `taxNameByUid` and `isOrderFrozen` until the one field comparer
 * (one-document-model F10): they fed the invoice sync badge's explanation arms,
 * which could never change the diff's output (every field they cover is
 * `derived`) and are no longer called from it.
 */
export interface DocumentDiffContext {
  formulas: PricingFormulas;
  holidays: readonly string[];
}

/** The pair keys a comparison is addressed BY, never part of what it compares. */
const PAIR_IDENTITY_FIELDS: ReadonlySet<string> = new Set(["uid", "uid_order", "uid_purchase"]);

/**
 * Pair fields a FULFILLMENT does not own, skipped whenever one is on either side.
 *
 * `jurisdiction` is a tax fact: it prices lines, and a fulfillment carries no
 * price. The fulfillment stores it only because `destinations[]` is projected
 * whole from the order; it is server-managed and read-only there. A mismatch
 * (16 prod pairs on 2026-09-13) is therefore not a difference a fulfillment can
 * have an opinion about (owner ruling, 2026-09-13).
 */
const FULFILLMENT_UNOWNED_PAIR_FIELDS: ReadonlySet<string> = new Set(["jurisdiction"]);

const key = (path: readonly string[]): string => path.join("/");

/** Read a dotted field off an item; `price.x` reads through `price`. */
function readField(item: unknown, field: string): unknown {
  let cur: unknown = item;
  for (const seg of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur ?? null;
}

function refOf(kind: DocumentKind, doc: { uid: string; number: number; version?: number }): DocumentRef {
  return { kind, uid: doc.uid, number: doc.number, version: doc.version ?? 0 };
}

/** A document's line items in ONE order's relative path space, keyed by that path. */
interface ScopedLines {
  byKey: Map<string, LineItem>;
  anchors: SubstitutionAnchor[];
  /** An invoice's moved rows: row key → the order-relative key it bills (`orderLineClaims`). Empty elsewhere. */
  claims: Map<string, string>;
}


function scopeFulfillment(fulfillment: Fulfillment): ScopedLines {
  const byKey = new Map<string, LineItem>();
  for (const it of fulfillment.items as readonly FulfillmentItemType[]) {
    if (isDividerItemType(it.type)) continue;
    byKey.set(key(it.path), it as unknown as LineItem);
  }
  return { byKey, anchors: collectSubstitutionAnchors(fulfillment.items as readonly FulfillmentItemType[]), claims: new Map() };
}


/** The order uids an invoice carries a scope for. */
function invoiceScopes(invoice: Invoice): string[] {
  return (invoice.items as readonly InvoiceDocItemType[])
    .filter((it) => it.type === "order")
    .map((it) => it.uid);
}

/** The role a document plays in a comparison (ruling 29's roles; credits are never compared here). */
type DiffRole = "initiator" | "custody" | "billing";

/**
 * One document in a comparison: its KIND (for a {@link DocumentRef} only), and
 * its role and side, which are all the comparison reads (ruling 33).
 */
type DiffSide = {
  kind: DocumentKind;
  role: DiffRole;
  side: Side;
  doc: Order | Fulfillment | Invoice | Purchase | PurchaseBill;
  lines: ScopedLines;
};

/** What a document IS, whichever side it sits on: the comparison reads this, never the collection. */
const isBilling = (side: DiffSide): boolean => side.role === "billing";
const isInitiator = (side: DiffSide): boolean => side.role === "initiator";
const isCustody = (side: DiffSide): boolean => side.role === "custody";

/** Only fulfillable lines take part in a comparison that involves a custody document. */
function comparable(side: DiffSide, other: DiffSide, item: LineItem): boolean {
  const involvesCustody = isCustody(side) || isCustody(other);
  return !involvesCustody || isFulfillableItemType(item.type);
}

/** The compared fields two same-path lines disagree on. `here` belongs to `viewed`. */
function lineFields(
  viewed: DiffSide,
  source: DiffSide,
  here: LineItem,
  there: LineItem,
  initiatorUid: string,
  expectedFulfillmentQuantity?: number,
): DocumentDiffField[] {
  const involvesCustody = isCustody(viewed) || isCustody(source);
  // Custody ↔ billing quantity is the `quantity` entry's, over every billing document.
  if (involvesCustody && (isBilling(viewed) || isBilling(source))) return [];
  if (!involvesCustody) {
    // Initiator ↔ billing: one comparer, computed billing-first, oriented by the view.
    const viewingBilling = isBilling(viewed);
    const billing = viewingBilling ? viewed : source;
    const fields = billingLineFields(
      billing.side,
      viewingBilling ? there : here,
      viewingBilling ? here : there,
      billing.doc as DiffBilling,
      initiatorUid,
    );
    return viewingBilling ? fields : fields.map((f) => ({ field: f.field, here: f.there, there: f.here }));
  }
  // D2: a custody row is the initiator's quantity, less what substitutes took
  // from it, plus what it stands in for (manager#414).
  const fulfillmentQuantity = (isCustody(viewed) ? here : there).quantity ?? 0;
  const orderQuantity = (isInitiator(viewed) ? here : there).quantity ?? 0;
  const expected = expectedFulfillmentQuantity ?? orderQuantity;
  const fields: DocumentDiffField[] = fulfillmentQuantity === expected
    ? []
    : [{ field: "quantity", here: here.quantity ?? null, there: there.quantity ?? null }];
  // An exchange unit's `exchanged_for` is shared whole with the fulfillment
  // (`shared: "value"`), so a picker can re-aim it (manager#537).
  if (exchangedForDiffers(here, there)) {
    fields.push({ field: "exchanged_for", here: exchangedForOfLine(here), there: exchangedForOfLine(there) });
  }
  return fields;
}

/**
 * The fields the per-line ACCOUNT reports (ruling 92): how many units a row
 * bills, and the money of a part of a stated line. A billing row routinely
 * carries a different count or a part's money from its initiator line, and the
 * one `quantity` entry, summed over every billing document, is where that is
 * judged. Side-blind: a path the side's classification lacks never occurs (an
 * order line has neither money key).
 *
 * ⚠️ `amount_cents` is `propagated` in the payable `flat_money` group, not
 * `derived` (`schemas/purchase.ts`): the sync merges the group as one unit and
 * a linked line's amount is Xero's. So naming it here is load-bearing. It is
 * also why one field list per side reproduces the sync's per-LINE list, which
 * leaves `amount_cents` out on a time line: the comparer skips it on every line.
 */
const ACCOUNT_LINE_FIELDS: ReadonlySet<string> = new Set(["quantity", "amount_cents", "price.stated_cents"]);

/**
 * **The one comparer between an initiator line and the billing row that bills
 * it, on both sides** (ruling 33). `here` is the billing row's value, `there`
 * the initiator line's, projected into the billing row's shape by the side's
 * `projectLine`.
 *
 * The rule, written once:
 * - walk the shared line fields the side's SYNC merges, so a new shared field is
 *   compared by construction and the diff and the sync agree about what
 *   "overridden" means;
 * - skip `derived` (G2: a billing document reprices in its own context, so its
 *   derived money differs with no operator edit; a real change reports through
 *   its CAUSE — a rate, a discount's `rate`/`type`, a tax class), `homonym`
 *   (the same key meaning different things) and {@link ACCOUNT_LINE_FIELDS};
 * - compare at the leaf, or at its nearest ancestor that is not an object on
 *   both sides: a discount added or removed is one operator decision, not a
 *   list of leaf changes (core#118);
 * - compare an `atom` over the keys both schemas declare (`SharedField.keys`),
 *   as {@link compareDocFields} does;
 * - compare canonically, absent ≡ null, and report `null`, never `undefined`;
 * - append the side's own-money check (ruling 33's second domain fact).
 *
 * It ignores `shared_group` deliberately, a named difference from the merge:
 * the payable `flat_money` group's `out_of_service` IS compared (the projection
 * fits it to the row's quantity, so only a row naming different records
 * reports), while `quantity` and the money are the account's.
 */
function billingLineFields(
  side: Side,
  initiatorLine: LineItem,
  billingLine: LineItem,
  billingDoc: DiffBilling,
  initiatorUid: string,
): DocumentDiffField[] {
  const data = DIFF_SIDES[side].line;
  const there = data.projectLine(initiatorLine, billingLine, initiatorUid);
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  const out: DocumentDiffField[] = [];
  const seen = new Set<string>();
  for (const f of data.sharedLineFields()) {
    if (f.kind === "derived" || f.kind === "homonym" || ACCOUNT_LINE_FIELDS.has(f.path)) continue;
    const segs = f.path.split(".");
    let unit = f.path;
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join(".");
      if (!isObj(readField(billingLine, parent)) || !isObj(readField(there, parent))) {
        unit = parent;
        break;
      }
    }
    if (seen.has(unit)) continue;
    seen.add(unit);
    const shape = unit === f.path ? f : undefined;
    const h = pickSharedKeys(readField(billingLine, unit) ?? null, shape);
    const t = pickSharedKeys(readField(there, unit) ?? null, shape);
    if (JSON.stringify(canonicalizePayload(h)) !== JSON.stringify(canonicalizePayload(t))) {
      out.push({ field: unit, here: h, there: t });
    }
  }
  return [...out, ...data.ownMoney(billingLine, billingDoc)];
}

/** A line's `exchanged_for` entries, with absent read as none. */
function exchangedForOfLine(item: LineItem): ExchangeEntry[] {
  return [...exchangedForOf(item as { exchanged_for?: readonly ExchangeEntry[] })];
}

/**
 * Whether two lines' `exchanged_for` differ as MULTISETS keyed by
 * `exchangedForKey` — the identity `ExchangedForList` is unique by — with
 * the quantity compared per key. Order is not meaning, and absent equals `[]`.
 */
function exchangedForDiffers(a: LineItem, b: LineItem): boolean {
  const tally = (item: LineItem) => {
    const m = new Map<string, number>();
    for (const e of exchangedForOfLine(item)) {
      const k = exchangedForKey(e);
      m.set(k, (m.get(k) ?? 0) + e.quantity);
    }
    return m;
  };
  const x = tally(a);
  const y = tally(b);
  if (x.size !== y.size) return true;
  for (const [k, q] of x) if (y.get(k) !== q) return true;
  return false;
}

function push<K>(map: Map<K, DocumentDiffEntry[]>, k: K, entry: DocumentDiffEntry): void {
  const list = map.get(k);
  if (list) list.push(entry);
  else map.set(k, [entry]);
}

/**
 * The document-level fields to compare between two documents of one side, by
 * their ROLES, read off the shared-field classification rather than listed here
 * (G13).
 *
 * `null` means the pair has no direct document-level relationship. An invoice
 * and a fulfillment are both projections OF an order and have no link to each
 * other — comparing them would report every difference twice, once against the
 * order and once against each other, and there is no rule saying which of the
 * two should have followed the other.
 */
function docFieldsFor(a: DiffSide, b: DiffSide): readonly SharedField[] | null {
  const roles = new Set([a.role, b.role]);
  if (roles.size !== 2 || !roles.has("initiator")) return null;
  const fields = DIFF_SIDES[a.side].docFields;
  return roles.has("billing") ? fields.billing() : fields.custody();
}

/**
 * Document-level differences between the viewed document and one source.
 *
 * ⚠️ **`propagated` and `atom` only.** A `homonym` is the same key meaning
 * different things on the two documents — an order's `xero_id` is its Xero
 * QUOTE and an invoice's is its Xero INVOICE, and `status`, `number`, `version`
 * and the actor stamps are each the document's own — so comparing one reports a
 * difference that is not a difference. A `derived` field is recomputed in the
 * downstream document's own context and is the G2 class exactly, in the same way
 * derived line money is. Both exclusions come from the same classification the
 * merge consults, so the diff and the sync cannot disagree.
 *
 * An `atom` is compared WHOLE — it is a snapshot of another document, and
 * comparing it leaf by leaf would report a chimera as several small differences
 * rather than one moved reference. Whole over the keys BOTH schemas declare
 * (`SharedField.keys`), though: the order's organization snapshot carries
 * `crms_id` and `tax_exempt` and the fulfillment's carries `uid` and `path`
 * alone, so a raw comparison reported every fulfillment's organization as a
 * difference. The sync never had that defect because it projects the order
 * into the fulfillment's shape before merging; this is the same projection.
 */
function compareDocFields(out: DocumentDiffMap, viewed: DiffSide, source: DiffSide): void {
  const shared = docFieldsFor(viewed, source);
  if (shared === null) return;
  const sourceRef = refOf(source.kind, source.doc);
  // One entry per source, however many scopes reach the same pair.
  if (out.doc.some((e) => e.kind === "doc_field" && e.source.kind === sourceRef.kind && e.source.uid === sourceRef.uid)) return;

  const fields: DocumentDiffField[] = [];
  for (const f of shared) {
    if (f.kind !== "propagated" && f.kind !== "atom") continue;
    const here = pickSharedKeys(readField(viewed.doc, f.path), f);
    const there = pickSharedKeys(readField(source.doc, f.path), f);
    if (JSON.stringify(canonicalizePayload(here)) === JSON.stringify(canonicalizePayload(there))) continue;
    fields.push({ field: f.path, here, there });
  }
  if (fields.length > 0) out.doc.push({ kind: "doc_field", source: sourceRef, fields });
}

/** An `atom` restricted to the keys both documents declare; any other value unchanged. */
function pickSharedKeys(value: unknown, field: SharedField | undefined): unknown {
  if (field === undefined || field.kind !== "atom" || field.keys === undefined) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  // The document's own key order, so the reported value reads as stored.
  const shared = new Set(field.keys);
  return Object.fromEntries(Object.entries(value).filter(([k]) => shared.has(k)));
}

/**
 * Compare the viewed side against one source side, within one order scope.
 *
 * `notInvoiced` is called for a line the order or fulfillment carries that the
 * viewed INVOICE does not — the invoice view's half of the `quantity` entry.
 */
function compareScope(
  out: DocumentDiffMap,
  viewed: DiffSide,
  source: DiffSide,
  orderUid: string,
  billed: (rel: string) => boolean,
  notInvoiced: (rel: string, viewedKey: string) => void,
  invoiceLegs: ReadonlySet<string> = new Set(),
): void {
  const sourceRef = refOf(source.kind, source.doc);
  compareDocFields(out, viewed, source);
  // An invoice key carries its order-divider prefix; the others are order-relative.
  const viewedKey = (rel: string) => (isBilling(viewed) ? (rel === "" ? orderUid : `${orderUid}/${rel}`) : rel);

  /** The anchor that makes `rel` itself a substitute on `side`, if any. */
  const substituteAt = (side: DiffSide, rel: string) => side.lines.anchors.find((a) => key(a.path) === rel);
  const substituted = (at: string, replaced: string, substitute: string) =>
    push(out.lines, viewedKey(at), { kind: "substituted", source: sourceRef, replaced: viewedKey(replaced), substitute: viewedKey(substitute) });
  /**
   * X re-stated at the moved row's position, so a comparison of the two is about
   * TERMS: the position is the move itself, and the `moved` entry says so.
   */
  const placedAt = (line: LineItem, rel: string): LineItem => ({ ...line, path: rel.split("/") });
  /** A moved row (core#125), filed at `at`. `row` is already a viewed key; `orderLine` is order-relative. */
  const moved = (at: string, orderLine: string, row: string, fields: DocumentDiffField[]) =>
    push(out.lines, viewedKey(at), { kind: "moved", source: sourceRef, row, order_line: viewedKey(orderLine), fields });
  /**
   * Is this line inside a substitution the OTHER side can see — a component of
   * substitute Y (strictly below Y) on `side`, or X or a component of X that a
   * substitute on `side` replaced — where `other` carries the replaced X? Such
   * a line is explained by the one `substituted` entry and reports nothing.
   */
  const explainedBy = (side: DiffSide, other: DiffSide, rel: string): boolean => {
    const path = rel.split("/");
    return side.lines.anchors.some((a) =>
      other.lines.byKey.has(key(a.substitutedFor)) &&
      (isInSubstitutedSubtree(path, [a]) || (isRemovedBySubstitution(path, [a]) && key(a.substitutedFor) !== rel))
    );
  };

  // ── Destination pairs ──
  const pairsOf = (side: DiffSide): Map<string, DocDestinationType> => {
    const m = new Map<string, DocDestinationType>();
    for (const p of side.doc.destinations as readonly (DocDestinationType | InvoiceDocDestinationType)[]) {
      // A billing document's pairs name the initiator they bill (the side's scope key).
      const scopeKey = BILLING_FOLD[side.side].pairScopeKey;
      if (isBilling(side) && (p as unknown as Record<string, unknown>)[scopeKey] !== orderUid) continue;
      m.set(p.uid, p);
    }
    return m;
  };
  const viewedPairs = pairsOf(viewed);
  const sourcePairs = pairsOf(source);
  const involvesInvoice = isBilling(viewed) || isBilling(source);
  /**
   * Legs on only one side (decision 7). Between the order and the fulfillment,
   * any leg. Against an invoice, only a leg the INVOICE authored
   * (`invoiceLegs`, core#124): an invoice is compared at all only when its
   * scope carries the order's divider skeleton (`invoiceScopeDividersMatch`),
   * so a leg the order owns and the invoice lacks is either DECLINED (core#126 —
   * no pair entry; its lines are `quantity` entries) or an `unaligned` scope
   * reported as one — while a leg the invoice ADDED is a superset of that
   * skeleton, reported once here with its rows suppressed.
   */
  const oneSidedLegs = new Set<string>();
  if (involvesInvoice) {
    const invoiceIsViewed = isBilling(viewed);
    const [mine, theirs] = invoiceIsViewed ? [viewedPairs, sourcePairs] : [sourcePairs, viewedPairs];
    for (const uid of invoiceLegs) {
      if (!mine.has(uid) || theirs.has(uid)) continue;
      oneSidedLegs.add(uid);
      push(out.pairs, viewedKey(uid), { source: sourceRef, kind: invoiceIsViewed ? "not_on_source" : "only_on_source", fields: [] });
    }
  } else {
    for (const uid of viewedPairs.keys()) {
      if (!sourcePairs.has(uid)) {
        oneSidedLegs.add(uid);
        push(out.pairs, viewedKey(uid), { source: sourceRef, kind: "not_on_source", fields: [] });
      }
    }
    for (const uid of sourcePairs.keys()) {
      if (!viewedPairs.has(uid)) {
        oneSidedLegs.add(uid);
        push(out.pairs, viewedKey(uid), { source: sourceRef, kind: "only_on_source", fields: [] });
      }
    }
  }
  /**
   * A presence difference that a one-sided ANCESTOR already reports: a row
   * under a one-sided leg, or a component under a one-sided kit parent
   * (decision 7). The ancestor's entry is the one fact; its descendants are not
   * listed again.
   */
  const coveredByAncestor = (side: DiffSide, other: DiffSide, rel: string): boolean => {
    const path = rel.split("/");
    if (oneSidedLegs.has(path[0])) return true;
    for (let i = 1; i < path.length; i++) {
      const ancestor = path.slice(0, i).join("/");
      if (side.lines.byKey.has(ancestor) && !other.lines.byKey.has(ancestor)) return true;
    }
    return false;
  };

  // Order ↔ downstream only: which side carries the substitutions, and the D2
  // quantity each downstream row that the order also carries should have.
  const orderSide = isInitiator(viewed) ? viewed : isInitiator(source) ? source : undefined;
  const downstream = orderSide === undefined ? undefined : orderSide === viewed ? source : viewed;
  const liveAnchors = downstream === undefined || orderSide === undefined
    ? []
    : downstream.lines.anchors.filter((a) => orderSide.lines.byKey.has(key(a.substitutedFor)));
  const credit = (() => {
    if (orderSide === undefined || liveAnchors.length === 0) return new Map<string, number>();
    const direct = new Map<string, number>();
    for (const a of liveAnchors) direct.set(key(a.substitutedFor), (direct.get(key(a.substitutedFor)) ?? 0) + a.quantity);
    return substitutionCredit((orderSide.doc as Order).items as unknown as LineItem[], direct);
  })();
  const expectedFulfillmentQuantity = (rel: string, downstreamRow: LineItem, orderRow: LineItem): number | undefined => {
    if (downstream === undefined || !isCustody(downstream) || liveAnchors.length === 0) return undefined;
    const path = rel.split("/");
    const liveX = new Set(liveAnchors.filter((a) => isAtOrBelow(path, a.path)).map((a) => key(a.substitutedFor)));
    return (orderRow.quantity ?? 0) - (credit.get(rel) ?? 0) + standInUnits(downstreamRow as MaybeSubstitution, liveX);
  };

  for (const [rel, here] of viewed.lines.byKey) {
    if (!comparable(viewed, source, here)) continue;
    const there = source.lines.byKey.get(rel);
    if (there === undefined) {
      // The viewed invoice carries order line X here, moved (core#125).
      const claimed = viewed.lines.claims.get(rel);
      const claimedLine = claimed === undefined ? undefined : source.lines.byKey.get(claimed);
      if (claimed !== undefined && claimedLine !== undefined) {
        moved(rel, claimed, viewedKey(rel), lineFields(viewed, source, here, placedAt(claimedLine, rel), orderUid));
        continue;
      }
      // The viewed document carries a substitute Y where the source carries X.
      const mine = substituteAt(viewed, rel);
      if (mine && source.lines.byKey.has(key(mine.substitutedFor))) {
        substituted(rel, key(mine.substitutedFor), rel);
        continue;
      }
      // The source substituted this line away: one entry here, at X.
      const theirs = source.lines.anchors.find((a) => key(a.substitutedFor) === rel);
      if (theirs) {
        // A merge's Y is on this document too, and its own row carries the one entry.
        if (!viewed.lines.byKey.has(key(theirs.path))) substituted(rel, rel, key(theirs.path));
        continue;
      }
      if (explainedBy(viewed, source, rel) || explainedBy(source, viewed, rel)) continue;
      // Presence against invoices is a question about ALL of them: the
      // viewed order or fulfillment's `quantity` entry answers it.
      if (isBilling(source)) continue;
      if (coveredByAncestor(viewed, source, rel)) continue;
      push(out.lines, viewedKey(rel), { source: sourceRef, kind: "not_on_source", fields: [] });
      continue;
    }
    // A merge (manager#414): Y is on both documents, and the downstream row
    // stands in for an X the order still carries. One entry per X, at Y.
    for (const a of liveAnchors) {
      if (key(a.path) === rel) substituted(rel, key(a.substitutedFor), rel);
    }
    const expected = downstream === undefined
      ? undefined
      : expectedFulfillmentQuantity(rel, downstream === viewed ? here : there, downstream === viewed ? there : here);
    const fields = lineFields(viewed, source, here, there, orderUid, expected);
    if (fields.length > 0) push(out.lines, viewedKey(rel), { source: sourceRef, kind: "differs", fields });
  }
  for (const [rel, there] of source.lines.byKey) {
    if (viewed.lines.byKey.has(rel) || !comparable(source, viewed, there)) continue;
    // The source invoice carries the viewed line X at another position (core#125).
    const claimed = source.lines.claims.get(rel);
    const claimedLine = claimed === undefined ? undefined : viewed.lines.byKey.get(claimed);
    if (claimed !== undefined && claimedLine !== undefined) {
      moved(claimed, claimed, viewedKey(rel), lineFields(viewed, source, placedAt(claimedLine, rel), there, orderUid));
      continue;
    }
    // A viewed invoice row elsewhere bills this line: its `moved` entry is the answer.
    if ([...viewed.lines.claims.values()].includes(rel)) continue;
    // A line the viewed document substituted away is explained by the substitute's own entry.
    if (isRemovedBySubstitution(rel.split("/"), viewed.lines.anchors)) continue;
    // A substitute (or its component) the source carries in place of a line the
    // viewed document has is explained by the `substituted` entry at that line.
    const theirs = substituteAt(source, rel);
    if (theirs && viewed.lines.byKey.has(key(theirs.substitutedFor))) continue;
    if (explainedBy(source, viewed, rel)) continue;
    if (isBilling(viewed)) {
      // The order or fulfillment has it and this invoice does not: a sibling may bill it.
      if (billed(rel)) continue;
      notInvoiced(rel, viewedKey(rel));
      continue;
    }
    if (coveredByAncestor(source, viewed, rel)) continue;
    push(out.lines, viewedKey(rel), { source: sourceRef, kind: "only_on_source", fields: [] });
  }

  for (const [uid, here] of viewedPairs) {
    const there = sourcePairs.get(uid);
    if (there === undefined) continue;
    const h = here as unknown as Record<string, unknown>;
    const t = there as unknown as Record<string, unknown>;
    const fields: DocumentDiffField[] = [];
    const involvesFulfillment = isCustody(viewed) || isCustody(source);
    for (const field of [...new Set([...Object.keys(h), ...Object.keys(t)])].sort()) {
      if (PAIR_IDENTITY_FIELDS.has(field)) continue;
      if (involvesFulfillment && FULFILLMENT_UNOWNED_PAIR_FIELDS.has(field)) continue;
      if (JSON.stringify(canonicalizePayload(h[field])) !== JSON.stringify(canonicalizePayload(t[field]))) {
        fields.push({ field, here: h[field] ?? null, there: t[field] ?? null });
      }
    }
    if (fields.length > 0) push(out.pairs, viewedKey(uid), { source: sourceRef, kind: "pair_field", fields });
  }
}

/** What a view kind IS: the side its documents sit on and the role it plays (ruling 33). */
const VIEW_ROLES: Readonly<Record<DocumentViewKind, { side: Side; role: "initiator" | "custody" | "billing" }>> = {
  order: { side: "receivable", role: "initiator" },
  fulfillment: { side: "receivable", role: "custody" },
  invoice: { side: "receivable", role: "billing" },
  purchase: { side: "payable", role: "initiator" },
  bill: { side: "payable", role: "billing" },
};

type DiffInitiator = Order | Purchase;
type DiffBilling = Invoice | PurchaseBill;

/**
 * **Everything that differs between the sides in the diff** — data, never an
 * `if side` (ruling 84), on the pattern of `BILLING_FOLD`. Each entry reads the
 * sources a caller passed for one side; the comparison, the account and the
 * placement below are one pipeline over them.
 */
interface DiffSideData {
  /** The document kind of each role, for a {@link DocumentRef}. A side with no custody document passes none. */
  kinds: { initiator: DocumentKind; custody: DocumentKind; billing: DocumentKind; credit: DocumentKind };
  initiators(sources: DocumentDiffSources): readonly DiffInitiator[];
  /** The custody documents (a fulfillment's uid IS its order's). */
  custodyDocs(sources: DocumentDiffSources): readonly Fulfillment[];
  /** Every billing document passed, live or not. */
  billing(sources: DocumentDiffSources): readonly DiffBilling[];
  /** The credit documents on one initiator. */
  credits(sources: DocumentDiffSources, initiatorUid: string): readonly unknown[];
  /** The initiators a billing document carries a scope for. */
  scopesOf(doc: DiffBilling): string[];
  /** The custody input to the account, by initiator-relative key; `null` when not passed. */
  custodyInput(initiator: DiffInitiator, custodyDoc: Fulfillment | undefined, sources: DocumentDiffSources): ReadonlyMap<string, CustodyRow> | null;
  /** Lost/damaged records, pre-placed; empty when not passed. */
  outOfServiceInput(initiator: DiffInitiator, custodyDoc: Fulfillment | undefined, sources: DocumentDiffSources): OutOfServiceInput[];
  /** What {@link billingLineFields} reads per side: the data, never the rule. */
  line: {
    /** An initiator line in its billing row's shape, over the shared keys. */
    projectLine(initiatorLine: LineItem, billingLine: LineItem, initiatorUid: string): LineItem;
    /** The shared line fields the side's initiator → billing SYNC merges. */
    sharedLineFields(): readonly SharedField[];
    /** A billing row's check of its own money (ruling 33's second domain fact); `[]` where the side has none. */
    ownMoney(billingLine: LineItem, billingDoc: DiffBilling): DocumentDiffField[];
  };
  /** The document-level fields the initiator shares with each derived role; `null` for none. */
  docFields: { billing(): readonly SharedField[]; custody(): readonly SharedField[] | null };
}

/**
 * A LINKED bill's time line against its own snapshot: the supplier's money must
 * be what its own `rates × counts × quantity` reproduce, through the one
 * single-document check (`formulaMoneyMismatch`). Only a linked document's
 * money is not CFS's to derive (ruling 33's second domain fact); a pushed or
 * flat line's money is the account's question.
 */
function linkedTimeLineMoney(billingLine: LineItem, billingDoc: DiffBilling): DocumentDiffField[] {
  const line = billingLine as unknown as PurchaseDocumentItem;
  if ((billingDoc as PurchaseBill).origin !== "linked" || line.price?.price_formula.basis !== "time") return [];
  const expected = formulaMoneyMismatch(line.price, line.quantity, line.amount_cents);
  if (expected === null) return [];
  // A rate key the counts name and the rates lack: the snapshot itself is broken.
  if (Number.isNaN(expected)) return [{ field: "price.counts", here: line.price.counts, there: line.price.rates }];
  return [{ field: "amount_cents", here: line.amount_cents, there: expected }];
}

const DIFF_SIDES: Readonly<Record<Side, DiffSideData>> = {
  receivable: {
    kinds: { initiator: "order", custody: "fulfillment", billing: "invoice", credit: "credit_note" },
    initiators: (s) => s.orders ?? [],
    custodyDocs: (s) => s.fulfillments ?? [],
    billing: (s) => s.invoices ?? [],
    credits: (s) => s.creditNotes ?? [],
    scopesOf: (doc) => invoiceScopes(doc as Invoice),
    custodyInput: (_initiator, custodyDoc) => custodyDoc === undefined ? null : fulfillmentCustody(custodyDoc),
    outOfServiceInput: (initiator, custodyDoc, s) =>
      s.outOfService === undefined ? [] : orderOutOfServiceInputs(initiator as Order, custodyDoc, s.outOfService, s.invoices ?? []),
    line: {
      projectLine: (initiatorLine, _billingLine, initiatorUid) =>
        projectOrderItemToInvoiceItem(initiatorLine, initiatorUid) as unknown as LineItem,
      sharedLineFields: () => orderInvoiceSharedFields().line,
      ownMoney: () => [],
    },
    docFields: { billing: () => orderInvoiceSharedFields().doc, custody: () => orderFulfillmentSharedFields().doc },
  },
  payable: {
    kinds: { initiator: "purchase", custody: "fulfillment", billing: "bill", credit: "purchase_credit" },
    initiators: (s) => s.purchases ?? [],
    // No stored receipt is compared yet: AP custody is the movement journal's (`purchaseCustody`).
    custodyDocs: () => [],
    billing: (s) => s.bills ?? [],
    credits: (s, uid) => (s.purchaseCredits ?? []).filter((c) => purchaseCreditPurchaseUid(c) === uid),
    scopesOf: (doc) => deriveQueryByPurchases((doc as PurchaseBill).items),
    custodyInput: (initiator, _custodyDoc, s) => purchaseCustody(initiator as Purchase, s.purchaseCustody?.get(initiator.uid)),
    // Payable lost/damaged records are not compared (none is passed).
    outOfServiceInput: () => [],
    line: {
      // Fitted to the bill row's quantity, unlike the sync's whole-line
      // projection: the diff ignores the `flat_money` group, so a partial
      // replacement bill would otherwise report `out_of_service` on every row.
      projectLine: (initiatorLine, billingLine) =>
        projectPurchaseLineForBill(initiatorLine as unknown as PurchaseItem, billingLine.quantity ?? 0) as unknown as LineItem,
      sharedLineFields: purchaseBillSharedLineFields,
      ownMoney: linkedTimeLineMoney,
    },
    // No stored receipt is compared yet (custodyDocs above).
    docFields: { billing: purchaseBillSharedDocFields, custody: () => null },
  },
};

/** An initiator's lines, divider rows left out, by initiator-relative key. */
function scopeInitiator(items: readonly { type: string; path: readonly string[] }[]): ScopedLines {
  const byKey = new Map<string, LineItem>();
  for (const it of items) {
    if (isDividerItemType(it.type as OrderDocItemType["type"])) continue;
    byKey.set(key(it.path), it as unknown as LineItem);
  }
  return { byKey, anchors: [], claims: new Map() };
}

/**
 * One billing document's rows under one initiator scope, by initiator-relative
 * key — the same rules on both sides: an extension section bills days on lines
 * the initiator has and is the `quantity` entry's, not a line comparison's; a
 * row billing a RECORD no initiator line carries is the record's (decision 9); a moved row's claim is
 * read through the side's move pointer.
 */
function scopeBilling(side: Side, doc: DiffBilling, initiator: DiffInitiator): ScopedLines {
  const initiatorUid = initiator.uid;
  const initiatorKeys = new Set((initiator.items as readonly { path: readonly string[] }[]).map((it) => key(it.path)));
  const items = doc.items as unknown as InvoiceItem[];
  const byKey = new Map<string, LineItem>();
  const rel: MaybeSubstitution[] = [];
  const extensionTargets = extensionSectionTargets(items, initiatorUid);
  for (const it of items) {
    if (it.path[0] !== initiatorUid || isDividerItemType(it.type)) continue;
    if (isInExtensionSection(it.path, initiatorUid, extensionTargets)) continue;
    const relPath = it.path.slice(1);
    // A row billing a RECORD that no initiator line carries (an invoice's L&D
    // line) is the record's entry's, not a presence row. A payable line naming
    // records IS its purchase line (W4R), and is compared as one. Keyed on the
    // link (`billsOutOfService`), never on the `replacement` type.
    if (billsOutOfService(it) && !initiatorKeys.has(key(relPath))) continue;
    byKey.set(key(relPath), it as unknown as LineItem);
    if ("substituted_for" in it) rel.push({ path: relPath, substituted_for: it.substituted_for });
  }
  const claims = new Map<string, string>();
  for (const [row, x] of orderLineClaims(items, initiatorUid, BILLING_FOLD[side].pointerKey)) {
    if (byKey.has(row)) claims.set(row, key(x));
  }
  return { byKey, anchors: collectSubstitutionAnchors(rel), claims };
}

/** The destination legs a billing document's scope authored itself (core#124), on both sides. */
function authoredLegs(side: Side, doc: DiffBilling, initiator: DiffInitiator): Set<string> {
  const scopeType = BILLING_FOLD[side].scopeType;
  const scoped = (doc.items as unknown as InvoiceItem[]).filter((it) => it.path[0] === initiator.uid && it.type !== scopeType);
  const roots = invoiceAuthoredSubtrees(scoped, initiator.items as unknown as LineItem[], initiator.uid);
  const types = new Map(scoped.map((it) => [key(it.path.slice(1)), it.type]));
  return new Set(roots.filter((r) => r.length === 1 && types.get(key(r)) === "destination").map((r) => r[0]));
}

/** One initiator's documents, its fold and its account — built once per initiator per call. */
interface InitiatorScope {
  initiator: DiffInitiator;
  scoped: ScopedLines;
  custodyDoc: Fulfillment | undefined;
  /** Every billing document scoping it, live or not. */
  billing: DiffBilling[];
  account: InitiatorAccount;
  /** The fold: what each initiator-relative path is billed by. */
  fold: BilledByPath;
  /** Refs of the compared (live, aligned) billing documents, in fold order. */
  compared: DocumentRef[];
}

/** What a `quantity` entry is rendered from: a line's account, a custody-only row, or a lost/damaged record. */
type QuantityRow =
  | { of: "line"; line: LineAccount }
  | { of: "custody_only"; row: CustodyOnlyAccount }
  | { of: "out_of_service"; record: OutOfServiceInput };

/**
 * **Every `quantity` entry, from the account alone** (F9, ruling 92): the one
 * place one is built (pinned by `tests/billing-fold-coverage.test.ts`). A line's
 * is emitted iff the account says its documents disagree; a custody-only row's
 * (ruling 35's exception) and a lost/damaged record's (decision 9) are what the
 * account reports for them. Every figure is the account's; nothing is
 * re-derived here, on either side.
 */
function entryOf(side: Side, scope: InitiatorScope, row: QuantityRow): DocumentQuantityEntry {
  const entry: DocumentQuantityEntry = {
    kind: "quantity",
    invoices: scope.compared,
    ordered: null,
    fulfilled: null,
    invoiced: 0,
    quantity_cents: null,
    extension_cents: null,
    fulfilled_quantity_cents: null,
    crms_blocked: scope.account.crms_blocked,
    uid_out_of_service: null,
    credit_sources: [],
  };
  switch (row.of) {
    case "line": {
      const { line } = row;
      entry.ordered = line.ordered;
      entry.fulfilled = line.custody?.quantity ?? null;
      entry.invoiced = line.billed.quantity;
      entry.quantity_cents = line.quantity_cents;
      entry.extension_cents = line.extension.amount_cents;
      entry.fulfilled_quantity_cents = line.custody?.quantity_cents ?? null;
      entry.credit_sources = creditRefs(side, scope, line.credit_sources);
      if (line.kind === "stated") {
        entry.billed_cents = line.billed.amount_cents;
        entry.expected_cents = line.expected_cents ?? 0;
      }
      return entry;
    }
    case "custody_only":
      entry.fulfilled = row.row.custody;
      entry.invoiced = row.row.billed;
      return entry;
    case "out_of_service":
      entry.fulfilled = row.record.fulfilled;
      entry.invoiced = row.record.invoiced;
      entry.uid_out_of_service = row.record.uid;
      return entry;
  }
}

function creditRefs(side: Side, scope: InitiatorScope, uids: readonly string[]): DocumentRef[] {
  return uids.map((uid) => {
    const d = scope.account.documents.get(uid);
    return { kind: DIFF_SIDES[side].kinds.credit, uid, number: d?.number ?? 0, version: d?.version ?? 0 };
  });
}

/**
 * Every difference between the viewed document and the other documents passed in.
 *
 * **One pipeline for both sides** (ruling 33): the view's side and role come
 * from {@link VIEW_ROLES}, each side's sources from {@link DIFF_SIDES}, and
 * nothing below branches on the side. Per initiator, the account
 * (`accountInitiator` over `billedByPath`) is built once, and every `quantity`
 * entry is rendered from it (F9): emitted iff the account says the documents
 * disagree, and PLACED per view —
 *
 * - the initiator's view: at each line;
 * - the custody view: at each row it carries (a fulfillable line, or a row only
 *   it carries);
 * - a billing view: at each row the document bills, plus each initiator line it
 *   leaves out that no sibling bills (ruling 91's "not billed here").
 *
 * Presence, legs, substitutions and moves are {@link compareScope}'s, and the
 * field comparers are unchanged.
 *
 * @param sources - The documents the caller holds, the viewed one included
 * @param viewing - Which of them is being viewed
 * @param context - The pricing formulas and holidays an extension's counts are metered with
 * @returns Entries keyed by the viewed document's own path keys; empty when the
 *   viewed document is not among `sources`
 */
export function computeDocumentDiffs(
  sources: DocumentDiffSources,
  viewing: { kind: DocumentViewKind; uid: string },
  context: DocumentDiffContext,
): DocumentDiffMap {
  const out: DocumentDiffMap = {
    lines: new Map(), pairs: new Map(), unaligned: [], status: [], doc: [], unplaced_out_of_service: [],
    credits: new Map(), unkeyed_credit_notes: [],
  };
  const { side, role } = VIEW_ROLES[viewing.kind];
  const data = DIFF_SIDES[side];
  const kinds = data.kinds;
  const initiatorByUid = new Map(data.initiators(sources).map((d) => [d.uid, d]));
  const custodyByUid = new Map(data.custodyDocs(sources).map((d) => [d.uid, d]));
  const allBilling = data.billing(sources);
  const isLive = (doc: DiffBilling) => BILLING_FOLD[side].billingIsLive(doc as never);
  const isCanceled = (initiator: DiffInitiator) => initiator.status === "canceled";

  const scopes = new Map<string, InitiatorScope>();
  /** The initiator's account, built once. */
  const scopeOf = (uid: string): InitiatorScope | undefined => {
    const cached = scopes.get(uid);
    if (cached) return cached;
    const initiator = initiatorByUid.get(uid);
    if (initiator === undefined) return undefined;
    const custodyDoc = custodyByUid.get(uid);
    const billing = allBilling.filter((b) => data.scopesOf(b).includes(uid));
    const fold = billedByPath(
      side,
      { uid, items: initiator.items as unknown as LineItem[] },
      billing as never[],
      data.credits(sources, uid) as never[],
    );
    const account = accountInitiator(
      side,
      initiator as unknown as AccountedInitiator,
      fold,
      data.custodyInput(initiator, custodyDoc, sources),
      data.outOfServiceInput(initiator, custodyDoc, sources),
      { formulas: context.formulas, holidays: context.holidays },
    );
    const byUid = new Map(billing.map((b) => [b.uid, b]));
    const compared = fold.compared.map((u) => refOf(kinds.billing, byUid.get(u)!));
    const scope: InitiatorScope = { initiator, scoped: scopeInitiator(initiator.items), custodyDoc, billing, account, fold, compared };
    scopes.set(uid, scope);
    return scope;
  };

  const hasQuantityEntry = (viewedKey: string, uidOutOfService: string | null) =>
    out.lines.get(viewedKey)?.some((e) => e.kind === "quantity" && e.uid_out_of_service === uidOutOfService) ?? false;
  const fileEntry = (viewedKey: string, entry: DocumentQuantityEntry) => {
    if (!hasQuantityEntry(viewedKey, entry.uid_out_of_service)) push(out.lines, viewedKey, entry);
  };

  /** The entry for the initiator-relative key `rel`, if its documents disagree: a line's, or a custody-only row's. */
  const entryAt = (scope: InitiatorScope, rel: string): DocumentQuantityEntry | null => {
    const line = scope.account.lines.find((l) => key(l.path) === rel);
    if (line !== undefined) return line.disagrees.size > 0 ? entryOf(side, scope, { of: "line", line }) : null;
    const row = scope.account.custody_only.find((r) => key(r.path) === rel);
    return row === undefined ? null : entryOf(side, scope, { of: "custody_only", row });
  };

  /** Lost/damaged records the account reports, at the row that books each (or unplaced). */
  const fileOutOfService = (scope: InitiatorScope, keyOf: (rel: string) => string) => {
    for (const record of scope.account.out_of_service) {
      const entry = entryOf(side, scope, { of: "out_of_service", record });
      if (record.rel === null) {
        if (!out.unplaced_out_of_service.some((e) => e.uid_out_of_service === record.uid)) out.unplaced_out_of_service.push(entry);
        continue;
      }
      fileEntry(keyOf(record.rel), entry);
    }
  };

  const billingSide = (doc: DiffBilling, scope: InitiatorScope): DiffSide => ({ kind: kinds.billing, role: "billing", side, doc, lines: scopeBilling(side, doc, scope.initiator) });
  const initiatorSide = (scope: InitiatorScope): DiffSide => ({ kind: kinds.initiator, role: "initiator", side, doc: scope.initiator, lines: scope.scoped });
  const custodySide = (doc: Fulfillment): DiffSide => ({ kind: kinds.custody, role: "custody", side, doc, lines: scopeFulfillment(doc) });
  const named = (scope: InitiatorScope) => (rel: string) => scope.fold.byPath.has(rel);

  /** An initiator- or custody-shaped viewed side against every billing document on its initiator. */
  const againstBilling = (viewed: DiffSide, scope: InitiatorScope) => {
    const live = scope.billing.filter(isLive);
    if (isCanceled(scope.initiator)) {
      for (const doc of live) out.status.push({ issue: "live_invoice_on_canceled_order", source: refOf(kinds.billing, doc) });
      return;
    }
    for (const doc of live) {
      if (!scope.fold.compared.includes(doc.uid)) {
        out.unaligned.push({ scope: scope.initiator.uid, source: refOf(kinds.billing, doc) });
        continue;
      }
      compareScope(out, viewed, billingSide(doc, scope), scope.initiator.uid, named(scope), () => {}, authoredLegs(side, doc, scope.initiator));
    }
    for (const [rel, item] of viewed.lines.byKey) {
      // Against billing documents a custody document answers for its fulfillable rows only.
      if (role === "custody" && !isFulfillableItemType(item.type)) continue;
      const entry = entryAt(scope, rel);
      if (entry !== null) fileEntry(rel, entry);
    }
    fileOutOfService(scope, (rel) => rel);
  };

  fileCredits(out, creditKeys(sources.creditNotes ?? [], sources.invoices ?? [], sources.orders ?? []), viewing, sources.invoices ?? []);

  if (role === "initiator") {
    const scope = scopeOf(viewing.uid);
    if (scope === undefined) return out;
    const viewed = initiatorSide(scope);
    if (scope.custodyDoc !== undefined) {
      compareScope(out, viewed, custodySide(scope.custodyDoc), viewing.uid, named(scope), () => {});
    }
    againstBilling(viewed, scope);
    return out;
  }

  if (role === "custody") {
    const custodyDoc = custodyByUid.get(viewing.uid);
    if (custodyDoc === undefined) return out;
    const viewed = custodySide(custodyDoc);
    const scope = scopeOf(custodyDoc.uid);
    if (scope === undefined) return out;
    compareScope(out, viewed, initiatorSide(scope), scope.initiator.uid, named(scope), () => {});
    againstBilling(viewed, scope);
    return out;
  }

  // A dead billing document bills nothing and is not compared: its view is empty (the module doc).
  const doc = allBilling.find((d) => d.uid === viewing.uid);
  if (doc === undefined || !isLive(doc)) return out;
  const scopeUids = data.scopesOf(doc);
  // A row under no initiator scope is the document's own.
  const firstInitiator = [...initiatorByUid.values()][0];
  for (const it of doc.items as unknown as InvoiceItem[]) {
    if (isDividerItemType(it.type) || scopeUids.includes(it.path[0])) continue;
    if (firstInitiator !== undefined) push(out.lines, key(it.path), { kind: "not_on_source", source: refOf(kinds.initiator, firstInitiator), fields: [] });
  }
  for (const uid of scopeUids) {
    const scope = scopeOf(uid);
    // Without the initiator there is no path space to compare in — not even
    // against the custody document, which is joined THROUGH its paths.
    if (scope === undefined) continue;
    if (isCanceled(scope.initiator)) {
      out.status.push({ issue: "live_invoice_on_canceled_order", source: refOf(kinds.initiator, scope.initiator) });
      continue;
    }
    if (!scope.fold.compared.includes(doc.uid)) {
      out.unaligned.push({ scope: uid, source: refOf(kinds.initiator, scope.initiator) });
      if (scope.custodyDoc !== undefined) out.unaligned.push({ scope: uid, source: refOf(kinds.custody, scope.custodyDoc) });
      continue;
    }
    const viewed = billingSide(doc, scope);
    const viewedKey = (rel: string) => (rel === "" ? uid : `${uid}/${rel}`);
    /** Ruling 91: an initiator line this document leaves out and no sibling bills. */
    const notBilledHere = (rel: string, k: string) => {
      const entry = entryAt(scope, rel);
      if (entry !== null) fileEntry(k, entry);
    };
    const legs = authoredLegs(side, doc, scope.initiator);
    compareScope(out, viewed, initiatorSide(scope), uid, named(scope), notBilledHere, legs);
    // Each row this document carries reports the sum for the initiator line it bills.
    for (const [rel, at] of scope.fold.byPath) {
      for (const row of at.rows) {
        if (row.documentUid !== doc.uid) continue;
        const entry = entryAt(scope, rel);
        if (entry !== null) fileEntry(key(row.item.path), entry);
      }
    }
    if (scope.custodyDoc !== undefined) {
      compareScope(out, viewed, custodySide(scope.custodyDoc), uid, named(scope), notBilledHere, legs);
    }
    fileOutOfService(scope, viewedKey);
  }
  return out;
}

/** Every keyable credit, per invoice row, plus the notes that could not be keyed. */
interface CreditKeys {
  /** `invoiceUid|pathKey` → the row's path and the notes crediting it. */
  rows: Map<string, { uid_invoice: string; path: readonly string[]; credits: DocumentCredit[] }>;
  unkeyed: DocumentUnkeyedCredit[];
}

/**
 * Key every issued/applied credit note line to the invoice row it credits.
 *
 * The keying is the one credit keyer's reversed view (`keyInvoiceCredits`,
 * `utils/quantityAccounting.ts`) WITHOUT its `reverses_billing` filter: exactly
 * one `invoices` source, and the row's `path_invoice_item`. One fallback it
 * takes that netting does not, because this only DISPLAYS: a legacy line with
 * no path keys by `uid_invoice_item` when that uid is on exactly one line of the
 * invoice. A guessed row is acceptable on screen and not in arithmetic.
 */
function creditKeys(notes: readonly DocumentDiffCreditNote[], invoices: readonly Invoice[], orders: readonly Order[]): CreditKeys {
  const invoiceByUid = new Map(invoices.map((i) => [i.uid, i]));
  const orderByUid = new Map(orders.map((o) => [o.uid, o]));
  /** Does this invoice row bill an order line? See {@link DocumentCredit.bills_order_line}. */
  const billsOrderLine = (invoice: Invoice | undefined, path: readonly string[]): boolean | null => {
    const orderUid = path[0];
    const order = orderByUid.get(orderUid);
    if (invoice === undefined || order === undefined) return null;
    const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid) as unknown as InvoiceItem[];
    // A moved row (core#125) bills its claimed order line even inside an authored group.
    if (orderLineClaims(scoped, orderUid).has(key(path.slice(1)))) return true;
    return !isInInvoiceAuthoredSubtree(path, orderUid, invoiceAuthoredSubtrees(scoped, order.items as unknown as LineItem[], orderUid));
  };
  const rows: CreditKeys["rows"] = new Map();
  const unkeyed: DocumentUnkeyedCredit[] = [];
  for (const note of notes) {
    if (note.status !== "issued" && note.status !== "applied") continue;
    const sourced = (note.sources ?? []).filter((s) => s.collection === "invoices");
    const uidInvoice = sourced.length === 1 ? sourced[0].uid : null;
    for (const line of note.items) {
      let path: readonly string[] | undefined = line.path_invoice_item?.length ? line.path_invoice_item : undefined;
      const invoice = uidInvoice === null ? undefined : invoiceByUid.get(uidInvoice);
      if (path === undefined && invoice !== undefined && line.uid_invoice_item) {
        const matches = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.uid === line.uid_invoice_item && !isDividerItemType(it.type));
        if (matches.length === 1) path = matches[0].path;
      }
      if (uidInvoice === null || path === undefined) {
        if (!unkeyed.some((u) => u.uid_credit_note === note.uid)) {
          unkeyed.push({ uid_credit_note: note.uid, number: note.number, uid_invoice: uidInvoice });
        }
        continue;
      }
      const k = `${uidInvoice}|${key(path)}`;
      let row = rows.get(k);
      if (!row) rows.set(k, row = { uid_invoice: uidInvoice, path, credits: [] });
      const reverses = line.reverses_billing === true;
      const existing = row.credits.find((c) => c.uid_credit_note === note.uid);
      if (existing) {
        existing.quantity += line.quantity ?? 0;
        existing.reverses_billing &&= reverses;
      } else {
        row.credits.push({
          uid_credit_note: note.uid, number: note.number, uid_invoice: uidInvoice, quantity: line.quantity ?? 0,
          reverses_billing: reverses, bills_order_line: billsOrderLine(invoice, path),
        });
      }
    }
  }
  return { rows, unkeyed };
}

/** File {@link creditKeys}' answer into the viewed document's path space. */
function fileCredits(out: DocumentDiffMap, keys: CreditKeys, viewing: { kind: DocumentKind; uid: string }, invoices: readonly Invoice[]): void {
  const invoiceByUid = new Map(invoices.map((i) => [i.uid, i]));
  const file = (k: string, credits: readonly DocumentCredit[]) => {
    const list = out.credits.get(k) ?? [];
    out.credits.set(k, [...list, ...credits]);
  };
  if (viewing.kind === "invoice") {
    for (const row of keys.rows.values()) {
      if (row.uid_invoice === viewing.uid) file(key(row.path), row.credits);
    }
    out.unkeyed_credit_notes = keys.unkeyed.filter((u) => u.uid_invoice === viewing.uid || u.uid_invoice === null);
    return;
  }
  // Order and fulfillment views share the order's path space (a fulfillment's uid IS its order's).
  const orderUid = viewing.uid;
  const claimsByInvoice = new Map<string, Map<string, readonly string[]>>();
  const claimsOf = (invoice: Invoice) => {
    let claims = claimsByInvoice.get(invoice.uid);
    if (!claims) {
      const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid);
      claimsByInvoice.set(invoice.uid, claims = orderLineClaims(scoped as unknown as InvoiceItem[], orderUid));
    }
    return claims;
  };
  for (const row of keys.rows.values()) {
    if (row.path[0] !== orderUid) continue;
    const rel = row.path.slice(1);
    const invoice = invoiceByUid.get(row.uid_invoice);
    // A moved row (core#125) bills the order line it claims, so it is filed there.
    const billed = invoice === undefined ? undefined : claimsOf(invoice).get(key(rel));
    file(key(billed ?? rel), row.credits);
  }
  out.unkeyed_credit_notes = keys.unkeyed.filter((u) => {
    if (u.uid_invoice === null) return true;
    const invoice = invoiceByUid.get(u.uid_invoice);
    return invoice === undefined || invoiceScopes(invoice).includes(orderUid);
  });
}
