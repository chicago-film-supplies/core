/**
 * Purchase receipt rows — why a stored receipt row exists.
 *
 * The receipt (`schemas/purchase-receipt.ts`) is the payable side's custody
 * document, the twin of the fulfillment. This module holds the receipt's twin
 * of `fulfillmentRowSources` (`utils/fulfillment-items.ts`): ONE classifier for
 * "why does this row exist", which every reader of a receipt row asks through
 * (the receiver's save, the purchase → receipt sync, the drift audit), so a new
 * kind of receipt-only row is a new member of the union rather than a branch
 * taught to some readers and not others (core#129's lesson on the fulfillment).
 *
 * @module
 */
import { isPurchaseReceiptLineItem } from "../schemas/purchase-receipt.ts";
import type { PurchaseReceiptItemType, PurchaseReceiptLineItemType } from "../schemas/purchase-receipt.ts";
import { PURCHASE_PRODUCT_ITEM_TYPES, type PurchaseStatusType } from "../schemas/purchase.ts";
import type { OrderDocDatesType } from "../schemas/order.ts";
import type { FirestoreTimestampType } from "../schemas/common.ts";
import { parseBookingId } from "./booking-id.ts";

/**
 * Why a stored receipt LINE row exists — {@link receiptRowSources}.
 *
 * | source | the row is | how it is told |
 * |---|---|---|
 * | `purchase` | the purchase's own custody line | a `sale` or `rental` purchase row is at its path |
 * | `exchange` | a unit of a receiver-staged exchange (ruling 82) | under an exchange pair the PURCHASE does not carry |
 * | `kept` | a line the purchase closed while its units were held (ruling 47) | `quantity_ordered: 0` |
 * | `receipt_extra` | a line the supplier sent that the PO lacks (ruling 35) | `quantity_ordered: null` |
 * | `unexplained` | none of these — a finding | — |
 *
 * The fulfillment's `substitution` and `invoice_projected` have no twin here:
 * nothing substitutes on a receipt, and no billing document projects onto it.
 * An exchange authored on the PURCHASE is the purchase's own row; only a
 * receipt-authored leg (a pair the purchase lacks) reads `exchange`, as on the
 * fulfillment, so the discriminator is pair MEMBERSHIP, never the `exchange`
 * field alone.
 */
export type ReceiptRowSource = "purchase" | "exchange" | "kept" | "receipt_extra" | "unexplained";

/** The purchase fields {@link receiptRowSources} reads. */
export interface ReceiptRowSourcePurchase {
  items: ReadonlyArray<{ readonly type: string; readonly path: readonly string[] }>;
  destinations: ReadonlyArray<{ readonly uid: string }>;
}

/** The receipt fields {@link receiptRowSources} reads. */
export interface ReceiptRowSourceReceipt<T extends PurchaseReceiptLineItemType> {
  items: ReadonlyArray<PurchaseReceiptItemType | T>;
  destinations: ReadonlyArray<{ readonly uid: string; readonly exchange?: unknown }>;
}

const CUSTODY_TYPES: ReadonlySet<string> = new Set(PURCHASE_PRODUCT_ITEM_TYPES);

/** `path` as a map key. `\x1f` cannot occur in a uid, so this cannot collide. */
const pathKey = (path: readonly string[]): string => path.join("\x1f");

/**
 * Classify every LINE row of a stored receipt by why it exists.
 *
 * **Precedence is the table's order**, top first: a row at a purchase custody
 * path is `purchase` whatever its `quantity_ordered` says (the sync re-stamps
 * that field later in the same transaction than the bookings read it, so it is
 * never the ownership test). Off the purchase, `quantity_ordered` is the
 * server's signature: `0` is a row the sync KEPT, `null` is a row a receiver
 * added, and a positive count names a purchase line that is not there — a sync
 * that did not run, which is the finding.
 *
 * ⚠️ **Only the purchase's `sale` and `rental` rows count**, kit headers
 * included: a `service` or `replacement` line moves no custody, so a receipt row
 * at its path is not the purchase's.
 *
 * ⚠️ **Dividers are not classified** — their survival is a placement question
 * (`placeStoredOnlyRows`), not a provenance one, as on the fulfillment.
 *
 * @param receipt - The stored receipt
 * @param purchase - The purchase it projects
 * @returns Each line row, by object identity, mapped to its source
 */
export function receiptRowSources<T extends PurchaseReceiptLineItemType>(
  receipt: ReceiptRowSourceReceipt<T>,
  purchase: ReceiptRowSourcePurchase,
): Map<T, ReceiptRowSource> {
  const purchasePaths = new Set(
    purchase.items.filter((i) => CUSTODY_TYPES.has(i.type)).map((i) => pathKey(i.path)),
  );
  const purchasePairs = new Set(purchase.destinations.map((p) => p.uid));
  const exchangeLegs = new Set(
    receipt.destinations.filter((p) => p.exchange != null && !purchasePairs.has(p.uid)).map((p) => p.uid),
  );
  const out = new Map<T, ReceiptRowSource>();
  for (const row of receipt.items) {
    if (!isPurchaseReceiptLineItem(row as PurchaseReceiptItemType)) continue;
    const line = row as T;
    const q = line.quantity_ordered;
    const source: ReceiptRowSource = purchasePaths.has(pathKey(line.path))
      ? "purchase"
      : line.path[0] !== undefined && exchangeLegs.has(line.path[0])
      ? "exchange"
      : q === 0
      ? "kept"
      : q === null
      ? "receipt_extra"
      : "unexplained";
    out.set(line, source);
  }
  return out;
}

// ── The receipt's derived fields (7a, owner 2026-11-11) ──────────────

/** The inbound booking fields the receipt derivations read. */
export interface ReceiptBookingSource {
  readonly uid: string;
  readonly type: "sale" | "rental";
  readonly breakdown: Readonly<Record<"ordered" | "transit_inbound" | "received" | "stocked" | "transit_outbound", number>>;
  readonly query_by_uid_store: readonly string[];
}

/** The purchase pair fields {@link deriveReceiptDueAt} reads. */
export interface ReceiptPairSource {
  readonly uid: string;
  /** An exchange leg folds into its PARENT's dates (C16): a purchase has one card and one due date per leg family. */
  readonly exchange?: { readonly uid_pair: string } | null;
  readonly dates: Pick<
    OrderDocDatesType,
    "delivery_start" | "delivery_start_fs" | "collection_start" | "collection_start_fs" | "collection_end" | "collection_end_fs"
  >;
}

/**
 * When a receipt is next due: the earliest open leg across its inbound
 * bookings, read off each booking's own pair (the booking id's leg segment).
 *
 * | the booking holds | it is due | at |
 * |---|---|---|
 * | units `ordered` or `transit_inbound` | to ARRIVE | `delivery_start` |
 * | a SUBRENT's units `received`, `stocked` or `transit_outbound` | to go BACK | `collection_start`, else `collection_end` |
 *
 * The receipt's twin of `deriveNextEventDate` (`utils/orders.ts`), with one
 * deliberate difference: the leg is decided PER BOOKING, not from a summed
 * breakdown, because the inbound ladder reads one key two ways by type — a
 * Buy's `stocked` is terminal, a Subrent's is held for return — so a purchase
 * rollup cannot tell a send-back from a finished buy. `collection_start` is the
 * hire end; `collection_end` is where supply ends, the later bound.
 *
 * `{ iso: null, fs: null }` on a complete or canceled purchase, and when no
 * open leg's pair states its date. The `_fs` is the winning pair's own, since
 * this module cannot mint a `Timestamp`.
 *
 * ⭐ **An exchange leg's booking is dated by its PARENT leg** (C16, ruling 82):
 * pass the receipt-authored pairs alongside the purchase's, so a receipt-staged
 * leg's units fold into the parent rather than being dropped as a booking with no
 * pair; an exchange leg's own window never drives the date. A swap unit still to
 * ARRIVE reads the parent's COLLECTION, not its delivery: the parent's arrival is
 * history, so it would pull the family's due date into the past (owner,
 * 2026-11-13).
 */
export function deriveReceiptDueAt(
  purchase: { readonly status: PurchaseStatusType; readonly destinations: readonly ReceiptPairSource[] },
  bookings: readonly ReceiptBookingSource[],
): { iso: string | null; fs: FirestoreTimestampType | null } {
  if (purchase.status !== "active") return { iso: null, fs: null };
  const byUid = new Map(purchase.destinations.map((d) => [d.uid, d]));
  const pairs = new Map(
    purchase.destinations.map((d) => [d.uid, (d.exchange ? byUid.get(d.exchange.uid_pair) : undefined) ?? d]),
  );
  let best: { t: number; iso: string; fs: FirestoreTimestampType | null } | null = null;
  const consider = (iso: string | null | undefined, fs: FirestoreTimestampType | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    if (best === null || t < best.t) best = { t, iso, fs: fs ?? null };
  };
  for (const b of bookings) {
    const leg = parseBookingId(b.uid)?.destUid;
    const pair = leg === undefined ? undefined : pairs.get(leg);
    if (!pair) continue;
    const d = pair.dates;
    const back = () => (d.collection_start ? consider(d.collection_start, d.collection_start_fs) : consider(d.collection_end, d.collection_end_fs));
    // A swap unit still to arrive on an exchange leg is not the family's next
    // event: its parent's arrival is history, and the family is due back at the
    // parent's collection (owner, 2026-11-13).
    const swap = leg !== undefined && byUid.get(leg)?.exchange != null;
    if (b.breakdown.ordered + b.breakdown.transit_inbound > 0) {
      if (swap) back();
      else consider(d.delivery_start, d.delivery_start_fs);
    }
    if (b.type === "rental" && b.breakdown.received + b.breakdown.stocked + b.breakdown.transit_outbound > 0) back();
  }
  const won = best as { iso: string; fs: FirestoreTimestampType | null } | null;
  return won === null ? { iso: null, fs: null } : { iso: won.iso, fs: won.fs };
}

/**
 * A receipt's `query_by_uid_store`: the purchase's store (where the goods come
 * to), then every store an inbound booking names, each once, in that order.
 * The purchase's store stays even after the units land elsewhere, so a store
 * that expected a delivery still finds the receipt that answers it.
 */
export function receiptQueryByUidStore(
  purchase: { readonly uid_store: string },
  bookings: readonly Pick<ReceiptBookingSource, "query_by_uid_store">[],
): string[] {
  return [...new Set([purchase.uid_store, ...bookings.flatMap((b) => b.query_by_uid_store)])];
}
