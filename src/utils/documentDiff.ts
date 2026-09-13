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
 * ## What is compared (owner decision, 2026-09-13)
 *
 * **Money, quantity and dates only.** Labels (`name`, `description`), `type`,
 * `taxed_as` and `price.taxes_base` never produce an entry: on prod the label
 * differences alone put rows on hundreds of settled invoices whose catalog names
 * moved after invoicing, and `taxes_base` is not money. A fulfillment carries no
 * price, so every comparison with a fulfillment is quantity and existence only.
 * Destination pairs compare `dates` and `jurisdiction`.
 *
 * Order ↔ invoice line differences go through
 * {@link invoiceItemDifferences} + {@link explainInvoiceItemDifferences} FIRST
 * and are filtered to the compared fields SECOND — the explanation arms are the
 * sync badge's, reused rather than restated, so this can never report a
 * difference the badge has explained away.
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
  type InvoiceItem,
  invoiceItemDifferences,
  invoiceScopeDividersMatch,
  projectOrderItemToInvoiceItem,
} from "./invoices.ts";
import type { LineItem } from "./orders.ts";
import { collectSubstitutionAnchors, isRemovedBySubstitution, type SubstitutionAnchor } from "./substitutions.ts";

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
 */
export type DocumentDiffKind = "differs" | "only_here" | "missing_here" | "pair_field";

/** One compared field. `here` is the viewed document's value, `there` the source's. */
export interface DocumentDiffField {
  field: string;
  here: unknown;
  there: unknown;
}

/** One source's difference at one key of the viewed document. */
export interface DocumentDiffEntry {
  source: DocumentRef;
  kind: DocumentDiffKind;
  /** Empty for `only_here` / `missing_here`. */
  fields: DocumentDiffField[];
}

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
}

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

/** The line fields that produce a `differs` entry. `price` covers a wholly-missing price object. */
const COMPARED_LINE_FIELDS: ReadonlySet<string> = new Set([
  "quantity",
  "price",
  "price.base_cents",
  "price.base_percent",
  "price.chargeable_days",
  "price.discount",
  "price.subtotal_cents",
  "price.subtotal_discounted_cents",
  "price.taxes",
  "price.total_cents",
]);

/** The destination-pair fields that produce a `pair_field` entry. */
const COMPARED_PAIR_FIELDS = ["dates", "jurisdiction"] as const;

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
  for (const it of invoice.items as readonly InvoiceDocItemType[]) {
    if (it.path[0] !== orderUid || isDividerItemType(it.type)) continue;
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
  return unexplained
    .filter((f) => COMPARED_LINE_FIELDS.has(f))
    .map((field) => ({ field, here: readField(here, field), there: readField(there, field) }));
}

function push<K>(map: Map<K, DocumentDiffEntry[]>, k: K, entry: DocumentDiffEntry): void {
  const list = map.get(k);
  if (list) list.push(entry);
  else map.set(k, [entry]);
}

/** Compare the viewed side against one source side, within one order scope. */
function compareScope(
  out: DocumentDiffMap,
  viewed: Side,
  source: Side,
  orderUid: string,
  context: DocumentDiffContext,
): void {
  const sourceRef = refOf(source.kind, source.doc);
  // An invoice key carries its order-divider prefix; the others are order-relative.
  const viewedKey = (rel: string) => (viewed.kind === "invoice" ? (rel === "" ? orderUid : `${orderUid}/${rel}`) : rel);

  for (const [rel, here] of viewed.lines.byKey) {
    if (!comparable(viewed, source, here)) continue;
    const there = source.lines.byKey.get(rel);
    if (there === undefined) {
      push(out.lines, viewedKey(rel), { source: sourceRef, kind: "only_here", fields: [] });
      continue;
    }
    const fields = lineFields(viewed, source, here, there, orderUid, context);
    if (fields.length > 0) push(out.lines, viewedKey(rel), { source: sourceRef, kind: "differs", fields });
  }
  for (const [rel, there] of source.lines.byKey) {
    if (viewed.lines.byKey.has(rel) || !comparable(source, viewed, there)) continue;
    // A line the viewed document substituted away is explained by the substitute's own `only_here`.
    if (isRemovedBySubstitution(rel.split("/"), viewed.lines.anchors)) continue;
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
    const fields: DocumentDiffField[] = [];
    for (const field of COMPARED_PAIR_FIELDS) {
      const h = (here as unknown as Record<string, unknown>)[field] ?? null;
      const t = (there as unknown as Record<string, unknown>)[field] ?? null;
      if (JSON.stringify(canonicalizePayload(h)) !== JSON.stringify(canonicalizePayload(t))) {
        fields.push({ field, here: h, there: t });
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
  const out: DocumentDiffMap = { lines: new Map(), pairs: new Map(), unaligned: [] };
  const orders = sources.orders ?? [];
  const fulfillments = sources.fulfillments ?? [];
  const invoices = sources.invoices ?? [];
  const orderByUid = new Map(orders.map((o) => [o.uid, o]));
  const fulfillmentByUid = new Map(fulfillments.map((f) => [f.uid, f]));

  /** Compare an order-or-fulfillment-shaped viewed side against every other document on its order. */
  const againstInvoices = (viewed: Side, orderUid: string) => {
    const order = orderByUid.get(orderUid);
    for (const invoice of invoices) {
      if (!invoiceScopes(invoice).includes(orderUid)) continue;
      const invoiceRef = refOf("invoice", invoice);
      const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid);
      // Alignment is a fact about the invoice and its ORDER; without the order it cannot be asked.
      if (order === undefined || !invoiceScopeDividersMatch(scoped as unknown as InvoiceItem[], order.items as unknown as LineItem[], orderUid)) {
        out.unaligned.push({ scope: orderUid, source: invoiceRef });
        continue;
      }
      compareScope(out, viewed, { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) }, orderUid, context);
    }
  };

  if (viewing.kind === "order") {
    const order = orderByUid.get(viewing.uid);
    if (order === undefined) return out;
    const viewed: Side = { kind: "order", doc: order, lines: scopeOrder(order) };
    const fulfillment = fulfillmentByUid.get(order.uid);
    if (fulfillment !== undefined) {
      compareScope(out, viewed, { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) }, order.uid, context);
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
      compareScope(out, viewed, { kind: "order", doc: order, lines: scopeOrder(order) }, order.uid, context);
    }
    againstInvoices(viewed, fulfillment.uid);
    return out;
  }

  const invoice = invoices.find((i) => i.uid === viewing.uid);
  if (invoice === undefined) return out;
  for (const orderUid of invoiceScopes(invoice)) {
    const viewed: Side = { kind: "invoice", doc: invoice, lines: scopeInvoice(invoice, orderUid) };
    const order = orderByUid.get(orderUid);
    const scoped = (invoice.items as readonly InvoiceDocItemType[]).filter((it) => it.path[0] === orderUid);
    const aligned = order !== undefined &&
      invoiceScopeDividersMatch(scoped as unknown as InvoiceItem[], order.items as unknown as LineItem[], orderUid);
    if (order !== undefined) {
      if (aligned) compareScope(out, viewed, { kind: "order", doc: order, lines: scopeOrder(order) }, orderUid, context);
      else out.unaligned.push({ scope: orderUid, source: refOf("order", order) });
    }
    const fulfillment = fulfillmentByUid.get(orderUid);
    if (fulfillment !== undefined) {
      // Invoice ↔ fulfillment goes through the order's path space, so it needs the same alignment.
      if (aligned) compareScope(out, viewed, { kind: "fulfillment", doc: fulfillment, lines: scopeFulfillment(fulfillment) }, orderUid, context);
      else out.unaligned.push({ scope: orderUid, source: refOf("fulfillment", fulfillment) });
    }
  }
  return out;
}
