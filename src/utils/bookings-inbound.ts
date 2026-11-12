/**
 * The inbound booking ladder's derivations: the projection of a purchase line
 * onto its inbound booking, the booking's own status, the PURCHASE's status
 * read off its inbound bookings, and the cancel refusal — each the twin of an
 * outbound function in `utils/bookings.ts`
 * (`api-cloudrun/.claude/plans/one-document-model.md` § *7a core spec*, C6–C7).
 *
 * ⭐ **Each ladder has its own function; nothing branches on side** (C6). The
 * per-type key sets are the predicates in `schemas/_inbound-breakdown.ts`
 * (`isInboundTerminal`, `isInboundLive`), never a table keyed here.
 *
 * @module
 */
import {
  emptyInboundBreakdown,
  INBOUND_BREAKDOWN_KEYS,
  INBOUND_HISTORY_KEYS,
  INBOUND_RECEIVED_KEYS,
  INBOUND_RETURNED_KEYS,
  type InboundBooking,
  type InboundBookingStatusType,
  type InboundBookingTypeType,
  type InboundBreakdown,
  type InboundBreakdownKeyType,
  isInboundLive,
  isInboundTerminal,
  type MovementCustodyType,
  PURCHASE_STATUS_TRAITS,
  type PurchaseStatusType,
} from "../schemas/mod.ts";

/** Σ of an inbound breakdown, over every key — never spelled key by key. */
export function sumInboundBreakdown(b: InboundBreakdown): number {
  let n = 0;
  for (const key of INBOUND_BREAKDOWN_KEYS) n += b[key];
  return n;
}

function sumKeys(b: InboundBreakdown, keys: readonly InboundBreakdownKeyType[]): number {
  let n = 0;
  for (const key of keys) n += b[key];
  return n;
}

// ── Received and returned, derived (C8) ─────────────────────────────

/**
 * What a purchase line has received and returned — the two co-written buckets
 * `quantity_received` / `quantity_returned` retired by one-document-model C8,
 * now DERIVED from custody. Per GRAIN they are an inbound booking's
 * ({@link inboundCustodyCounts}); per LINE they are the net custody of the
 * movements naming that row ({@link custodyBySourceItem}, ruling 65), because
 * two lines may share one booking.
 */
export interface PurchaseLineCustody {
  /** Units that have arrived: Σ {@link INBOUND_RECEIVED_KEYS}. */
  received: number;
  /** Units no longer owed to the supplier: Σ {@link INBOUND_RETURNED_KEYS}. Read on a Subrent only. */
  returned: number;
}

/** No custody at all: a line nothing has been received for. */
export const NO_LINE_CUSTODY: PurchaseLineCustody = Object.freeze({ received: 0, returned: 0 });

/** Units an inbound breakdown holds as received: Σ {@link INBOUND_RECEIVED_KEYS}. */
export function inboundReceived(b: InboundBreakdown): number {
  return sumKeys(b, INBOUND_RECEIVED_KEYS);
}

/** Units an inbound breakdown holds as no longer owed: Σ {@link INBOUND_RETURNED_KEYS}. */
export function inboundReturned(b: InboundBreakdown): number {
  return sumKeys(b, INBOUND_RETURNED_KEYS);
}

/** Both counts of one breakdown — a booking's, or a row's net custody. */
export function inboundCustodyCounts(b: InboundBreakdown): PurchaseLineCustody {
  return { received: inboundReceived(b), returned: inboundReturned(b) };
}

/** A movement as {@link custodyBySourceItem} reads it. */
export interface SourceItemMovement {
  path_source_item?: readonly string[] | null;
  custody: MovementCustodyType | null;
  quantity: number;
}

const INBOUND_HISTORY: ReadonlySet<string> = new Set(INBOUND_HISTORY_KEYS);

/**
 * **Each purchase row's custody, from the journal** (ruling 65): the net of
 * every movement naming the row in `path_source_item`, keyed by the path
 * joined with `/`, then read as {@link PurchaseLineCustody}.
 *
 * A movement adds its quantity to its custody `to` key and takes it from its
 * `from` key, plan keys contributing nothing — the per-booking replay's rule
 * (`custodyByBooking`), applied per row. A `reverses` reversal carries its
 * original's pair swapped, and a typed undo the mirrored pair, so both net out
 * with no sign of their own. A movement with no row or no custody (a lineless
 * annotation, an outbound step) is skipped.
 *
 * ⚠️ **Pass ONE purchase's movements.** A path is a row identity within one
 * document only (`cfs-items`); the caller scopes the read, as every writer
 * already does by `sources array-contains {purchases, uid}`.
 */
export function custodyBySourceItem(movements: readonly SourceItemMovement[]): Map<string, PurchaseLineCustody> {
  const nets = new Map<string, InboundBreakdown>();
  for (const m of movements) {
    if (!m.path_source_item || !m.custody) continue;
    const key = m.path_source_item.join("/");
    const net = nets.get(key) ?? emptyInboundBreakdown();
    const { from, to } = m.custody;
    if (to !== null && INBOUND_HISTORY.has(to)) net[to as InboundBreakdownKeyType] += m.quantity;
    if (from !== null && INBOUND_HISTORY.has(from)) net[from as InboundBreakdownKeyType] -= m.quantity;
    nets.set(key, net);
  }
  return new Map([...nets].map(([key, net]) => [key, inboundCustodyCounts(net)]));
}

/** One row's custody from a {@link custodyBySourceItem} map — none when no movement names it. */
export function lineCustodyAt(
  custody: ReadonlyMap<string, PurchaseLineCustody>,
  path: readonly string[],
): PurchaseLineCustody {
  return custody.get(path.join("/")) ?? NO_LINE_CUSTODY;
}

/** The history keys only, every plan key at zero: what custody a booking has REACHED. */
function carriedCustody(prev: InboundBreakdown): InboundBreakdown {
  const out = emptyInboundBreakdown();
  for (const key of INBOUND_HISTORY_KEYS) out[key] = prev[key];
  return out;
}

/**
 * Project an inbound booking's breakdown for a PURCHASE status, line type and
 * quantity — the twin of `calculateBookingBreakdown`, over
 * {@link PURCHASE_STATUS_TRAITS} as that one reads `ORDER_STATUS_TRAITS`.
 *
 * ONE rule: carry every history key as it stands and put the rest of the
 * quantity in the status's plan bucket.
 *
 * | purchase status | breakdown |
 * |---|---|
 * | `active` / `complete` | `ordered` = quantity − carried, floored at 0 |
 * | `canceled` | custody kept, no plan (the outbound `keepCustodyOnly` arm) |
 *
 * There is no `draft` (ruling 56: a purchase being written exists only in the
 * client). A `complete` purchase raised past what came books the raise as
 * `ordered`, and the purchase re-derives `active` ({@link derivePurchaseStatus}).
 *
 * The open bucket is floored at zero, so the result sums to `max(quantity,
 * carried)`: an over-receipt keeps its units, and `quantity` (the PHYSICAL
 * number) follows the breakdown rather than the paperwork.
 */
export function calculateInboundBreakdown(
  status: PurchaseStatusType,
  _type: InboundBookingTypeType,
  quantity: number,
  existing?: InboundBreakdown,
): InboundBreakdown {
  const carried = carriedCustody(existing ?? emptyInboundBreakdown());
  const plan = PURCHASE_STATUS_TRAITS[status].planBucket;
  if (plan === null) return carried;
  return { ...carried, [plan]: Math.max(0, quantity - sumInboundBreakdown(carried)) };
}

/** Keys an inbound booking of `type` still has work in: neither plan-free nor terminal. */
function openKeysFor(type: InboundBookingTypeType): InboundBreakdownKeyType[] {
  return INBOUND_BREAKDOWN_KEYS.filter((k) => !isInboundTerminal(type, k));
}

/**
 * Per-booking closure rule: every unit sits in a TERMINAL key for its type
 * (`isInboundTerminal`). A Buy closes on a shelf or damaged; a Subrent once
 * every unit is back with its supplier or settled lost or damaged — a rented
 * unit on a CFS shelf holds the booking open. A booking holding nothing is
 * closed.
 */
export function isInboundBookingClosed(b: Pick<InboundBooking, "type" | "breakdown">): boolean {
  return sumKeys(b.breakdown, openKeysFor(b.type)) === 0;
}

/**
 * Units physically moving or in CFS's hands and not at an end: the
 * `isInboundLive` keys for the booking's type. The twin of `liveCustody`.
 */
export function inboundLiveCustody(b: Pick<InboundBooking, "type" | "breakdown">): number {
  return sumKeys(b.breakdown, INBOUND_BREAKDOWN_KEYS.filter((k) => isInboundLive(b.type, k)));
}

/**
 * An inbound booking's status, read off its breakdown — never sent:
 * `complete` when closed ({@link isInboundBookingClosed}), else `ordered` while
 * no unit has left the plan, else `active`.
 */
export function deriveInboundBookingStatus(
  b: Pick<InboundBooking, "type" | "breakdown">,
): InboundBookingStatusType {
  if (isInboundBookingClosed(b)) return "complete";
  return sumKeys(b.breakdown, INBOUND_HISTORY_KEYS) === 0 ? "ordered" : "active";
}

/**
 * A purchase's status, custody-only (rulings 55, 56, 61): the operator's
 * `canceled` stands; otherwise `complete` when every inbound booking is closed,
 * else `active`. Billing holds nothing open: an unbilled line surfaces through
 * the remaining-to-bill engine and the diff (ruling 42), not here.
 *
 * | stored | status |
 * |---|---|
 * | `canceled` | `canceled`, always (an operator cancel, refused while custody is live: {@link inboundCancelRefusal}) |
 * | `active` / `complete` | `complete` when every inbound booking is closed, else `active` |
 *
 * ⚠️ **A purchase that books nothing is `complete` (ruling 61)** — a PO of only
 * Charge lines, or one whose every line was closed to 0. That is the one
 * deliberate divergence from `deriveOrderStatus`, which keeps the STORED status
 * when the order books nothing: an order's `complete` can be operator-reached,
 * a purchase's cannot, so there is no stored value worth keeping.
 *
 * Its guard that "kept bookings alone never complete the parent" collapses here
 * by the same ruling: a KEPT inbound booking (`quantity_ordered: 0`, its line
 * closed with units in hand) holds the purchase open exactly while it is open,
 * and once closed, a purchase of only kept bookings books nothing.
 *
 * The status reads ANOTHER collection, so the writer that finalizes the
 * purchase's bookings writes it, as `finalizeOrderBookings` writes an order's.
 */
export function derivePurchaseStatus(
  stored: PurchaseStatusType,
  bookings: ReadonlyArray<Pick<InboundBooking, "type" | "breakdown">>,
): PurchaseStatusType {
  if (PURCHASE_STATUS_TRAITS[stored].authored) return stored;
  return bookings.every(isInboundBookingClosed) ? "complete" : "active";
}

/** One inbound booking that blocks a purchase cancel, and what it still holds. */
export interface InboundCancelBlocker {
  uid: string;
  /** Live units per key (`isInboundLive`), zero keys omitted. */
  live: Partial<Record<InboundBreakdownKeyType, number>>;
}

/**
 * Why a purchase may not be canceled yet, or `null` when it may — the twin of
 * `cancelRefusal`. Refused while any inbound booking holds LIVE custody
 * (`inboundLiveCustody`): a Buy's units arriving or in receiving, and a
 * Subrent's anywhere in CFS's hands, rented units on a shelf included. They go
 * back to the supplier, or the receipt is undone, first, each an ordinary
 * custody step with its movement.
 */
export function inboundCancelRefusal(
  bookings: ReadonlyArray<Pick<InboundBooking, "uid" | "type" | "breakdown">>,
): { message: string; bookings: InboundCancelBlocker[] } | null {
  const blockers: InboundCancelBlocker[] = [];
  let units = 0;
  for (const b of bookings) {
    const live: Partial<Record<InboundBreakdownKeyType, number>> = {};
    for (const key of INBOUND_BREAKDOWN_KEYS) {
      if (isInboundLive(b.type, key) && b.breakdown[key] > 0) live[key] = b.breakdown[key];
    }
    const n = inboundLiveCustody(b);
    if (n === 0) continue;
    units += n;
    blockers.push({ uid: b.uid, live });
  }
  if (blockers.length === 0) return null;
  return {
    message: `${units} unit(s) on ${blockers.length} inbound booking(s) are arriving or in CFS's hands — ` +
      `send them back or undo the receipt before canceling (${blockers.map((b) => b.uid).join(", ")})`,
    bookings: blockers,
  };
}
