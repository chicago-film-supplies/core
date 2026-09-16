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
 * An invoice is repriced in its own context — its jurisdiction, its tax date,
 * tax versions frozen past draft — so `subtotal_cents`, `total_cents`, `taxes`
 * and `taxes_base` can differ from the order's with no operator edit and no
 * quantity split. Reporting that is G2, the false override this whole campaign
 * exists to delete, and the suppression is therefore unconditional rather than
 * gated on a split. A real change still reports through its CAUSE — a declared
 * input (`base_cents`, `base_percent`), or a discount or tax whose TERMS moved
 * ({@link termsDiffer}) — never through its arithmetic.
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
 * ## Presence AND quantity against invoices are judged on the SUM of invoices
 *
 * An order is routinely billed across several invoices, so "invoice A lacks this
 * line" says nothing when invoice B carries it, and "invoice A bills 3 of 5"
 * says nothing when invoice B bills the other 2. Asked per invoice, every line of
 * a split-billed order would read `only_here` or `differs(quantity)` against each
 * invoice. So:
 *
 * - **how much is billed** is ONE `billed` entry per line — "billed N of M", with
 *   the unbilled money for the missing units and for a date extension — computed
 *   by `billedByPath` / `accountLine` (`utils/quantityAccounting.ts`, owner
 *   decision D3). It is emitted only when something bills the line and the sum
 *   disagrees with the order, on the order, fulfillment AND invoice views;
 * - **differences in a line's TERMS** — base price, discount, taxes, formula —
 *   stay per invoice, each invoice its own source row. Where an invoice row's
 *   quantity or `chargeable_days` differ from the order's, its derived amounts
 *   (subtotals, totals, discount and tax AMOUNTS) differ as a consequence and
 *   are not reported: that money is the `billed` entry's;
 * - **a line on the order or fulfillment that NO invoice carries** is one
 *   `uninvoiced` entry naming every invoice checked — on the order, fulfillment
 *   AND invoice views;
 * - **a line a SIBLING invoice carries** produces nothing on an invoice view;
 * - **a line an invoice carries that the order or fulfillment lacks** stays per
 *   invoice (`missing_here` on the order/fulfillment view, `only_here` on the
 *   invoice view).
 *
 * `uninvoiced` is emitted only when at least one ALIGNED invoice was passed for
 * that order: an order with no invoices yet is not flagged line by line, and an
 * unaligned invoice cannot vouch for or against any line. ⚠️ The invoice view
 * therefore needs the sibling invoices passed in (`order.invoices`) — without
 * them, a line billed on a sibling reads `uninvoiced`.
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
 * (`path_substituted_for` names X's order path). Reported by presence alone,
 * that is X `only_here` + Y `missing_here` (+ X `uninvoiced` against an
 * invoice) — two or three unrelated-looking rows for one swap. Instead:
 *
 * - **the document without the swap** gets one `substituted` entry at X, and
 *   neither X's absence, Y's presence nor either subtree's is reported;
 * - **the document with the swap** gets one `substituted` entry at Y, and Y's
 *   components (which exist on no order line) are not reported;
 * - **against invoices**, an aligned invoice that substituted X covers X, so X
 *   is not `uninvoiced`.
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
 *   differences, no `uninvoiced`. There is nothing left to bill, and every line
 *   of a live invoice still matches the order's items, so a per-line comparison
 *   would read as in sync. Instead each live invoice on it is ONE
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
} from "../schemas/mod.ts";
import { isDividerItemType, isFulfillableItemType } from "../schemas/mod.ts";
import {
  canonicalizePayload,
  explainInvoiceItemDifferences,
  extensionSectionTargets,
  type InvoiceItem,
  invoiceItemDifferences,
  invoiceScopeDividersMatch,
  isInExtensionSection,
  orderInvoiceSharedFields,
  projectOrderItemToInvoiceItem,
} from "./invoices.ts";
import type { LineItem } from "./orders.ts";
import {
  collectSubstitutionAnchors,
  isInSubstitutedSubtree,
  isRemovedBySubstitution,
  type SubstitutionAnchor,
} from "./substitutions.ts";
import { accountLine, type AccountedInvoice, type BilledByPath, billedByPath } from "./quantityAccounting.ts";

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
 * - `differs` — the same path on both sides, a compared field disagrees
 * - `only_here` — on the viewed document, absent from the source
 * - `missing_here` — on the source, absent from the viewed document
 * - `pair_field` — a destination pair's compared field disagrees
 * - `uninvoiced` — an order/fulfillment line that no invoice carries
 * - `substituted` — one side carries a substitute where the other carries the line it replaced
 * - `billed` — the invoices, summed, bill a different quantity or chargeable days than the order
 */
export type DocumentDiffKind = "differs" | "only_here" | "missing_here" | "pair_field" | "uninvoiced" | "substituted" | "billed";

/** One compared field. `here` is the viewed document's value, `there` the source's. */
export interface DocumentDiffField {
  field: string;
  here: unknown;
  there: unknown;
}

/** One source's difference at one key of the viewed document. */
export interface DocumentSourceDiffEntry {
  kind: Exclude<DocumentDiffKind, "uninvoiced" | "substituted" | "billed">;
  source: DocumentRef;
  /** Empty for `only_here` / `missing_here`. */
  fields: DocumentDiffField[];
}

/**
 * A line no invoice carries. It has no single source — it is a statement about
 * all of them — so it names every invoice that was checked instead.
 */
export interface DocumentUninvoicedEntry {
  kind: "uninvoiced";
  invoices: DocumentRef[];
}

/**
 * A substitution between the viewed document and one source. Filed at
 * whichever of the two lines the viewed document carries — `replaced` on the
 * side without the swap, `substitute` on the side with it — so the entry always
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
 * "Billed N of M" — what every aligned invoice, summed, bills at one order line
 * against what the order asks for. Like `uninvoiced` it is a statement about all
 * of the invoices, so it names every one that was summed.
 *
 * Emitted only when something bills the line (nothing billing it is
 * `uninvoiced`) and the answer is not zero on both money axes. Cents are PRE-TAX
 * and signed: negative is over-billing.
 */
export interface DocumentBilledEntry {
  kind: "billed";
  invoices: DocumentRef[];
  /** The order line's quantity. */
  ordered: number;
  /** Units billed across `invoices`, substitutes counted toward the line they replaced. */
  billed: number;
  /** Pre-tax cents for the `ordered − billed` units, at the order line's current terms. */
  quantity_cents: number;
  /** Pre-tax cents the order's current chargeable days add to the rows already billed. */
  extension_cents: number;
}

/** One entry at one key of the viewed document. Discriminated on `kind`. */
export type DocumentDiffEntry = DocumentSourceDiffEntry | DocumentUninvoicedEntry | DocumentSubstitutionEntry | DocumentBilledEntry;

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
}

/** A lifecycle mismatch no per-line comparison can show. */
export type DocumentStatusIssue = "live_invoice_on_canceled_order";

/** Documents the caller holds. Any may be absent or partial. */
export interface DocumentDiffSources {
  orders?: readonly Order[];
  fulfillments?: readonly Fulfillment[];
  invoices?: readonly Invoice[];
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
  const rel: Array<{ path: string[]; path_substituted_for?: string[] }> = [];
  // A date-extension section bills days on lines the order has; its money is
  // the `billed` entry's (through `billedByPath`), so its lines are no line
  // comparison's subject.
  const extensionTargets = extensionSectionTargets(invoice.items as unknown as InvoiceItem[], orderUid);
  for (const it of invoice.items as readonly InvoiceDocItemType[]) {
    if (it.path[0] !== orderUid || isDividerItemType(it.type)) continue;
    if (isInExtensionSection(it.path, orderUid, extensionTargets)) continue;
    const relPath = it.path.slice(1);
    byKey.set(key(relPath), it as unknown as LineItem);
    rel.push({ path: relPath, path_substituted_for: (it as InvoiceItem).path_substituted_for });
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
): DocumentDiffField[] {
  const involvesFulfillment = viewed.kind === "fulfillment" || source.kind === "fulfillment";
  // Fulfillment ↔ invoice quantity is the `billed` entry's, judged against the order.
  if (involvesFulfillment && (viewed.kind === "invoice" || source.kind === "invoice")) return [];
  if (involvesFulfillment) {
    return here.quantity === there.quantity
      ? []
      : [{ field: "quantity", here: here.quantity ?? null, there: there.quantity ?? null }];
  }
  // order ↔ invoice: the badge's comparator and explanation arms, then the owner's field filter.
  const order = (viewed.kind === "order" ? viewed.doc : source.doc) as Order;
  const orderLine = viewed.kind === "order" ? here : there;
  const invoiceLine = (viewed.kind === "invoice" ? here : there) as unknown as InvoiceItem;
  const expected = projectOrderItemToInvoiceItem(orderLine, orderUid) as unknown as InvoiceItem;
  const { unexplained } = explainInvoiceItemDifferences(
    expected,
    invoiceLine,
    invoiceItemDifferences(expected, invoiceLine),
    { taxNameByUid: context.taxNameByUid, orderFrozen: context.isOrderFrozen(order) },
  );
  const derived = derivedLineFields();
  return unexplained
    // How many units and days are billed is the `billed` entry's, over the sum.
    .filter((f) => f !== "quantity" && f !== "price.chargeable_days")
    // 🔴 **A DERIVED field never produces a row on its own — this is G2, and the
    // suppression is UNCONDITIONAL.** It used to apply only when the line billed
    // a different number of units or days, on the reasoning that a split
    // explains the difference. But an invoice is repriced in its OWN context —
    // its jurisdiction, its tax date, tax versions frozen past draft — so its
    // derived money can differ from the order's with no operator edit and no
    // split at all, and reporting that is exactly the false override this whole
    // campaign exists to delete. The sync never compares a derived field; the
    // diff must not either, or the two disagree about what "overridden" means.
    //
    // What survives is the part that is NOT derived: a real change to a declared
    // input (`base_cents`, `base_percent`) reports itself, and a discount or tax
    // whose TERMS moved reports through {@link termsDiffer}. So a difference an
    // operator actually caused is still visible — through its cause rather than
    // through its arithmetic.
    .filter((f) => !derived.has(f) || termsDiffer(orderLine, invoiceLine, f))
    .map((field) => ({ field, here: readField(here, field), there: readField(there, field) }));
}

/**
 * Whether a discount or tax list differs in its TERMS — type and rate, or which
 * taxes at which rates — rather than only in the amounts a different quantity
 * or day count produces. The other derived fields have no terms apart from
 * their value.
 */
function termsDiffer(a: LineItem, b: LineItem, field: string): boolean {
  if (field === "price.discount") {
    const terms = (it: LineItem) => {
      const d = it.price?.discount;
      return d ? { type: d.type, rate: d.rate } : null;
    };
    return JSON.stringify(terms(a)) !== JSON.stringify(terms(b));
  }
  if (field === "price.taxes") {
    const terms = (it: LineItem) => (it.price?.taxes ?? []).map((t) => ({ uid: t.uid, rate: t.rate, type: t.type }));
    return JSON.stringify(terms(a)) !== JSON.stringify(terms(b));
  }
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
  billed: BilledByPath;
  invoices: DocumentRef[];
}

/** Does some aligned invoice bill this order-relative line, directly or as a substitute? */
function covers(coverage: InvoiceCoverage, rel: string): boolean {
  return coverage.billed.byPath.has(rel);
}

/** Compare the viewed side against one source side, within one order scope. */
function compareScope(
  out: DocumentDiffMap,
  viewed: Side,
  source: Side,
  orderUid: string,
  coverage: InvoiceCoverage,
  context: DocumentDiffContext,
): void {
  const sourceRef = refOf(source.kind, source.doc);
  // An invoice key carries its order-divider prefix; the others are order-relative.
  const viewedKey = (rel: string) => (viewed.kind === "invoice" ? (rel === "" ? orderUid : `${orderUid}/${rel}`) : rel);
  const uninvoiced = (rel: string) => {
    const k = viewedKey(rel);
    // One entry per key however many sources reach the same conclusion.
    if (out.lines.get(k)?.some((e) => e.kind === "uninvoiced")) return;
    push(out.lines, k, { kind: "uninvoiced", invoices: coverage.invoices });
  };

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
        substituted(rel, rel, key(theirs.path));
        continue;
      }
      if (explainedBy(viewed, source, rel) || explainedBy(source, viewed, rel)) continue;
      if (source.kind === "invoice") {
        // Presence against invoices is a question about ALL of them.
        if (mine && covers(coverage, key(mine.substitutedFor))) continue;
        if (coverage.invoices.length > 0 && !covers(coverage, rel)) uninvoiced(rel);
        continue;
      }
      push(out.lines, viewedKey(rel), { source: sourceRef, kind: "only_here", fields: [] });
      continue;
    }
    const fields = lineFields(viewed, source, here, there, orderUid, context);
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
      if (coverage.invoices.length > 0) uninvoiced(rel);
      continue;
    }
    push(out.lines, viewedKey(rel), { source: sourceRef, kind: "missing_here", fields: [] });
  }

  const pairsOf = (side: Side): Map<string, DocDestinationType> => {
    const m = new Map<string, DocDestinationType>();
    for (const p of side.doc.destinations as readonly (DocDestinationType | InvoiceDocDestinationType)[]) {
      if (side.kind === "invoice" && (p as InvoiceDocDestinationType).uid_order !== orderUid) continue;
      m.set(p.uid, p);
    }
    return m;
  };
  const sourcePairs = pairsOf(source);
  for (const [uid, here] of pairsOf(viewed)) {
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
  const out: DocumentDiffMap = { lines: new Map(), pairs: new Map(), unaligned: [], status: [] };
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

  /** Every aligned invoice passed for `orderUid`, with what they bill summed per line. */
  const coverageOf = (orderUid: string): InvoiceCoverage & { alignedInvoices: Invoice[] } => {
    const refs: DocumentRef[] = [];
    const alignedInvoices: Invoice[] = [];
    for (const invoice of invoices) {
      if (!invoiceScopes(invoice).includes(orderUid) || !aligned(invoice, orderUid)) continue;
      alignedInvoices.push(invoice);
      refs.push(refOf("invoice", invoice));
    }
    const billed = billedByPath(
      orderUid,
      (orderByUid.get(orderUid)?.items ?? []) as unknown as LineItem[],
      alignedInvoices as unknown as AccountedInvoice[],
    );
    return { billed, invoices: refs, alignedInvoices };
  };

  /**
   * One `billed` entry at `viewedKey` for the order line at `rel`, when the
   * summed invoices bill it and disagree with the order. Nothing billing it at
   * all is `uninvoiced`, not this.
   */
  const billedEntry = (orderUid: string, coverage: InvoiceCoverage, rel: string, viewedKey: string) => {
    const order = orderByUid.get(orderUid);
    const at = coverage.billed.byPath.get(rel);
    if (order === undefined || at === undefined) return;
    const orderLine = scopeOrder(order).byKey.get(rel);
    if (orderLine === undefined) return;
    const account = accountLine(orderLine, at);
    if (account.quantity === 0 && account.extension_cents === 0) return;
    if (out.lines.get(viewedKey)?.some((e) => e.kind === "billed")) return;
    push(out.lines, viewedKey, {
      kind: "billed",
      invoices: coverage.invoices,
      ordered: account.ordered,
      billed: account.billed,
      quantity_cents: account.quantity_cents,
      extension_cents: account.extension_cents,
    });
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
      compareScope(out, viewed, { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) }, orderUid, coverage, context);
    }
    const order = orderByUid.get(orderUid);
    if (order === undefined || coverage.alignedInvoices.length === 0) return;
    const orderSide: Side = { kind: "order", doc: order, lines: scopeOrder(order) };
    for (const [rel, item] of viewed.lines.byKey) {
      if (!comparable(viewed, orderSide, item)) continue;
      billedEntry(orderUid, coverage, rel, rel);
    }
  };

  if (viewing.kind === "order") {
    const order = orderByUid.get(viewing.uid);
    if (order === undefined) return out;
    const viewed: Side = { kind: "order", doc: order, lines: scopeOrder(order) };
    const fulfillment = fulfillmentByUid.get(order.uid);
    if (fulfillment !== undefined) {
      compareScope(out, viewed, { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) }, order.uid, coverageOf(order.uid), context);
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
      compareScope(out, viewed, { kind: "order", doc: order, lines: scopeOrder(order) }, order.uid, coverageOf(order.uid), context);
    }
    againstInvoices(viewed, fulfillment.uid);
    return out;
  }

  const invoice = invoices.find((i) => i.uid === viewing.uid);
  if (invoice === undefined) return out;
  for (const orderUid of invoiceScopes(invoice)) {
    const viewed: Side = { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) };
    const order = orderByUid.get(orderUid);
    const fulfillment = fulfillmentByUid.get(orderUid);
    if (order !== undefined && isCanceled(order)) {
      out.status.push({ issue: "live_invoice_on_canceled_order", source: refOf("order", order) });
      continue;
    }
    if (!aligned(invoice, orderUid)) {
      if (order !== undefined) out.unaligned.push({ scope: orderUid, source: refOf("order", order) });
      if (fulfillment !== undefined) out.unaligned.push({ scope: orderUid, source: refOf("fulfillment", fulfillment) });
      continue;
    }
    const coverage = coverageOf(orderUid);
    compareScope(out, viewed, { kind: "order", doc: order!, lines: scopeOrder(order!) }, orderUid, coverage, context);
    // Each row this invoice carries reports the sum for the order line it bills —
    // its own path, or the line a substitute replaced.
    for (const [rel, at] of coverage.billed.byPath) {
      for (const row of at.rows) {
        if (row.invoiceUid === invoice.uid) billedEntry(orderUid, coverage, rel, key(row.item.path));
      }
    }
    // Invoice ↔ fulfillment goes through the order's path space, so it needs the same alignment.
    if (fulfillment !== undefined) {
      compareScope(out, viewed, { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) }, orderUid, coverage, context);
    }
  }
  return out;
}
