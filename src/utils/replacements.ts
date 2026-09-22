/**
 * Billing lost and damaged units — what a lost/damaged `out-of-service` record
 * has been billed, what is left to bill, and the lines a replacement invoice is
 * seeded with.
 *
 * ## Billed is DERIVED, never stored on the record
 *
 * An invoice line bills a record by carrying its uid
 * (`InvoiceDocLineItemType.uid_out_of_service`, valid on `type: "replacement"`
 * only). What a record has been billed is the sum of those lines' quantities
 * across every invoice that is not `void`:
 *
 * ```
 * billed(record)   = Σ line.quantity  where line.uid_out_of_service === record.uid
 *                                     and invoice.status !== "void"
 * unbilled(record) = record.quantity − billed(record)
 * ```
 *
 * So there is no marker to release when an invoice is voided or a line is
 * deleted — the sum simply stops counting it.
 *
 * ## One module, two askers
 *
 * The manager calls {@link seedReplacementLines} to OFFER the lines; the API
 * calls {@link billedOutOfService} to REFUSE an over-bill. Both read the same
 * sum, so the offer and the refusal cannot disagree.
 *
 * ⚠️ **The sum is only as complete as the invoices passed in.** A caller must
 * pass EVERY invoice whose `query_by_out_of_service` names the records in
 * question (one `array-contains-any` query per ≤30 uids). On the API side that
 * read has to be a completeness read inside the transaction that writes the
 * invoice — a partial list under-counts and admits a double bill.
 *
 * @module
 */
import { parseBookingId } from "./booking-id.ts";

/** The `out-of-service` reasons a customer is billed for. */
export const BILLABLE_OOS_REASONS: readonly ["lost", "damaged"] = ["lost", "damaged"] as const;

/** The fields of an `out-of-service` record the billing arithmetic reads. */
export interface ReplacementSourceRecord {
  uid: string;
  uid_product: string;
  reason: string;
  status: string;
  quantity: number;
  query_by_sources: readonly string[];
}

/** The fields of an invoice the billed sum reads. */
export interface ReplacementBillingInvoice {
  uid: string;
  status: string;
  items: ReadonlyArray<{ type: string; quantity?: number; uid_out_of_service?: string | null }>;
}

/** The fields of an order the seed reads. */
export interface ReplacementSourceOrder {
  uid: string;
  items: ReadonlyArray<{
    uid: string;
    type: string;
    path: readonly string[];
    price?: { replacement_cents?: number | null } | null;
  }>;
}

/** The fields of a product the seed reads — the rental and its replacement twin. */
export interface ReplacementSourceProduct {
  uid: string;
  name: string;
  uid_linked_replacement?: string | null;
  price?: { base_cents?: number | null } | null;
}

/** One replacement line to offer, before it is placed on an invoice. */
export interface ReplacementLineSeed {
  /** The record this line bills — both its provenance and its double-bill key. */
  uid_out_of_service: string;
  /** The rental product that was lost or damaged. */
  uid_rental_product: string;
  /**
   * The replacement twin to bill (`Product.uid_linked_replacement`), or `null`
   * when the rental has none — a legacy product. The line is still offered, as
   * a custom `replacement` line carrying {@link name}, so it is never silently
   * dropped; {@link warning} says why.
   */
  uid_product: string | null;
  name: string;
  /** Units still to bill: the record's quantity less what non-void invoices bill. */
  quantity: number;
  /**
   * Per-unit value in integer cents: the order line's quoted
   * `price.replacement_cents` (what the customer was told), falling back to the
   * twin's `price.base_cents`, else `0`.
   */
  base_cents: number;
  /**
   * The destination pair (leg) the unit went out on, read off the record's
   * booking source — the section of the invoice the line belongs under. `null`
   * for a record attached to the order with no booking.
   */
  uid_pair: string | null;
  reason: string;
  warning: string | null;
}

/**
 * Units billed per record, over every non-void invoice passed in.
 *
 * @param invoices - Every invoice that could bill the records in question — see
 *   the module docs for why the list must be complete.
 * @param excludeInvoiceUid - An invoice to leave out of the sum: the one being
 *   rewritten, whose NEW lines the caller adds itself.
 */
export function billedOutOfService(
  invoices: readonly ReplacementBillingInvoice[],
  excludeInvoiceUid?: string,
): Map<string, number> {
  const billed = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.status === "void" || invoice.uid === excludeInvoiceUid) continue;
    for (const item of invoice.items) {
      if (item.uid_out_of_service == null) continue;
      billed.set(item.uid_out_of_service, (billed.get(item.uid_out_of_service) ?? 0) + (item.quantity ?? 0));
    }
  }
  return billed;
}

/** Is this record a lost/damaged unit a customer can be billed for? */
export function isBillableOutOfService(record: Pick<ReplacementSourceRecord, "reason" | "status">): boolean {
  return (BILLABLE_OOS_REASONS as readonly string[]).includes(record.reason) && record.status !== "canceled";
}

/**
 * Every record whose lines would bill more than it holds, given the lines an
 * invoice is about to carry. The API's refusal: an empty result is the pass.
 *
 * @param lines - The invoice's lines as they will be written.
 * @param records - Every record those lines name.
 * @param otherInvoices - Every OTHER invoice naming those records (complete).
 */
export function overbilledOutOfService(
  lines: ReadonlyArray<{ quantity?: number; uid_out_of_service?: string | null }>,
  records: readonly Pick<ReplacementSourceRecord, "uid" | "quantity">[],
  otherInvoices: readonly ReplacementBillingInvoice[],
  invoiceUid?: string,
): Array<{ uid_out_of_service: string; quantity: number; billed_elsewhere: number; billing_here: number }> {
  const billed = billedOutOfService(otherInvoices, invoiceUid);
  const here = new Map<string, number>();
  for (const line of lines) {
    if (line.uid_out_of_service == null) continue;
    here.set(line.uid_out_of_service, (here.get(line.uid_out_of_service) ?? 0) + (line.quantity ?? 0));
  }
  const byUid = new Map(records.map((r) => [r.uid, r]));
  const out: Array<{ uid_out_of_service: string; quantity: number; billed_elsewhere: number; billing_here: number }> =
    [];
  for (const [uid, billing_here] of here) {
    const quantity = byUid.get(uid)?.quantity ?? 0;
    const billed_elsewhere = billed.get(uid) ?? 0;
    if (billed_elsewhere + billing_here > quantity) {
      out.push({ uid_out_of_service: uid, quantity, billed_elsewhere, billing_here });
    }
  }
  return out;
}

/**
 * The replacement lines to offer for one order: one per billable record sourced
 * from it with units left to bill.
 *
 * Pure — the caller supplies the records (`query_by_sources` contains
 * `orders:<uid>`), every invoice naming them, and the products (each record's
 * rental plus its linked twin). A product missing from `products` is treated
 * as having no twin.
 */
export function seedReplacementLines(
  order: ReplacementSourceOrder,
  records: readonly ReplacementSourceRecord[],
  invoices: readonly ReplacementBillingInvoice[],
  products: ReadonlyMap<string, ReplacementSourceProduct>,
): ReplacementLineSeed[] {
  const billed = billedOutOfService(invoices);
  const orderKey = `orders:${order.uid}`;
  const seeds: ReplacementLineSeed[] = [];

  for (const record of records) {
    if (!isBillableOutOfService(record) || !record.query_by_sources.includes(orderKey)) continue;
    const quantity = record.quantity - (billed.get(record.uid) ?? 0);
    if (quantity <= 0) continue;

    // The booking source names the order line and the leg the unit went out on.
    let uid_pair: string | null = null;
    let quoted: number | null = null;
    for (const source of record.query_by_sources) {
      if (!source.startsWith("bookings:")) continue;
      const parsed = parseBookingId(source.slice("bookings:".length));
      if (!parsed || parsed.orderUid !== order.uid) continue;
      uid_pair = parsed.destUid;
      const line = order.items.find((i) => i.uid === parsed.itemUid && i.path[0] === parsed.destUid);
      const cents = line?.price?.replacement_cents;
      if (typeof cents === "number" && cents > 0) quoted = cents;
      break;
    }

    const rental = products.get(record.uid_product);
    const twinUid = rental?.uid_linked_replacement ?? null;
    const twin = twinUid ? products.get(twinUid) : undefined;
    const twinCents = twin?.price?.base_cents;
    const base_cents = quoted ?? (typeof twinCents === "number" ? twinCents : 0);
    const rentalName = rental?.name ?? record.uid_product;

    seeds.push({
      uid_out_of_service: record.uid,
      uid_rental_product: record.uid_product,
      uid_product: twin ? twin.uid : null,
      name: twin ? twin.name : `Replacement: ${rentalName}`,
      quantity,
      base_cents,
      uid_pair,
      reason: record.reason,
      warning: twin ? null : `${rentalName} has no linked replacement product; billed as a custom line`,
    });
  }
  return seeds;
}
