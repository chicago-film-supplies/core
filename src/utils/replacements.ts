/**
 * Billing out-of-service units — what an `out-of-service` record has been
 * billed, what is left to bill, and the lines a replacement invoice is seeded
 * with. A lost or damaged unit bills as a `replacement` line, offered by
 * default; a cleaning or maintenance one bills as a `service` line, on request
 * ({@link OOS_BILLING_POLICY}).
 *
 * ## Billed is DERIVED, never stored on the record
 *
 * An invoice line bills a record by carrying its uid
 * (`InvoiceDocLineItemType.uid_out_of_service`, valid on `type: "replacement"`
 * and `type: "service"`). What a record has been billed is the sum of those lines' quantities
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
 * calls {@link overbilledOutOfService} to WARN of an over-bill — an advisory
 * `overbilled_out_of_service` in the response and an `oos_overbilled` log line,
 * never a refusal (api-cloudrun#1147: the invoice is what is billed, and the
 * operator may bill past the record). Both read the same sum, so the offer and
 * the warning cannot disagree. `computeDocumentDiffs` reads it too, for a
 * record's `invoiced` figure.
 *
 * ⚠️ **The sum is only as complete as the invoices passed in.** A caller must
 * pass EVERY invoice whose `query_by_out_of_service` names the records in
 * question (one `array-contains-any` query per ≤30 uids). A partial list
 * under-counts: the offer re-offers units already billed, and the warning
 * misses a double bill.
 *
 * @module
 */
import { componentSignatureHash, parseBookingId } from "./booking-id.ts";
import type { OOSReasonType } from "../schemas/common.ts";

/** The `out-of-service` reasons a customer is billed for. */
export const BILLABLE_OOS_REASONS: readonly ["lost", "damaged"] = ["lost", "damaged"] as const;

/** How one out-of-service reason is billed. */
export interface OosBillingPolicy {
  /** The invoice line `type` that bills a record of this reason. */
  line_type: "replacement" | "service";
  /**
   * `default` — the manager offers the line unasked (a lost or damaged unit is
   * always charged). `on_request` — nothing is offered or flagged until an
   * operator asks, because most cleaning and maintenance is not billed.
   */
  offer: "default" | "on_request";
}

/**
 * The billing policy per `out-of-service` reason — total, so a fifth reason is
 * a compile error here rather than a record nobody can bill.
 *
 * ⚠️ **The pairing is the API's to enforce, not the schema's**: the invoice
 * line refine sees a line's `type` but never its record's `reason`.
 * {@link BILLABLE_OOS_REASONS} stays the DEFAULT-offered set — the offer's
 * query and the document diff's "fulfilled but not invoiced" flag read it, and
 * widening it would flag every cleaning record as unbilled.
 */
export const OOS_BILLING_POLICY: Record<OOSReasonType, OosBillingPolicy> = {
  lost: { line_type: "replacement", offer: "default" },
  damaged: { line_type: "replacement", offer: "default" },
  cleaning: { line_type: "service", offer: "on_request" },
  maintenance: { line_type: "service", offer: "on_request" },
};

/** The invoice line `type` that bills a record of this reason. */
export function oosLineTypeFor(reason: OOSReasonType): "replacement" | "service" {
  return OOS_BILLING_POLICY[reason].line_type;
}

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

/** Is this record a cleaning/maintenance unit an operator can ask to bill? */
export function isOnRequestBillableOutOfService(
  record: Pick<ReplacementSourceRecord, "reason" | "status">,
): boolean {
  const policy = (OOS_BILLING_POLICY as Record<string, OosBillingPolicy | undefined>)[record.reason];
  return policy?.offer === "on_request" && record.status !== "canceled";
}

/**
 * Every record whose lines would bill more than it holds, given the lines an
 * invoice is about to carry. The API's over-bill advisory: an empty result
 * means nothing to warn about. It never refuses a write (api-cloudrun#1147).
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
 * The leg a record's unit went out on, and the replacement value the order
 * quoted for its line — both read off the record's FIRST booking source for
 * this order. `uid_pair` is `null` for a record attached to the order with no
 * booking; `quoted` is `null` when the line quoted no replacement value.
 */
function bookingSourceOf(
  order: ReplacementSourceOrder,
  record: Pick<ReplacementSourceRecord, "query_by_sources">,
): { uid_pair: string | null; quoted: number | null } {
  let uid_pair: string | null = null;
  let quoted: number | null = null;
  for (const source of record.query_by_sources) {
    if (!source.startsWith("bookings:")) continue;
    const parsed = parseBookingId(source.slice("bookings:".length));
    if (!parsed || parsed.orderUid !== order.uid) continue;
    uid_pair = parsed.destUid;
    // The signature too, not just (uid, leg): one product standalone and inside
    // a kit on one leg are two bookings and two lines, and only the signature
    // tells them apart — matching on uid quoted the first copy's replacement
    // value for the other's record (core#129).
    const line = order.items.find((i) =>
      i.uid === parsed.itemUid && i.path[0] === parsed.destUid &&
      componentSignatureHash(i.path) === parsed.signatureHash
    );
    const cents = line?.price?.replacement_cents;
    if (typeof cents === "number" && cents > 0) quoted = cents;
    break;
  }
  return { uid_pair, quoted };
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

    const { uid_pair, quoted } = bookingSourceOf(order, record);

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

/** The reason → charge-product map (`BillingSettings.oos_charge_products`). */
export interface OnRequestChargeProducts {
  cleaning: string | null;
  maintenance: string | null;
}

/** One cleaning/maintenance service line to offer, before it is placed on an invoice. */
export interface OnRequestLineSeed {
  /** The record this line bills — both its provenance and its double-bill key. */
  uid_out_of_service: string;
  /** The `service` product that bills this reason (`settings/billing`). */
  uid_product: string;
  /** That product's name — "Cleaning" or "Maintenance". */
  name: string;
  /** The unit that was cleaned or maintained, for the line's description. */
  rental_name: string;
  /** Units still to bill: the record's quantity less what non-void invoices bill. */
  quantity: number;
  /** Always `0`: the product is `$0` and the operator prices the line. */
  base_cents: 0;
  /** The leg the unit went out on; `null` for a record with no booking. */
  uid_pair: string | null;
  reason: string;
}

/**
 * The cleaning/maintenance service lines to offer for one order: one per
 * on-request record sourced from it with units left to bill, whose reason has a
 * resolvable charge product.
 *
 * ⚠️ **A reason whose product is unset (`null`), or set to a product missing
 * from `products`, yields NO seed** — the action hides rather than failing an
 * invoice (api-cloudrun#1163). That differs from {@link seedReplacementLines},
 * which offers a custom line when a twin is missing: a lost unit is always
 * owed, a cleaning charge is only ever offered.
 *
 * Pure — same inputs as {@link seedReplacementLines} plus the settings map. The
 * caller supplies the charge products and each record's rental in `products`.
 */
export function seedOnRequestLines(
  order: ReplacementSourceOrder,
  records: readonly ReplacementSourceRecord[],
  invoices: readonly ReplacementBillingInvoice[],
  charge: OnRequestChargeProducts,
  products: ReadonlyMap<string, ReplacementSourceProduct>,
): OnRequestLineSeed[] {
  const billed = billedOutOfService(invoices);
  const orderKey = `orders:${order.uid}`;
  const seeds: OnRequestLineSeed[] = [];

  for (const record of records) {
    if (!isOnRequestBillableOutOfService(record) || !record.query_by_sources.includes(orderKey)) continue;
    const productUid = record.reason === "cleaning"
      ? charge.cleaning
      : record.reason === "maintenance"
      ? charge.maintenance
      : null;
    const product = productUid ? products.get(productUid) : undefined;
    if (!productUid || !product) continue;

    const quantity = record.quantity - (billed.get(record.uid) ?? 0);
    if (quantity <= 0) continue;

    seeds.push({
      uid_out_of_service: record.uid,
      uid_product: productUid,
      name: product.name,
      rental_name: products.get(record.uid_product)?.name ?? record.uid_product,
      quantity,
      base_cents: 0,
      uid_pair: bookingSourceOf(order, record).uid_pair,
      reason: record.reason,
    });
  }
  return seeds;
}
