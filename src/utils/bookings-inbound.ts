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
  type InboundBookingActionType,
  inboundCustodyRule,
  type InboundCustodyRuleId,
  type InboundServiceSide,
  INBOUND_UNIT_BUCKETS,
  type InboundUnitBucketType,
  type InboundUnitSetsType,
  type MovementTypeType,
  type OOSReasonType,
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
import { CustodyRefusal } from "./custody.ts";
import { buildBookingIdFromSignature, componentSignatureHash } from "./booking-id.ts";

/** Σ of an inbound breakdown, over every key — never spelled key by key. */
export function sumInboundBreakdown(b: InboundBreakdown): number {
  let n = 0;
  for (const key of INBOUND_BREAKDOWN_KEYS) n += b[key];
  return n;
}

/**
 * The inbound booking a purchase row books into: `{purchase}:{product}:{leg}[:{sig}]`.
 * The leg is the row's destination divider (`path[0]`), never an address; the
 * product is the row's uid (ruling 12: a payable catalog line's uid is its
 * product's). The ONE author of that mapping, read by the api's reconcile and
 * by the manager's receipt actions, so the two cannot address different grains.
 * Two rows of one product, leg and component ancestry share a booking (ruling 65).
 */
export function inboundBookingIdFor(purchaseUid: string, row: { uid: string; path: readonly string[] }): string {
  return buildBookingIdFromSignature(purchaseUid, row.uid, row.path[0], componentSignatureHash(row.path));
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

// ── apply: the inbound lever's pure half (W3) ───────────────────────

/** An inbound booking as {@link applyInboundCustodyActions} reads it. */
export type InboundCustodyBooking =
  & Pick<InboundBooking, "type" | "breakdown">
  & Partial<Pick<InboundBooking, "units">>;

/** One movement's worth of inbound custody change — the twin of `CustodyTransition`. */
export interface InboundCustodyTransition {
  rule: InboundCustodyRuleId;
  type: MovementTypeType;
  from: InboundBreakdownKeyType;
  to: InboundBreakdownKeyType;
  quantity: number;
  /** The flag or settle's service axis; `null` off those rows. */
  service: { from: OOSReasonType | null; to: OOSReasonType | null } | null;
  /** The units the action named, ascending by number; `[]` when it named none. */
  units: number[];
  /** The purchase row the step acts for (ruling 65). */
  path_source_item: string[];
}

/** What a list of inbound actions does to a booking — the twin of `CustodyApplication`. */
export interface InboundCustodyApplication {
  breakdown: InboundBreakdown;
  status: InboundBookingStatusType;
  /** One per action that writes a movement, in action order (every inbound arm does today). */
  transitions: InboundCustodyTransition[];
  /** The unit sets after the actions, or `null` for a booking that is not unit-tracked. */
  units: InboundUnitSetsType | null;
}

const INBOUND_UNIT_BUCKET_SET: ReadonlySet<InboundBreakdownKeyType> = new Set(INBOUND_UNIT_BUCKETS);

function isInboundUnitBucket(key: InboundBreakdownKeyType): key is InboundUnitBucketType {
  return INBOUND_UNIT_BUCKET_SET.has(key);
}

function inboundService(side: InboundServiceSide): OOSReasonType | null {
  return side === "none" ? null : side;
}

/**
 * Apply `actions`, in order, to an inbound booking's CURRENT state — the twin of
 * `applyCustodyActions` over `INBOUND_CUSTODY_RULES`, and the pure half of the
 * inbound lever (`PUT /purchase-receipts/{uid}/bookings`, ruling 75).
 *
 * Throws {@link CustodyRefusal} on a rule the booking type may not take (a Buy
 * is never sent back or settled), a non-positive quantity, a short source
 * bucket, or two actions that would write one movement id: an id is
 * `{row sub-session}|{type}|{booking}`, so the slot is (movement type, row) —
 * which is wider than the wire's (rule, row) check, because `receive_damaged`
 * and its undo are both a `receive_flag`. Never clamps.
 *
 * ⚠️ **A settle row is legal HERE.** The wire refuses it (`InboundBookingAction`);
 * the out-of-service record's `return_to_supplier` reaches the lever as an
 * internal row, and this function serves both.
 *
 * On a unit-tracked booking (`units` non-null) every action names its units:
 * a `receive` draws units the booking holds nowhere (it leaves the `ordered`
 * PLAN key, which has no set, as a `prep` leaves `reserved`); every other step
 * takes units from its source bucket's set, plus — up to that bucket's
 * UNTRACKED count — units the booking holds nowhere. An untracked booking may
 * name no units.
 */
export function applyInboundCustodyActions(
  booking: InboundCustodyBooking,
  actions: readonly InboundBookingActionType[],
): InboundCustodyApplication {
  const breakdown: InboundBreakdown = { ...emptyInboundBreakdown(), ...booking.breakdown };
  const units: InboundUnitSetsType | null = booking.units == null
    ? null
    : Object.fromEntries(INBOUND_UNIT_BUCKETS.map((k) => [k, [...booking.units![k]]])) as InboundUnitSetsType;
  const slots = new Set<string>();
  const transitions: InboundCustodyTransition[] = [];

  for (const action of actions) {
    const rule = inboundCustodyRule(action.rule);
    const arm = booking.type === "rental" ? rule.rental : rule.sale;
    const what = booking.type === "rental" ? "Subrent" : "Buy";
    if (arm === null) throw new CustodyRefusal(`a ${what} line cannot take "${rule.id}"`);
    if (!Number.isInteger(action.quantity) || action.quantity <= 0) {
      throw new CustodyRefusal(`"${rule.id}" needs a positive whole quantity`);
    }
    const row = action.path_source_item.join("/");
    const slot = `${arm.movement}|${row}`;
    if (arm.movement !== null && slots.has(slot)) {
      throw new CustodyRefusal(
        `two actions would write the same "${arm.movement}" movement for row ${row}; make them two separate saves`,
      );
    }
    slots.add(slot);
    if (breakdown[rule.from] < action.quantity) {
      throw new CustodyRefusal(
        `"${rule.id}" moves ${action.quantity} from ${rule.from}, which holds ${breakdown[rule.from]}`,
      );
    }
    const named = (action.units ?? []).map((u) => u.number);
    if (units === null) {
      if (named.length > 0) throw new CustodyRefusal(`"${rule.id}" names units, but this booking is not unit-tracked`);
    } else {
      moveInboundUnits(units, breakdown, rule.id, rule.from, rule.to, action.quantity, action.units === undefined ? null : named);
    }
    breakdown[rule.from] -= action.quantity;
    breakdown[rule.to] += action.quantity;
    if (arm.movement === null) continue;
    transitions.push({
      rule: rule.id,
      type: arm.movement,
      from: rule.from,
      to: rule.to,
      quantity: action.quantity,
      service: rule.service === null
        ? null
        : { from: inboundService(rule.service.from), to: inboundService(rule.service.to) },
      units: named,
      path_source_item: [...action.path_source_item],
    });
  }
  return {
    breakdown,
    status: deriveInboundBookingStatus({ type: booking.type, breakdown }),
    transitions,
    units,
  };
}

/** Fold one action's named units into a tracked inbound booking's sets, BEFORE the breakdown moves. */
function moveInboundUnits(
  units: InboundUnitSetsType,
  breakdown: InboundBreakdown,
  rule: InboundCustodyRuleId,
  from: InboundBreakdownKeyType,
  to: InboundBreakdownKeyType,
  quantity: number,
  named: number[] | null,
): void {
  if (named === null) throw new CustodyRefusal(`"${rule}" must name the units it moves on a unit-tracked booking`);
  for (let i = 1; i < named.length; i++) {
    if (named[i] <= named[i - 1]) throw new CustodyRefusal(`"${rule}" names its units out of order or twice`);
  }
  if (named.length !== quantity) throw new CustodyRefusal(`"${rule}" moves ${quantity} but names ${named.length} units`);
  const holder = new Map<number, InboundUnitBucketType>();
  for (const key of INBOUND_UNIT_BUCKETS) for (const n of units[key]) holder.set(n, key);
  const untracked = isInboundUnitBucket(from) ? breakdown[from] - units[from].length : 0;
  let drawn = 0;
  for (const n of named) {
    const at = holder.get(n);
    if (isInboundUnitBucket(from) && at === from) continue;
    if (at !== undefined) throw new CustodyRefusal(`"${rule}" moves unit ${n} from ${from}, but this booking holds it in ${at}`);
    if (isInboundUnitBucket(from)) drawn++;
  }
  if (drawn > untracked) {
    throw new CustodyRefusal(
      `"${rule}" names ${drawn} unit(s) this booking does not hold in ${from}, and ${from} has ${untracked} untracked`,
    );
  }
  if (isInboundUnitBucket(from)) {
    const leaving = new Set(named);
    units[from] = units[from].filter((n) => !leaving.has(n));
  }
  if (isInboundUnitBucket(to)) units[to] = [...units[to], ...named].sort((a, b) => a - b);
}
