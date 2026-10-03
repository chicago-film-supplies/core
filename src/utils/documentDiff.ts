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
 * change still reports through its CAUSE — a declared input (`base_cents`,
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
 * compared for presence: an invoice scope missing it fails the divider-skeleton
 * match and is reported once, in `unaligned`. A leg the INVOICE authored
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
 *   missing units and for a date extension — computed by `invoicedByPath` /
 *   `accountLine` (`utils/quantityAccounting.ts`). A line no invoice carries is
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
 * presence rows. An invoice line carrying `uid_out_of_service` is skipped by
 * the line comparison, and each record gets its own `quantity` entry at the
 * row that owns its booking: `fulfilled` is its billable units, `invoiced` what
 * its replacement lines bill.
 *
 * Order ↔ invoice line differences go through
 * {@link invoiceItemDifferences} + {@link explainInvoiceItemDifferences} FIRST
 * and are filtered to the compared fields SECOND — the explanation arms are the
 * sync badge's, reused rather than restated, so this can never report a
 * difference the badge has explained away.
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
  DocDestinationType,
  Fulfillment,
  FulfillmentItemType,
  Invoice,
  InvoiceDocDestinationType,
  InvoiceDocItemType,
  Order,
  OrderDocItemType,
  OutOfService,
} from "../schemas/mod.ts";
import { exchangedForKey, exchangedForOf, isDividerItemType, isFulfillableItemType } from "../schemas/mod.ts";
import {
  canonicalizePayload,
  explainInvoiceItemDifferences,
  extensionSectionTargets,
  type InvoiceItem,
  invoiceItemDifferences,
  invoiceAuthoredSubtrees,
  invoiceScopeDividersMatch,
  isInExtensionSection,
  orderInvoiceSharedFields,
  projectOrderItemToInvoiceItem,
} from "./invoices.ts";
import type { LineItem } from "./orders.ts";
import { statedChargeWindows } from "./price-document.ts";
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
import { accountLine, type AccountedInvoice, type InvoicedByPath, invoicedByPath, crmsAuthoredInvoices, orderLineWindow, substitutionCredit } from "./quantityAccounting.ts";
import { orderFulfillmentSharedFields, type SharedField } from "./shared-fields.ts";
import { bookingIdsByPath } from "./order-edit-delta.ts";
import { parseBookingId } from "./booking-id.ts";
import { BILLABLE_OOS_REASONS, billedOutOfService, type ReplacementBillingInvoice } from "./replacements.ts";

/** The three document kinds a diff can be viewed from or sourced from. */
export type DocumentKind = "order" | "fulfillment" | "invoice";

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
}

/** One entry at one key of the viewed document. Discriminated on `kind`. */
export type DocumentDiffEntry =
  | DocumentSourceDiffEntry
  | DocumentSubstitutionEntry
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
}

/** A lifecycle mismatch no per-line comparison can show. */
export type DocumentStatusIssue = "live_invoice_on_canceled_order";

/** What the diff reads of an `out-of-service` record. */
export type DocumentDiffOutOfService = Pick<OutOfService, "uid" | "reason" | "status" | "quantity" | "query_by_sources"> & {
  breakdown: Pick<OutOfService["breakdown"], "returned_to_service">;
};

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
}

/** What the order ↔ invoice explanation arms need, per order. */
export interface DocumentDiffContext {
  /** Tax uid → name, as {@link explainInvoiceItemDifferences} requires. */
  taxNameByUid: ReadonlyMap<string, string>;
  /**
   * Whether an order is frozen (no longer repriceable). A caller predicate
   * because the status set lives with the writer that enforces it
   * (`api-cloudrun/src/lib/orderTaxPricing.ts` `REPRICEABLE_ORDER_STATUSES`).
   */
  isOrderFrozen: (order: Order) => boolean;
}

/**
 * The DERIVED line fields, read off the shared-field classification rather than
 * listed here — the same source {@link mergeSharedFields} skips.
 *
 * ⭐ **This replaced two hand-maintained lists, and that is the point.** There
 * used to be a `COMPARED_LINE_FIELDS` set naming what produced a `differs`
 * entry and a `SPLIT_DERIVED_FIELDS` set naming what a quantity/day split
 * excused. A field absent from the first was invisible to every diff view with
 * nothing saying so, and the two lists could disagree with the SYNC about what
 * counts as an override — which is precisely how a line could read "overridden"
 * in one place and "synced" in another.
 *
 * Now the diff walks the same key intersection the sync merges, so **a new
 * shared field is compared by construction** and the two answers cannot drift.
 */
const derivedLineFields = (): ReadonlySet<string> => {
  if (derivedLineFieldsMemo) return derivedLineFieldsMemo;
  derivedLineFieldsMemo = new Set(
    orderInvoiceSharedFields().line.filter((f) => f.kind === "derived").map((f) => f.path),
  );
  return derivedLineFieldsMemo;
};
let derivedLineFieldsMemo: ReadonlySet<string> | undefined;

/** The pair keys a comparison is addressed BY, never part of what it compares. */
const PAIR_IDENTITY_FIELDS: ReadonlySet<string> = new Set(["uid", "uid_order"]);

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
}

function scopeOrder(order: Order): ScopedLines {
  const byKey = new Map<string, LineItem>();
  for (const it of order.items as readonly OrderDocItemType[]) {
    if (isDividerItemType(it.type)) continue;
    byKey.set(key(it.path), it as unknown as LineItem);
  }
  return { byKey, anchors: [] };
}

function scopeFulfillment(fulfillment: Fulfillment): ScopedLines {
  const byKey = new Map<string, LineItem>();
  for (const it of fulfillment.items as readonly FulfillmentItemType[]) {
    if (isDividerItemType(it.type)) continue;
    byKey.set(key(it.path), it as unknown as LineItem);
  }
  return { byKey, anchors: collectSubstitutionAnchors(fulfillment.items as readonly FulfillmentItemType[]) };
}

function scopeInvoice(invoice: Invoice, orderUid: string): ScopedLines {
  const byKey = new Map<string, LineItem>();
  const rel: MaybeSubstitution[] = [];
  // A date-extension section bills days on lines the order has; its money is
  // the `quantity` entry's (through `invoicedByPath`), so its lines are no line
  // comparison's subject.
  const extensionTargets = extensionSectionTargets(invoice.items as unknown as InvoiceItem[], orderUid);
  for (const it of invoice.items as readonly InvoiceDocItemType[]) {
    if (it.path[0] !== orderUid || isDividerItemType(it.type)) continue;
    if (isInExtensionSection(it.path, orderUid, extensionTargets)) continue;
    // A lost/damaged billing line is no presence row: it bills a RECORD, not an
    // order line, and its record's `quantity` entry is its answer (decision 9).
    // Keyed on `uid_out_of_service`, never on the `replacement` type.
    if ((it as { uid_out_of_service?: string | null }).uid_out_of_service != null) continue;
    const relPath = it.path.slice(1);
    byKey.set(key(relPath), it as unknown as LineItem);
    const line = it as InvoiceItem;
    rel.push({ path: relPath, substituted_for: line.substituted_for });
  }
  return { byKey, anchors: collectSubstitutionAnchors(rel) };
}

/** The order uids an invoice carries a scope for. */
function invoiceScopes(invoice: Invoice): string[] {
  return (invoice.items as readonly InvoiceDocItemType[])
    .filter((it) => it.type === "order")
    .map((it) => it.uid);
}

type Side = { kind: DocumentKind; doc: Order | Fulfillment | Invoice; lines: ScopedLines };

/** Only fulfillable lines take part in a comparison that involves a fulfillment. */
function comparable(side: Side, other: Side, item: LineItem): boolean {
  const involvesFulfillment = side.kind === "fulfillment" || other.kind === "fulfillment";
  return !involvesFulfillment || isFulfillableItemType(item.type);
}

/** The compared fields two same-path lines disagree on. `here` belongs to `viewed`. */
function lineFields(
  viewed: Side,
  source: Side,
  here: LineItem,
  there: LineItem,
  orderUid: string,
  context: DocumentDiffContext,
  expectedFulfillmentQuantity?: number,
): DocumentDiffField[] {
  const involvesFulfillment = viewed.kind === "fulfillment" || source.kind === "fulfillment";
  // Fulfillment ↔ invoice quantity is the `quantity` entry's, over every invoice.
  if (involvesFulfillment && (viewed.kind === "invoice" || source.kind === "invoice")) return [];
  if (involvesFulfillment) {
    // D2: a fulfillment row is the order's quantity, less what substitutes took
    // from it, plus what it stands in for (manager#414).
    const fulfillmentQuantity = (viewed.kind === "fulfillment" ? here : there).quantity ?? 0;
    const orderQuantity = (viewed.kind === "order" ? here : there).quantity ?? 0;
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
  // order ↔ invoice: the badge's comparator and explanation arms, then the owner's field filter.
  const order = (viewed.kind === "order" ? viewed.doc : source.doc) as Order;
  const invoice = (viewed.kind === "invoice" ? viewed.doc : source.doc) as Invoice;
  const orderLine = viewed.kind === "order" ? here : there;
  const invoiceLine = (viewed.kind === "invoice" ? here : there) as unknown as InvoiceItem;
  const expected = projectOrderItemToInvoiceItem(orderLine, orderUid) as unknown as InvoiceItem;
  const { unexplained } = explainInvoiceItemDifferences(
    expected,
    invoiceLine,
    invoiceItemDifferences(expected, invoiceLine),
    {
      taxNameByUid: context.taxNameByUid,
      orderFrozen: context.isOrderFrozen(order),
      // ⚠️ The `invoice_windows` arm cannot change this function's OUTPUT — the
      // day count and every money field it covers are `derived`, and the filters
      // below drop those unconditionally (see the G2 comment). It is passed
      // anyway, and truthfully: the alternative is an empty array that reads as
      // "this invoice states no windows", which is a lie that would rot the day a
      // non-derived field joined the arm's coverage.
      invoiceChargeWindows: statedChargeWindows(invoice.destinations ?? []),
    },
  );
  const derived = derivedLineFields();
  return unexplained
    // How many units and days are billed is the `quantity` entry's, over the sum.
    .filter((f) => f !== "quantity" && f !== "price.chargeable_days")
    // The comparator names a price difference at the KEY (`price.discount`);
    // the classification is per LEAF (`price.discount.rate` propagated,
    // `.amount_cents` derived). Judge it at the classification's grain.
    .flatMap((f) => classifiedGrain(here, there, f))
    // 🔴 **A DERIVED field never produces a row on its own — this is G2, and the
    // suppression is UNCONDITIONAL.** An invoice is repriced in its OWN context —
    // its jurisdiction, its tax date — so its derived money can differ from the
    // order's with no operator edit and no split at all. The sync never compares
    // a derived field; the diff must not either, or the two disagree about what
    // "overridden" means.
    //
    // A difference an operator caused still reports, through its CAUSE: a
    // declared input (`base_cents`, `base_percent`), a discount's `rate`/`type`,
    // or a tax's causes (`uid_tax_class`, `uid_tax_class_override`, the doc's
    // `tax_exempt`/`uid_store`, the pair's `jurisdiction`). `price.taxes` itself
    // is derived WHOLE, rate included: a document's rate is the one whose window
    // holds the document's own as-of date (the `cfs-tax` skill), so an invoice's
    // rate can legitimately differ from its order's.
    .filter((f) => !derived.has(f))
    .map((field) => ({ field, here: readField(here, field), there: readField(there, field) }));
}

/**
 * The shared LEAVES a key-level difference resolves to, read off the
 * shared-field classification.
 *
 * `invoiceItemDifferences` reports `price.discount` whole. With this the diff
 * sees `price.discount.rate` and `price.discount.amount_cents` separately, so
 * a split bill's smaller discount AMOUNT (derived) is not an override while a
 * changed RATE is. Before this, the comparison ran at the key and the derived
 * set held leaves, so the key was never "derived" and every split-billed
 * discounted line read as overridden (core#118).
 *
 * A value present on one side only (a discount added or removed) stays the
 * whole key: that is one operator decision, not a list of leaf changes.
 */
function classifiedGrain(here: LineItem, there: LineItem, field: string): string[] {
  const leaves = classifiedLinePaths().filter((p) => p.startsWith(`${field}.`));
  if (leaves.length === 0) return [field];
  if (readField(here, field) === null || readField(there, field) === null) return [field];
  return leaves.filter((leaf) =>
    JSON.stringify(canonicalizePayload(readField(here, leaf))) !== JSON.stringify(canonicalizePayload(readField(there, leaf)))
  );
}

const classifiedLinePaths = (): readonly string[] => {
  if (classifiedLinePathsMemo) return classifiedLinePathsMemo;
  classifiedLinePathsMemo = orderInvoiceSharedFields().line.map((f) => f.path);
  return classifiedLinePathsMemo;
};
let classifiedLinePathsMemo: readonly string[] | undefined;

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
 * The invoice coverage of one order scope: what every aligned invoice, summed,
 * bills at each order-relative line key, and which invoices were checked.
 */
interface InvoiceCoverage {
  invoiced: InvoicedByPath;
  invoices: DocumentRef[];
  /**
   * The invoice DOCUMENTS the sum was taken over — the aligned, non-void ones.
   *
   * ⚠️ Not the same as {@link invoices}, which is refs for display: a
   * `DocumentRef` is `{kind, uid, number, version}` and carries no `crms_id`, so
   * only this half can answer whether the over-billing offer refuses the order.
   */
  alignedInvoices: AccountedInvoice[];
}

/** Does some aligned invoice bill this order-relative line, directly or as a substitute? */
function covers(coverage: InvoiceCoverage, rel: string): boolean {
  return coverage.invoiced.byPath.has(rel);
}

/**
 * The document-level fields to compare between two document kinds, read off the
 * shared-field classification rather than listed here (G13).
 *
 * `null` means the pair has no direct document-level relationship. An invoice
 * and a fulfillment are both projections OF an order and have no link to each
 * other — comparing them would report every difference twice, once against the
 * order and once against each other, and there is no rule saying which of the
 * two should have followed the other.
 */
function docFieldsFor(a: DocumentKind, b: DocumentKind): readonly SharedField[] | null {
  const pair = new Set([a, b]);
  if (pair.size !== 2) return null;
  if (pair.has("order") && pair.has("invoice")) return orderInvoiceSharedFields().doc;
  if (pair.has("order") && pair.has("fulfillment")) return orderFulfillmentSharedFields().doc;
  return null;
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
 * rather than one moved reference.
 */
function compareDocFields(out: DocumentDiffMap, viewed: Side, source: Side): void {
  const shared = docFieldsFor(viewed.kind, source.kind);
  if (shared === null) return;
  const sourceRef = refOf(source.kind, source.doc);
  // One entry per source, however many scopes reach the same pair.
  if (out.doc.some((e) => e.kind === "doc_field" && e.source.kind === sourceRef.kind && e.source.uid === sourceRef.uid)) return;

  const fields: DocumentDiffField[] = [];
  for (const f of shared) {
    if (f.kind !== "propagated" && f.kind !== "atom") continue;
    const here = readField(viewed.doc, f.path);
    const there = readField(source.doc, f.path);
    if (JSON.stringify(canonicalizePayload(here)) === JSON.stringify(canonicalizePayload(there))) continue;
    fields.push({ field: f.path, here, there });
  }
  if (fields.length > 0) out.doc.push({ kind: "doc_field", source: sourceRef, fields });
}

/** A line's `exchanged_for` is non-empty: it is an exchange unit, shown but never owed (see {@link computeDocumentDiffs}). */
function isExchangeUnit(item: LineItem | undefined): boolean {
  return item !== undefined && exchangedForOfLine(item).length > 0;
}

/**
 * Compare the viewed side against one source side, within one order scope.
 *
 * `notInvoiced` is called for a line the order or fulfillment carries that the
 * viewed INVOICE does not — the invoice view's half of the `quantity` entry.
 */
function compareScope(
  out: DocumentDiffMap,
  viewed: Side,
  source: Side,
  orderUid: string,
  coverage: InvoiceCoverage,
  context: DocumentDiffContext,
  notInvoiced: (rel: string, viewedKey: string) => void,
  invoiceLegs: ReadonlySet<string> = new Set(),
): void {
  const sourceRef = refOf(source.kind, source.doc);
  compareDocFields(out, viewed, source);
  // An invoice key carries its order-divider prefix; the others are order-relative.
  const viewedKey = (rel: string) => (viewed.kind === "invoice" ? (rel === "" ? orderUid : `${orderUid}/${rel}`) : rel);

  /** The anchor that makes `rel` itself a substitute on `side`, if any. */
  const substituteAt = (side: Side, rel: string) => side.lines.anchors.find((a) => key(a.path) === rel);
  const substituted = (at: string, replaced: string, substitute: string) =>
    push(out.lines, viewedKey(at), { kind: "substituted", source: sourceRef, replaced: viewedKey(replaced), substitute: viewedKey(substitute) });
  /**
   * Is this line inside a substitution the OTHER side can see — a component of
   * substitute Y (strictly below Y) on `side`, or X or a component of X that a
   * substitute on `side` replaced — where `other` carries the replaced X? Such
   * a line is explained by the one `substituted` entry and reports nothing.
   */
  const explainedBy = (side: Side, other: Side, rel: string): boolean => {
    const path = rel.split("/");
    return side.lines.anchors.some((a) =>
      other.lines.byKey.has(key(a.substitutedFor)) &&
      (isInSubstitutedSubtree(path, [a]) || (isRemovedBySubstitution(path, [a]) && key(a.substitutedFor) !== rel))
    );
  };

  // ── Destination pairs ──
  const pairsOf = (side: Side): Map<string, DocDestinationType> => {
    const m = new Map<string, DocDestinationType>();
    for (const p of side.doc.destinations as readonly (DocDestinationType | InvoiceDocDestinationType)[]) {
      if (side.kind === "invoice" && (p as InvoiceDocDestinationType).uid_order !== orderUid) continue;
      m.set(p.uid, p);
    }
    return m;
  };
  const viewedPairs = pairsOf(viewed);
  const sourcePairs = pairsOf(source);
  const involvesInvoice = viewed.kind === "invoice" || source.kind === "invoice";
  /**
   * Legs on only one side (decision 7). Between the order and the fulfillment,
   * any leg. Against an invoice, only a leg the INVOICE authored
   * (`invoiceLegs`, core#124): an invoice is compared at all only when its
   * scope carries the order's divider skeleton (`invoiceScopeDividersMatch`),
   * so a leg the order owns and the invoice lacks is an `unaligned` scope and is
   * reported as one — while a leg the invoice ADDED is a superset of that
   * skeleton, reported once here with its rows suppressed.
   */
  const oneSidedLegs = new Set<string>();
  if (involvesInvoice) {
    const invoiceIsViewed = viewed.kind === "invoice";
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
  const coveredByAncestor = (side: Side, other: Side, rel: string): boolean => {
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
  const orderSide = viewed.kind === "order" ? viewed : source.kind === "order" ? source : undefined;
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
    if (downstream?.kind !== "fulfillment" || liveAnchors.length === 0) return undefined;
    const path = rel.split("/");
    const liveX = new Set(liveAnchors.filter((a) => isAtOrBelow(path, a.path)).map((a) => key(a.substitutedFor)));
    return (orderRow.quantity ?? 0) - (credit.get(rel) ?? 0) + standInUnits(downstreamRow as MaybeSubstitution, liveX);
  };

  for (const [rel, here] of viewed.lines.byKey) {
    if (!comparable(viewed, source, here)) continue;
    const there = source.lines.byKey.get(rel);
    if (there === undefined) {
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
      if (source.kind === "invoice") continue;
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
    const fields = lineFields(viewed, source, here, there, orderUid, context, expected);
    if (fields.length > 0) push(out.lines, viewedKey(rel), { source: sourceRef, kind: "differs", fields });
  }
  for (const [rel, there] of source.lines.byKey) {
    if (viewed.lines.byKey.has(rel) || !comparable(source, viewed, there)) continue;
    // A line the viewed document substituted away is explained by the substitute's own entry.
    if (isRemovedBySubstitution(rel.split("/"), viewed.lines.anchors)) continue;
    // A substitute (or its component) the source carries in place of a line the
    // viewed document has is explained by the `substituted` entry at that line.
    const theirs = substituteAt(source, rel);
    if (theirs && viewed.lines.byKey.has(key(theirs.substitutedFor))) continue;
    if (explainedBy(source, viewed, rel)) continue;
    if (viewed.kind === "invoice") {
      // The order or fulfillment has it and this invoice does not: a sibling may bill it.
      if (covers(coverage, rel)) continue;
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
    const involvesFulfillment = viewed.kind === "fulfillment" || source.kind === "fulfillment";
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

/**
 * Every difference between the viewed document and the other documents passed in.
 *
 * @param sources - The documents the caller holds, the viewed one included
 * @param viewing - Which of them is being viewed
 * @param context - Tax names and the order freeze predicate, for the explanation arms
 * @returns Entries keyed by the viewed document's own path keys; empty when the
 *   viewed document is not among `sources`
 */
export function computeDocumentDiffs(
  sources: DocumentDiffSources,
  viewing: { kind: DocumentKind; uid: string },
  context: DocumentDiffContext,
): DocumentDiffMap {
  const out: DocumentDiffMap = { lines: new Map(), pairs: new Map(), unaligned: [], status: [], doc: [], unplaced_out_of_service: [] };
  const orders = sources.orders ?? [];
  const fulfillments = sources.fulfillments ?? [];
  // A void invoice bills nothing: dropped before any comparison (see the module doc).
  const invoices = (sources.invoices ?? []).filter((i) => i.status !== "void");
  const isCanceled = (order: Order | undefined) => order?.status === "canceled";
  const orderByUid = new Map(orders.map((o) => [o.uid, o]));
  const fulfillmentByUid = new Map(fulfillments.map((f) => [f.uid, f]));

  /** Is this invoice's scope for `orderUid` comparable at all? Needs the order. */
  const aligned = (invoice: Invoice, orderUid: string): boolean => {
    const order = orderByUid.get(orderUid);
    if (order === undefined) return false;
    const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid);
    return invoiceScopeDividersMatch(scoped as unknown as InvoiceItem[], order.items as unknown as LineItem[], orderUid);
  };

  /** The destination legs an invoice's scope for `orderUid` authored itself (core#124). */
  const invoiceLegsOf = (invoice: Invoice, orderUid: string): Set<string> => {
    const order = orderByUid.get(orderUid);
    if (order === undefined) return new Set();
    const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid);
    const roots = invoiceAuthoredSubtrees(scoped as unknown as InvoiceItem[], order.items as unknown as LineItem[], orderUid);
    const types = new Map(scoped.map((it) => [key(it.path.slice(1)), it.type]));
    return new Set(roots.filter((r) => r.length === 1 && types.get(key(r)) === "destination").map((r) => r[0]));
  };

  /** Every aligned invoice passed for `orderUid`, with what they bill summed per line. */
  const coverageOf = (orderUid: string): InvoiceCoverage & { alignedInvoices: Invoice[] } => {
    const refs: DocumentRef[] = [];
    const alignedInvoices: Invoice[] = [];
    for (const invoice of invoices) {
      if (!invoiceScopes(invoice).includes(orderUid) || !aligned(invoice, orderUid)) continue;
      alignedInvoices.push(invoice);
      refs.push(refOf("invoice", invoice));
    }
    const invoiced = invoicedByPath(
      orderUid,
      (orderByUid.get(orderUid)?.items ?? []) as unknown as LineItem[],
      alignedInvoices as unknown as AccountedInvoice[],
    );
    return { invoiced, invoices: refs, alignedInvoices };
  };

  const hasQuantityEntry = (viewedKey: string, uidOutOfService: string | null) =>
    out.lines.get(viewedKey)?.some((e) => e.kind === "quantity" && e.uid_out_of_service === uidOutOfService) ?? false;

  /**
   * One `quantity` entry at `viewedKey` for the order-relative line `rel`, when
   * the three documents disagree about it (see {@link DocumentQuantityEntry}).
   *
   * ⚠️ **An exchange unit (a line carrying `exchanged_for`) is SHOWN, never OWED**
   * (decision 8): it goes to the customer in place of a lost, damaged or dirty
   * one, bills at $0 unless an operator prices it, and must not read as
   * uninvoiced. Its presence and its fields are still compared.
   */
  const quantityEntry = (orderUid: string, coverage: InvoiceCoverage, rel: string, viewedKey: string) => {
    if (coverage.invoices.length === 0) return;
    if (hasQuantityEntry(viewedKey, null)) return;
    const order = orderByUid.get(orderUid);
    const orderLine = order === undefined ? undefined : scopeOrder(order).byKey.get(rel);
    const fulfillment = fulfillmentByUid.get(orderUid);
    const scoped = fulfillment === undefined ? undefined : scopeFulfillment(fulfillment);
    let fulfilledLine = scoped?.byKey.get(rel);
    if (isExchangeUnit(orderLine) || isExchangeUnit(fulfilledLine)) return;
    // A substituted row's units moved between products; the `substituted` entry
    // at that line is its answer, and a quantity here would double-report it.
    if (scoped?.anchors.some((a) => key(a.path) === rel || key(a.substitutedFor) === rel)) fulfilledLine = undefined;
    const at = coverage.invoiced.byPath.get(rel);
    const invoiced = at?.quantity ?? 0;
    const fulfilled = fulfilledLine === undefined ? null : fulfilledLine.quantity ?? 0;
    const crms_blocked = crmsAuthoredInvoices(coverage.alignedInvoices).length > 0;

    if (orderLine === undefined) {
      // A row only the fulfillment carries (a picker add, a kept row).
      if (fulfilled === null || fulfilled === invoiced) return;
      push(out.lines, viewedKey, {
        kind: "quantity", invoices: coverage.invoices, ordered: null, fulfilled, invoiced,
        quantity_cents: null, extension_cents: null, fulfilled_quantity_cents: null,
        crms_blocked, uid_out_of_service: null,
      });
      return;
    }
    const account = accountLine(
      orderLine,
      at,
      orderLineWindow(order!.destinations ?? [], orderLine.path ?? []),
      fulfilled ?? undefined,
    );
    const fulfilledDisagrees = fulfilled !== null && fulfilled !== account.ordered && fulfilled !== invoiced;
    if (account.quantity === 0 && account.extension_cents === 0 && !fulfilledDisagrees) return;
    push(out.lines, viewedKey, {
      kind: "quantity",
      invoices: coverage.invoices,
      ordered: account.ordered,
      fulfilled,
      invoiced,
      quantity_cents: account.quantity_cents,
      extension_cents: account.extension_cents,
      fulfilled_quantity_cents: account.fulfilled_quantity_cents ?? null,
      // The builder's own condition, so the copy and the offer cannot refuse
      // differently. `alignedInvoices` is what the sum was taken over.
      crms_blocked,
      uid_out_of_service: null,
    });
  };

  /**
   * Lost/damaged records for `orderUid`, each as a `quantity` entry at the row
   * that owns its booking (decision 9).
   *
   * - `fulfilled` is the record's billable units: `quantity −
   *   returned_to_service`, or 0 once the record is canceled;
   * - `invoiced` is what non-void invoices' `replacement` lines bill it
   *   (`billedOutOfService`, the sum the api's over-bill advisory reads);
   * - `ordered` does not apply.
   *
   * The row is found through {@link bookingIdsByPath}, the enumeration the
   * order-edit keep uses, over the order first and then the fulfillment (a
   * kept row's booking is on no order line). A record no row books goes in
   * `unplaced_out_of_service`.
   *
   * @param keyOf - the viewed document's key for an order-relative row path
   */
  const outOfServiceEntries = (orderUid: string, coverage: InvoiceCoverage, keyOf: (rel: string) => string) => {
    if (sources.outOfService === undefined || coverage.invoices.length === 0) return;
    const orderKey = `orders:${orderUid}`;
    const records = sources.outOfService.filter((r) =>
      (BILLABLE_OOS_REASONS as readonly string[]).includes(r.reason) && r.query_by_sources.includes(orderKey)
    );
    if (records.length === 0) return;
    const rowByBooking = new Map<string, string>();
    const order = orderByUid.get(orderUid);
    const fulfillment = fulfillmentByUid.get(orderUid);
    for (const doc of [order, fulfillment]) {
      if (doc === undefined) continue;
      for (const { path, bookingId } of bookingIdsByPath(doc as unknown as Order)) {
        if (!rowByBooking.has(bookingId)) rowByBooking.set(bookingId, key(path));
      }
    }
    const invoicedByRecord = billedOutOfService(invoices as unknown as ReplacementBillingInvoice[]);
    const crms_blocked = crmsAuthoredInvoices(coverage.alignedInvoices).length > 0;
    for (const record of records) {
      const fulfilled = record.status === "canceled" ? 0 : record.quantity - record.breakdown.returned_to_service;
      const invoiced = invoicedByRecord.get(record.uid) ?? 0;
      if (fulfilled === invoiced) continue;
      const entry: DocumentQuantityEntry = {
        kind: "quantity", invoices: coverage.invoices, ordered: null, fulfilled, invoiced,
        quantity_cents: null, extension_cents: null, fulfilled_quantity_cents: null,
        crms_blocked, uid_out_of_service: record.uid,
      };
      const bookingId = record.query_by_sources
        .filter((s) => s.startsWith("bookings:"))
        .map((s) => s.slice("bookings:".length))
        .find((id) => parseBookingId(id)?.orderUid === orderUid);
      const rel = bookingId === undefined ? undefined : rowByBooking.get(bookingId);
      if (rel === undefined) {
        if (!out.unplaced_out_of_service.some((e) => e.uid_out_of_service === record.uid)) out.unplaced_out_of_service.push(entry);
        continue;
      }
      if (!hasQuantityEntry(keyOf(rel), record.uid)) push(out.lines, keyOf(rel), entry);
    }
  };

  /** An order- or fulfillment-shaped viewed side against every invoice on its order. */
  const againstInvoices = (viewed: Side, orderUid: string) => {
    if (isCanceled(orderByUid.get(orderUid))) {
      for (const invoice of invoices) {
        if (invoiceScopes(invoice).includes(orderUid)) {
          out.status.push({ issue: "live_invoice_on_canceled_order", source: refOf("invoice", invoice) });
        }
      }
      return;
    }
    const coverage = coverageOf(orderUid);
    for (const invoice of invoices) {
      if (!invoiceScopes(invoice).includes(orderUid)) continue;
      if (!coverage.alignedInvoices.includes(invoice)) {
        out.unaligned.push({ scope: orderUid, source: refOf("invoice", invoice) });
        continue;
      }
      compareScope(
        out,
        viewed,
        { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) },
        orderUid,
        coverage,
        context,
        () => {},
        invoiceLegsOf(invoice, orderUid),
      );
    }
    if (coverage.alignedInvoices.length === 0) return;
    for (const [rel, item] of viewed.lines.byKey) {
      // Against invoices a fulfillment answers for its fulfillable rows only.
      if (viewed.kind === "fulfillment" && !isFulfillableItemType(item.type)) continue;
      quantityEntry(orderUid, coverage, rel, rel);
    }
    outOfServiceEntries(orderUid, coverage, (rel) => rel);
  };

  if (viewing.kind === "order") {
    const order = orderByUid.get(viewing.uid);
    if (order === undefined) return out;
    const viewed: Side = { kind: "order", doc: order, lines: scopeOrder(order) };
    const fulfillment = fulfillmentByUid.get(order.uid);
    if (fulfillment !== undefined) {
      compareScope(out, viewed, { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) }, order.uid, coverageOf(order.uid), context, () => {});
    }
    againstInvoices(viewed, order.uid);
    return out;
  }

  if (viewing.kind === "fulfillment") {
    const fulfillment = fulfillmentByUid.get(viewing.uid);
    if (fulfillment === undefined) return out;
    const viewed: Side = { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) };
    const order = orderByUid.get(fulfillment.uid);
    if (order !== undefined) {
      compareScope(out, viewed, { kind: "order", doc: order, lines: scopeOrder(order) }, order.uid, coverageOf(order.uid), context, () => {});
    }
    againstInvoices(viewed, fulfillment.uid);
    return out;
  }

  const invoice = invoices.find((i) => i.uid === viewing.uid);
  if (invoice === undefined) return out;
  for (const orderUid of invoiceScopes(invoice)) {
    const viewed: Side = { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) };
    const order = orderByUid.get(orderUid);
    // Without the order there is no path space to compare in — not even
    // against the fulfillment, which is joined THROUGH the order's paths. So
    // nothing is said, rather than calling the fulfillment unaligned.
    if (order === undefined) continue;
    const fulfillment = fulfillmentByUid.get(orderUid);
    if (isCanceled(order)) {
      out.status.push({ issue: "live_invoice_on_canceled_order", source: refOf("order", order) });
      continue;
    }
    if (!aligned(invoice, orderUid)) {
      out.unaligned.push({ scope: orderUid, source: refOf("order", order) });
      if (fulfillment !== undefined) out.unaligned.push({ scope: orderUid, source: refOf("fulfillment", fulfillment) });
      continue;
    }
    const coverage = coverageOf(orderUid);
    const viewedKey = (rel: string) => (rel === "" ? orderUid : `${orderUid}/${rel}`);
    const notInvoiced = (rel: string, k: string) => quantityEntry(orderUid, coverage, rel, k);
    const invoiceLegs = invoiceLegsOf(invoice, orderUid);
    compareScope(out, viewed, { kind: "order", doc: order, lines: scopeOrder(order) }, orderUid, coverage, context, notInvoiced, invoiceLegs);
    // Each row this invoice carries reports the sum for the order line it bills —
    // its own path, or the line a substitute replaced.
    for (const [rel, at] of coverage.invoiced.byPath) {
      for (const row of at.rows) {
        if (row.invoiceUid === invoice.uid) quantityEntry(orderUid, coverage, rel, key(row.item.path));
      }
    }
    // Invoice ↔ fulfillment goes through the order's path space, so it needs the same alignment.
    if (fulfillment !== undefined) {
      compareScope(
        out,
        viewed,
        { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) },
        orderUid,
        coverage,
        context,
        notInvoiced,
        invoiceLegs,
      );
    }
    outOfServiceEntries(orderUid, coverage, viewedKey);
  }
  return out;
}
