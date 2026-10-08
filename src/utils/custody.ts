/**
 * The custody ruleset, applied: what a booking may do next, what a list of
 * actions does to it, and how an absolute breakdown delta decomposes into the
 * same actions.
 *
 * The table itself is `CUSTODY_RULES` in `schemas/custody.ts` (the wire
 * validates against it, and schemas never import utils). Everything here is
 * pure and platform-free: the manager's optimistic update and the api's apply
 * are the same {@link applyCustodyActions}.
 *
 * ## Stays server-only, deliberately
 *
 * Shelf allocation, the undo origin (read off the consumed record's mark
 * movement), write-off cost, idempotency and `checkMovementService` all need
 * Firestore state or the journal. This module decides WHICH step is legal and
 * WHAT the booking reads afterwards; the api decides where the units go.
 *
 * ## Kept apart on purpose
 *
 * `getStageForBookings`, `qtyOnStageSide` and `custodyMovedQuantity`
 * (`utils/fulfillment-stage.ts`) answer rendering and freeze questions, not
 * legality ones, and must not be folded in here.
 *
 * @module
 */
import {
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_UNIT_BUCKETS,
  type Booking,
  type BookingActionType,
  type BookingBreakdown,
  type BookingBreakdownKeyType,
  type BookingUnitBucketType,
  type BookingUnitSetsType,
  CUSTODY_RULES,
  type CustodyRule,
  type CustodyRuleId,
  type CustodyServiceSide,
  custodyRule,
  duplicateCustodySlots,
  isLossUndo,
  type Movement,
  type MovementTypeType,
  OOS_FLAG_REASONS,
  type OOSBreakdown,
  type OOSBreakdownKeyType,
  OOS_BREAKDOWN_KEYS,
  type OOSUnitsType,
  type OOSReasonType,
  type OutOfService,
  OUT_OF_SERVICE_KEYS,
  type OutOfServiceKeyType,
  ownsKey,
  CUSTODY_HISTORY_KEYS,
  CUSTODY_PLACE_KINDS,
  MOVEMENT_CONTRACTS,
  type PlaceKindType,
} from "../schemas/mod.ts";
import {
  breakdownQuantity,
  type FullBookingBreakdown,
  fullBookingBreakdown,
  isBookingClosed,
  sumBookingBreakdown,
  sumBreakdownKeys,
  terminalQuantity,
} from "./bookings.ts";
import { parseBookingId } from "./booking-id.ts";
import { deriveOOSStatus, sumOOSBreakdown } from "./out-of-service.ts";
import { TERMINAL_OOS_STATUSES } from "./stock.ts";

/**
 * A booking as the ruleset reads it. `units` is read when present: `null` or
 * absent means the booking is not unit-tracked, and its actions may name no
 * units. Optional HERE although `Booking.units` is required: the ruleset is
 * also driven from bare custody states (a replay, a manager preview) that
 * carry no unit sets at all.
 */
export type CustodyBooking =
  & Pick<Booking, "type" | "breakdown" | "quantity" | "status">
  & Partial<Pick<Booking, "units">>;

/** A refused action: illegal for the booking, or short of units. Map it to a 400. */
export class CustodyRefusal extends Error {
  /** The rule the refusal is about, when there is one. */
  readonly rule: CustodyRuleId | null;
  constructor(message: string, rule: CustodyRuleId | null = null) {
    super(message);
    this.name = "CustodyRefusal";
    this.rule = rule;
  }
}

/** One movement's worth of custody change, as the journal will record it. */
export interface CustodyTransition {
  rule: CustodyRuleId;
  type: MovementTypeType;
  from: BookingBreakdownKeyType;
  to: BookingBreakdownKeyType;
  quantity: number;
  /** The flag's service axis; `null` off the flag rows. */
  service: { from: OOSReasonType | null; to: OOSReasonType | null } | null;
  /** The units the action named, ascending; `[]` when it named none. */
  units: number[];
}

/** The arm a booking type takes under a rule, or `null`: the type may not take it. */
function armFor(rule: CustodyRule, type: Booking["type"]) {
  if (type === "rental") return rule.rental;
  if (type === "sale") return rule.sale;
  return null;
}

function serviceFor(rule: CustodyRule): CustodyTransition["service"] {
  if (rule.service === null) return null;
  const side = (s: CustodyServiceSide): OOSReasonType | null => s === "none" ? null : s;
  return { from: side(rule.service.from), to: side(rule.service.to) };
}

// ── status ───────────────────────────────────────────────────────────

/**
 * A booking's status, read off its breakdown — ONE rule for every custody write,
 * and TOTAL: every breakdown reads one status, whatever mix of keys it holds.
 *
 * | breakdown (first row that holds)                       | status         |
 * |--------------------------------------------------------|----------------|
 * | no unit in a key that is still work (`isBookingClosed`) | `complete`     |
 * | any unit past `prepped` (`out` or a terminal key)       | `active`       |
 * | prepped = qty                                           | `prepped`      |
 * | prepped > 0                                             | `part-prepped` |
 * | reserved > 0                                            | `reserved`     |
 * | otherwise (only `quoted` is left)                       | `quoted`       |
 *
 * 🔴 **A sale fully `out` reads `complete`** (stock campaign decision 9): its
 * units are the customer's (`ownsKey`), so nothing about it is still work. It
 * read `active` until P1, while `isBookingClosed` read the same booking closed.
 *
 * ⚠️ **Total, so it no longer takes the stored status.** The old last row,
 * "anything else → unchanged", let a rental with units back and units still
 * reserved keep whatever status it was written with. Such a booking is
 * `active` now: custody moved past prepped and is not settled, which is the
 * order-level rule too.
 */
export function deriveCustodyStatus(
  booking: Pick<Booking, "type" | "breakdown" | "quantity">,
): Booking["status"] {
  const b = fullBookingBreakdown(booking.breakdown);
  if (isBookingClosed({ type: booking.type, breakdown: b })) return "complete";
  if (b.out > 0 || terminalQuantity(b) > 0) return "active";
  if (b.prepped > 0) return b.prepped === booking.quantity ? "prepped" : "part-prepped";
  if (b.reserved > 0) return "reserved";
  return "quoted";
}

// ── apply ────────────────────────────────────────────────────────────

/** What a list of actions does to a booking. */
export interface CustodyApplication {
  /** Every key stated, so a writer taking it authors `cleaning`/`maintenance` too. */
  breakdown: FullBookingBreakdown;
  status: Booking["status"];
  /** One per action that writes a movement, in action order. */
  transitions: CustodyTransition[];
  /**
   * The booking's unit sets after the actions, or `null` for a booking that is
   * not unit-tracked. A writer stores it beside `breakdown`.
   */
  units: BookingUnitSetsType | null;
}

/** Server knowledge the pure booking cannot carry. */
export interface CustodyApplyContext {
  /**
   * Returned units carrying no flag, before this save. Bounds the flags a save
   * may add off `returned` (every `flag_*_returned`). Defaults to
   * `breakdown.returned`, and is re-checked by the server against the shelves.
   */
  unflaggedReturned?: number;
}

/**
 * Apply `actions`, in order, to the booking's CURRENT state.
 *
 * Throws {@link CustodyRefusal} on an unknown rule, a rule the booking type may
 * not take, a short source bucket, two actions that
 * would write one movement id, or a loss-mark undo after a forward step. Never
 * clamps: a short bucket after a concurrent write is a refusal, not an
 * overwrite — the lost-update bug the absolute-breakdown wire had.
 */
export function applyCustodyActions(
  booking: CustodyBooking,
  actions: readonly BookingActionType[],
  ctx: CustodyApplyContext = {},
): CustodyApplication {
  if (booking.type !== "rental" && booking.type !== "sale") {
    throw new CustodyRefusal(`a ${booking.type} booking holds no stock and takes no custody action`);
  }
  const dup = duplicateCustodySlots(actions);
  if (dup.length > 0) {
    throw new CustodyRefusal(
      `two actions would write the same "${dup[0].split(":")[0]}" movement; make them two separate saves`,
    );
  }
  const breakdown = fullBookingBreakdown(booking.breakdown);
  const units = booking.units == null ? null : copyUnitSets(booking.units);
  let unflagged = Math.min(ctx.unflaggedReturned ?? breakdown.returned, breakdown.returned);
  let seenForward = false;
  const transitions: CustodyTransition[] = [];

  for (const action of actions) {
    const rule = CUSTODY_RULES.find((r) => r.id === action.rule);
    if (!rule) throw new CustodyRefusal(`"${action.rule}" is not a custody rule`);
    const arm = armFor(rule, booking.type);
    if (arm === null) {
      throw new CustodyRefusal(`a ${booking.type} booking cannot take "${rule.id}"`, rule.id);
    }
    if (!Number.isInteger(action.quantity) || action.quantity <= 0) {
      throw new CustodyRefusal(`"${rule.id}" needs a positive whole quantity`, rule.id);
    }
    if (rule.direction === "forward") seenForward = true;
    else if (seenForward && isLossUndo(rule.id)) {
      throw new CustodyRefusal(`"${rule.id}" undoes a loss mark and must come before every forward action`, rule.id);
    }
    if (breakdown[rule.from] < action.quantity) {
      throw new CustodyRefusal(
        `"${rule.id}" moves ${action.quantity} from ${rule.from}, which holds ${breakdown[rule.from]}`,
        rule.id,
      );
    }
    // A new flag lands on units that carry none.
    if (addsFlag(rule)) {
      if (unflagged < action.quantity) {
        throw new CustodyRefusal(
          `"${rule.id}" flags ${action.quantity}, but only ${unflagged} returned unit(s) are unflagged`,
          rule.id,
        );
      }
      unflagged -= action.quantity;
    }
    if (units === null) {
      if (action.units !== undefined) {
        throw new CustodyRefusal(`"${rule.id}" names units, but this booking is not unit-tracked`, rule.id);
      }
    } else {
      moveUnits(units, breakdown, rule, action);
    }
    breakdown[rule.from] -= action.quantity;
    breakdown[rule.to] += action.quantity;
    // Units landing on `returned` with no flag: a check-in, a flag cleared, a
    // shelf loss undone. Units leaving it take their unflagged share with them.
    if (rule.to === "returned" && rule.from !== "returned" && (rule.service === null || rule.service.to === "none")) {
      unflagged += action.quantity;
    }
    unflagged = Math.min(unflagged, breakdown.returned);

    if (arm.movement !== null) {
      transitions.push({
        rule: rule.id,
        type: arm.movement,
        from: rule.from,
        to: rule.to,
        quantity: action.quantity,
        service: serviceFor(rule),
        units: action.units ? [...action.units] : [],
      });
    }
  }
  return {
    breakdown,
    status: deriveCustodyStatus({ type: booking.type, breakdown, quantity: booking.quantity }),
    transitions,
    units,
  };
}

const UNIT_BUCKETS: ReadonlySet<BookingBreakdownKeyType> = new Set(BOOKING_UNIT_BUCKETS);

function isUnitBucket(key: BookingBreakdownKeyType): key is BookingUnitBucketType {
  return UNIT_BUCKETS.has(key);
}

function copyUnitSets(sets: BookingUnitSetsType): BookingUnitSetsType {
  const out = {} as BookingUnitSetsType;
  for (const key of BOOKING_UNIT_BUCKETS) out[key] = [...sets[key]];
  return out;
}

/**
 * Fold one action's named units into a tracked booking's sets, BEFORE the
 * breakdown moves (it reads the source bucket's count as it stands).
 *
 * What an action may name (`api-cloudrun/.claude/plans/serial-tracking.md`
 * D1, D7):
 *
 * - out of a unit bucket: units already in that bucket's set, plus — up to the
 *   bucket's UNTRACKED count (`breakdown[k] − units[k].length`, left by a
 *   conversion) — units this booking does not hold anywhere. Those are shelf
 *   or `unattributed_out` units the roster vouches for, which is the server's
 *   check, not this one;
 * - out of `reserved` (a `prep`): units this booking does not hold anywhere;
 * - nothing at all: only an `unprep` of untracked prepped units, which drains
 *   a count no unit was ever named for. Every other action on a tracked
 *   booking names its units.
 *
 * ⚠️ **A unit is in at most one of a booking's sets**, so a unit this booking
 * already returned cannot be prepped onto it a second time. Pick another unit.
 */
function moveUnits(
  units: BookingUnitSetsType,
  breakdown: BookingBreakdown,
  rule: CustodyRule,
  action: BookingActionType,
): void {
  const from = rule.from;
  const untracked = isUnitBucket(from) ? breakdown[from] - units[from].length : 0;
  if (action.units === undefined) {
    if (rule.id === "unprep" && untracked >= action.quantity) return;
    throw new CustodyRefusal(
      rule.id === "unprep"
        ? `"unprep" may omit units only for untracked prepped units; ${untracked} are untracked`
        : `"${rule.id}" must name the units it moves on a unit-tracked booking`,
      rule.id,
    );
  }
  const named = action.units;
  for (let i = 1; i < named.length; i++) {
    if (named[i] <= named[i - 1]) {
      throw new CustodyRefusal(`"${rule.id}" names its units out of order or twice`, rule.id);
    }
  }
  if (named.length !== action.quantity) {
    throw new CustodyRefusal(`"${rule.id}" moves ${action.quantity} but names ${named.length} units`, rule.id);
  }
  const holder = new Map<number, BookingUnitBucketType>();
  for (const key of BOOKING_UNIT_BUCKETS) for (const n of units[key]) holder.set(n, key);

  let drawn = 0;
  for (const n of named) {
    const at = holder.get(n);
    if (isUnitBucket(from) && at === from) continue;
    if (at !== undefined) {
      throw new CustodyRefusal(`"${rule.id}" moves unit ${n} from ${from}, but this booking holds it in ${at}`, rule.id);
    }
    if (isUnitBucket(from)) drawn++;
  }
  if (drawn > untracked) {
    throw new CustodyRefusal(
      `"${rule.id}" names ${drawn} unit(s) this booking does not hold in ${from}, and ${from} has ${untracked} untracked`,
      rule.id,
    );
  }
  if (isUnitBucket(from)) {
    const leaving = new Set(named);
    units[from] = units[from].filter((n) => !leaving.has(n));
  }
  if (isUnitBucket(rule.to)) {
    units[rule.to] = [...units[rule.to], ...named].sort((a, b) => a - b);
  }
}

/** A row that puts a flag on units carrying none: every `flag_*_returned`. */
function addsFlag(rule: CustodyRule): boolean {
  return rule.from === "returned" && rule.service !== null && rule.service.from === "none";
}

// ── the ladder's movements and where they put units ──────────────────

/**
 * Every movement type the custody ladder can write for a booking of this type,
 * in table order, each once — read off {@link CUSTODY_RULES}'s arms, so a new
 * rule's movement is included without an edit. `[]` for a type that holds no
 * stock. The api's `LADDER_MOVEMENT_TYPES` (rental) was a hand-kept copy.
 */
export function custodyMovementTypes(bookingType: Booking["type"]): MovementTypeType[] {
  const types: MovementTypeType[] = [];
  for (const rule of CUSTODY_RULES) {
    const movement = armFor(rule, bookingType)?.movement ?? null;
    if (movement !== null && !types.includes(movement)) types.push(movement);
  }
  return types;
}

/** The two places a custody movement's lines run between. */
export interface CustodyPlaces {
  from: PlaceKindType;
  to: PlaceKindType;
}

/**
 * The kind of place each end of a custody movement's lines stands in, or `null`
 * when the movement writes no lines (`places: null` — a prep, a rebook).
 *
 * Each end is the kind its custody key implies (`CUSTODY_PLACE_KINDS`) that the
 * movement's contract allows on that side: `out` is a `bookings` place for a
 * rental and `outside` for a sale, and a `lost` unit stands at its
 * `out-of-service` record. A flag is `locations → locations`: in place.
 *
 * @throws Error when the custody pair names no place the contract allows — a
 *   row the table test would already have refused.
 */
export function custodyPlaces(
  type: MovementTypeType,
  custody: { from: BookingBreakdownKeyType; to: BookingBreakdownKeyType },
): CustodyPlaces | null {
  const places = MOVEMENT_CONTRACTS[type].places;
  if (places === null) return null;
  const pick = (key: BookingBreakdownKeyType, allowed: readonly PlaceKindType[]): PlaceKindType => {
    const kind = CUSTODY_PLACE_KINDS[key].find((k) => allowed.includes(k));
    if (kind === undefined) throw new Error(`"${type}" cannot carry ${key}: none of its places is one ${key} stands in`);
    return kind;
  };
  return { from: pick(custody.from, places.from), to: pick(custody.to, places.to) };
}

/**
 * Units a custody movement puts ON shelves, net: `+1` per unit landing on a
 * `locations` place, `−1` per unit leaving one, `0` for a flag in place or a
 * movement with no lines. Times `quantity`.
 */
export function shelfNet(
  t: Pick<CustodyTransition, "type" | "from" | "to" | "quantity">,
): number {
  const places = custodyPlaces(t.type, t);
  if (places === null) return 0;
  return ((places.to === "locations" ? 1 : 0) - (places.from === "locations" ? 1 : 0)) * t.quantity;
}

/**
 * Whether a transition is a RELEASING rewind: an undo that takes no units off
 * a shelf — it adds shelf units (`check_out_undo`, a shelf loss undone), clears
 * a flag in place, or moves nothing physical (`unprep`, a booking-side loss
 * undone). Moved from the api's `bookingMovements.ts`, where it netted the
 * lines its own line builder produced; here it reads the contracts directly
 * ({@link shelfNet}), the same answer for every rule.
 *
 * ⚠️ Not every undo releases. `check_in_undo` and the damaged-family mark undos
 * (`mark_{damaged,cleaning,maintenance}_undo`) take units OFF a shelf back to
 * the booking, and on a bulk product the shelf is fungible: `[A: check_in 5,
 * B: check_in_undo 5]` against an empty shelf works only because A refills it
 * first. Moving such a rewind earlier could refuse a request that passes in row
 * order, so it holds its place.
 */
export function isReleasingRewind(
  t: Pick<CustodyTransition, "rule" | "type" | "from" | "to" | "quantity">,
): boolean {
  return custodyRule(t.rule).direction === "undo" && shelfNet(t) >= 0;
}

/**
 * Split one row's transitions into the leading run of releasing rewinds and
 * the rest (serial-tracking D7). The chunk folds every row's `first` before any
 * row's `rest`, so units a rewind frees are free before any forward step looks
 * for them — which is what lets a two-order swap (a cycle no row order
 * resolves) go in one request. The prefix stops at the first transition that is
 * not a releasing rewind, so a row's own steps keep their order.
 */
export function splitLeadingReleases<T extends Pick<CustodyTransition, "rule" | "type" | "from" | "to" | "quantity">>(
  transitions: readonly T[],
): { first: T[]; rest: T[] } {
  let i = 0;
  while (i < transitions.length && isReleasingRewind(transitions[i])) i++;
  return { first: transitions.slice(0, i), rest: transitions.slice(i) };
}

// ── offers ───────────────────────────────────────────────────────────

/**
 * One action the UI may offer on a booking row.
 *
 * `key` is what a menu de-duplicates on — the rule id. Expand an offer into the
 * actions to send with {@link expandCustodyOffer}; a `check_out` over reserved
 * units is two steps.
 */
export interface CustodyOffer {
  key: string;
  rule: CustodyRuleId;
  /** The most units the offer can take right now. Always > 0. */
  max: number;
  /** The row's natural next action. At most one offer per booking carries it. */
  natural: boolean;
  direction: CustodyRule["direction"];
  stage: CustodyRule["stage"];
}

/** What an offer list needs that the booking alone does not carry. */
export interface CustodyOfferContext {
  /**
   * Whether prep and check-out are open for the fulfillment's status
   * (`canPrepCheckout`, `utils/fulfillment-stage.ts`). Returns and losses are
   * never gated: a checked-out rental always needs returning.
   */
  canPrepCheckout: boolean;
  /** As {@link CustodyApplyContext.unflaggedReturned}. */
  unflaggedReturned?: number;
  /**
   * How many units each loss-mark undo may take back — the booking's open loss
   * records, split by the origin their mark movement names, net of any that are
   * billed, written off or returned to service.
   *
   * Absent, every `lost`/`damaged`/`cleaning`/`maintenance` unit is read as
   * marked off `out` and undoable, which is the reading the delta form always planned with
   * (`canonicalLossUndos`); the server re-checks against the records.
   */
  undoable?: Partial<Record<CustodyRuleId, number>>;
}

/**
 * Every action the UI may offer on this booking, natural next first, then
 * forward in ladder order, then undos.
 *
 * It replaced the alternates vocabulary in `utils/fulfillment-stage.ts`
 * (removed in custody-actions P4). Two behaviours
 * change, both by owner ruling (2026-09-29):
 *
 * - **No pre-departure loss.** `reserved`/`prepped` units are never offered
 *   Lost or Damaged (gap G1). The fulfillment offers `unprep` plus a shelf
 *   out-of-service record instead.
 * - **Returned units get their own losses and flags** (gap G5): Lost, Damaged,
 *   Cleaning and Maintenance off `returned`, so `‹ Out` is no longer the only
 *   way to reach them. Since P2b those are the `flag_*_returned` rows.
 */
export function custodyActionsFor(booking: CustodyBooking, ctx: CustodyOfferContext): CustodyOffer[] {
  if (booking.type !== "rental" && booking.type !== "sale") return [];
  const b = fullBookingBreakdown(booking.breakdown);
  const unflagged = Math.min(ctx.unflaggedReturned ?? b.returned, b.returned);
  const undoable: Partial<Record<CustodyRuleId, number>> = ctx.undoable ?? {
    mark_lost_undo: b.lost,
    mark_damaged_undo: b.damaged,
    mark_cleaning_undo: b.cleaning,
    mark_maintenance_undo: b.maintenance,
  };
  const natural: CustodyRuleId | null = b.reserved > 0
    ? "prep"
    : b.prepped > 0
    ? "check_out"
    : b.out > 0 && ownsKey(booking.type, "out")
    ? "check_in"
    : null;

  const maxFor = (id: CustodyRuleId): number => {
    switch (id) {
      case "prep":
        return ctx.canPrepCheckout ? b.reserved : 0;
      case "check_out":
        return ctx.canPrepCheckout ? sumBreakdownKeys(b, ["reserved", "prepped"]) : 0;
    }
    const rule = custodyRule(id);
    if (addsFlag(rule)) return unflagged;
    if (isLossUndo(id)) return Math.min(undoable[id] ?? 0, b[rule.from]);
    // A reclassification is a record-page action, never a booking-row offer.
    if (rule.stage === "service") return 0;
    return b[rule.from];
  };

  const offers: CustodyOffer[] = [];
  for (const rule of CUSTODY_RULES) {
    if (armFor(rule, booking.type) === null) continue;
    const max = maxFor(rule.id);
    if (max <= 0) continue;
    offers.push({
      key: rule.id,
      rule: rule.id,
      max,
      natural: rule.id === natural,
      direction: rule.direction,
      stage: rule.stage,
    });
  }
  const rank = (o: CustodyOffer) => (o.natural ? 0 : o.direction === "forward" ? 1 : 2);
  return offers.sort((x, y) => rank(x) - rank(y));
}

/**
 * The breakdown buckets an offer draws from: a `check_out` preps `reserved`
 * units on the way, so it reads both; every other rule its own `from`. The
 * manager's `sourcesOf` restated it.
 */
export function custodyOfferSources(rule: CustodyRuleId): BookingBreakdownKeyType[] {
  return rule === "check_out" ? ["reserved", "prepped"] : [custodyRule(rule).from];
}

/**
 * The actions an offer sends for `quantity` units.
 *
 * Every offer is one action except `check_out` over units still `reserved`:
 * those are prepped on the way, so the offer sends `[prep, check_out]`. It
 * draws the already-prepped units FIRST — the ones on the prep shelf are the
 * ones going out — and preps only the shortfall.
 *
 * **With `units`** (a unit-tracked booking, the operator's pick): a
 * `check_out` sends every picked unit the booking holds in `prepped` straight
 * out, lets up to its UNTRACKED prepped count (a conversion's leftover) go out
 * as well, and preps exactly the rest, naming them. An `unprep` with no units
 * picked drains an untracked count and names none. This is the manager's
 * `wireActions` for one dispatch, so the menu and the wire cannot disagree.
 */
export function expandCustodyOffer(
  booking: CustodyBooking,
  offer: Pick<CustodyOffer, "rule">,
  quantity: number,
  units?: readonly number[],
): BookingActionType[] {
  if (units === undefined) {
    if (offer.rule === "check_out") {
      const toPrep = Math.max(0, quantity - booking.breakdown.prepped);
      return [
        ...(toPrep > 0 ? [{ rule: "prep" as const, quantity: toPrep }] : []),
        { rule: "check_out", quantity },
      ];
    }
    return [{ rule: offer.rule, quantity }];
  }
  const picked = [...units].sort((a, b) => a - b);
  if (offer.rule === "check_out") {
    const prepped = new Set(booking.units?.prepped ?? []);
    const shelf = picked.filter((n) => !prepped.has(n));
    const untrackedPrepped = Math.max(0, booking.breakdown.prepped - (booking.units?.prepped.length ?? 0));
    const viaUntracked = Math.min(untrackedPrepped, shelf.length);
    const toPrep = shelf.slice(viaUntracked);
    return [
      ...(toPrep.length > 0 ? [{ rule: "prep" as const, quantity: toPrep.length, units: toPrep }] : []),
      { rule: "check_out", quantity, units: picked },
    ];
  }
  if (offer.rule === "unprep" && picked.length === 0) return [{ rule: "unprep", quantity }];
  return [{ rule: offer.rule, quantity, units: picked }];
}

// ── decomposing a delta ──────────────────────────────────────────────

/** An out-of-service key a delta may lower, and where its mark took the units from. */
export interface CustodyLossUndo {
  reason: CustodyLossKey;
  origin: BookingBreakdownKeyType;
  quantity: number;
}

/** The breakdown keys a mark puts units in, and an undo takes them out of: `OutOfServiceKeyType`. */
export type CustodyLossKey = OutOfServiceKeyType;

/**
 * Every {@link CustodyLossKey}, in breakdown order — `OUT_OF_SERVICE_KEYS`
 * (`@cfs/core/schemas`) under the name existing importers use.
 */
export const CUSTODY_LOSS_KEYS: readonly CustodyLossKey[] = OUT_OF_SERVICE_KEYS;

/** One step of a decomposition: a rule and its quantity. */
export interface CustodyStep {
  rule: CustodyRuleId;
  quantity: number;
}

/** What a breakdown delta is, in rules. */
export interface CustodyDecomposition {
  /** `false` ⇒ some of the delta matches no sequence of rules. */
  matched: boolean;
  /** The steps that DID match, in apply order — undos first. */
  steps: CustodyStep[];
  /** Their movements, merged per step exactly as the journal writes them. */
  transitions: CustodyTransition[];
  /** What no rule could pair: units still to fall and still to rise. Empty when matched. */
  residue: { falls: Partial<Record<BookingBreakdownKeyType, number>>; rises: Partial<Record<BookingBreakdownKeyType, number>> };
}

/** The undo rule for a loss mark of `reason` taken from `origin`. */
function undoRuleFor(reason: CustodyLossKey, origin: BookingBreakdownKeyType): CustodyRuleId {
  if (origin === "out") return `mark_${reason}_undo`;
  if (origin === "returned") return reason === "lost" ? "mark_lost_returned_undo" : `flag_${reason}_returned_undo`;
  throw new Error(`a ${reason} mark cannot have come from "${origin}"`);
}

/**
 * Every fallen loss unit read as marked off `out` — for PLANNING, where no
 * record is at hand. The server reads the real origin off each consumed
 * record's mark movement.
 */
export function canonicalLossUndos(prev: BookingBreakdown, next: BookingBreakdown): CustodyLossUndo[] {
  const undos: CustodyLossUndo[] = [];
  for (const reason of CUSTODY_LOSS_KEYS) {
    const fall = breakdownQuantity(prev, reason) - breakdownQuantity(next, reason);
    if (fall > 0) undos.push({ reason, origin: "out", quantity: fall });
  }
  return undos;
}

/**
 * The rules an ABSOLUTE breakdown change represents — the successor to the
 * api's `deriveCustodyTransitions` / `deriveWithLossUndos`, for repair scripts,
 * the parity sweeps and the transition window while the delta wire is still
 * accepted.
 *
 * `undos` are the loss marks the caller is undoing, with the origin read off
 * each consumed record. They apply first, and the ladder then decomposes the
 * breakdown in between. A fall of `lost`/`damaged` with no undo for it is
 * residue: the pure delta cannot say where the units go back to.
 *
 * ## Pairing order, carried over unchanged
 *
 * Rises are paired in order of how CONSTRAINED they are, not by direction:
 * `reserved` can only be fed by `prepped`, so that pairing is resolved first,
 * and only then the contested `prepped`/`out` rises. Take
 * `{returned: 2, prepped: 2}` → `{out: 2, reserved: 2}`: forward-first pairs
 * `prepped → out` and strands `returned → reserved`, while the forced reading
 * is `unprep` + `check_in_undo`.
 *
 * A forward multi-hop (`reserved → out`) is `[prep, check_out]` with the
 * implicit prep counted once; a rewind is matched at every depth
 * (`returned → reserved` is `check_in_undo`, `check_out_undo`, `unprep`).
 *
 * ⚠️ **What stays residue is a DECISION, not a gap in this function.**
 * `prepped → returned` is a forward multi-hop past `out`, which would record
 * units going out and coming back that nobody saw (api-cloudrun#1053); a
 * pre-departure key into `lost`/`damaged` has no row at all (gap G1); and a
 * sale never takes a shelf loss, a flag, `cleaning` or `maintenance` (P2b ruling
 * 4). A sale's rewinds and its loss undos ARE matched since decision 5
 * (`sale_undo`, `sale_return_undo`, `sale_lost_undo`, `sale_damaged_undo`). A service or surcharge booking holds no
 * stock, so its delta is always matched with no steps.
 */
export function decomposeCustodyDelta(
  prev: BookingBreakdown,
  next: BookingBreakdown,
  bookingType: Booking["type"],
  undos: readonly CustodyLossUndo[] = [],
): CustodyDecomposition {
  const empty: CustodyDecomposition = { matched: true, steps: [], transitions: [], residue: { falls: {}, rises: {} } };
  if (bookingType !== "rental" && bookingType !== "sale") return empty;
  const isSale = bookingType === "sale";

  const steps: CustodyStep[] = [];
  const add = (rule: CustodyRuleId, quantity: number) => {
    if (quantity > 0) steps.push({ rule, quantity });
  };

  // ── the undone marks first, grouped per rule in input order ──
  // A sale takes them too since decision 5 (`sale_lost_undo` / `sale_damaged_undo`);
  // an undo whose rule the sale has no arm for stays unapplied, so its fall is residue.
  const mid = fullBookingBreakdown(prev);
  const grouped = new Map<CustodyRuleId, number>();
  for (const u of undos) {
    const id = undoRuleFor(u.reason, u.origin);
    if (armFor(custodyRule(id), bookingType) === null) continue;
    mid[u.reason] -= u.quantity;
    mid[u.origin] += u.quantity;
    grouped.set(id, (grouped.get(id) ?? 0) + u.quantity);
  }
  for (const [id, q] of grouped) add(id, q);

  const falls = new Map<BookingBreakdownKeyType, number>();
  const rises = new Map<BookingBreakdownKeyType, number>();
  for (const key of BOOKING_BREAKDOWN_KEYS) {
    const delta = breakdownQuantity(next, key) - mid[key];
    if (delta < 0) falls.set(key, -delta);
    else if (delta > 0) rises.set(key, delta);
  }
  const take = (fallKey: BookingBreakdownKeyType, riseKey: BookingBreakdownKeyType): number => {
    const taken = Math.min(falls.get(fallKey) ?? 0, rises.get(riseKey) ?? 0);
    if (taken > 0) {
      falls.set(fallKey, (falls.get(fallKey) ?? 0) - taken);
      rises.set(riseKey, (rises.get(riseKey) ?? 0) - taken);
    }
    return taken;
  };

  const unprepDirect = take("prepped", "reserved");
  const prepDirect = take("reserved", "prepped");
  const outFromPrepped = take("prepped", "out");
  const outFromReserved = take("reserved", "out");
  add("prep", prepDirect + outFromReserved);
  add("check_out", outFromPrepped + outFromReserved);
  add("check_in", take("out", "returned"));
  add("mark_damaged", take("out", "damaged"));
  add("mark_lost", take("out", "lost"));
  // A sale takes no shelf loss, no flag and no cleaning/maintenance (P2b ruling 4).
  if (!isSale) {
    add("mark_lost_returned", take("returned", "lost"));
    add("flag_damaged_returned", take("returned", "damaged"));
    for (const r of ["cleaning", "maintenance"] as const) {
      add(`mark_${r}`, take("out", r));
      add(`flag_${r}_returned`, take("returned", r));
    }
    // A fall of one flag reason against a rise of another is a correction on
    // the record, and the booking moves with it (P2b ruling 1).
    for (const rule of CUSTODY_RULES) {
      if (rule.stage === "service" && rule.from !== "returned" && rule.to !== "returned") {
        add(rule.id, take(rule.from, rule.to));
      }
    }
  }

  // ── rewinds, at every depth, for both types (a sale's are typed reversals) ──
  const outFromReturned = take("returned", "out");
  const preppedFromOut = take("out", "prepped");
  const reservedFromOut = take("out", "reserved");
  const preppedFromReturned = take("returned", "prepped");
  const reservedFromReturned = take("returned", "reserved");
  add("check_in_undo", outFromReturned + preppedFromReturned + reservedFromReturned);
  add("check_out_undo", preppedFromOut + reservedFromOut + preppedFromReturned + reservedFromReturned);
  add("unprep", unprepDirect + reservedFromOut + reservedFromReturned);

  const residue: CustodyDecomposition["residue"] = { falls: {}, rises: {} };
  for (const [k, q] of falls) if (q > 0) residue.falls[k] = q;
  for (const [k, q] of rises) if (q > 0) residue.rises[k] = q;
  const matched = Object.keys(residue.falls).length === 0 && Object.keys(residue.rises).length === 0;

  const transitions: CustodyTransition[] = [];
  for (const s of steps) {
    const rule = custodyRule(s.rule);
    const arm = armFor(rule, bookingType);
    if (arm?.movement) {
      transitions.push({
        rule: rule.id,
        type: arm.movement,
        from: rule.from,
        to: rule.to,
        quantity: s.quantity,
        service: serviceFor(rule),
        // A delta names no units; the api refuses a delta row on a seeded
        // serialized product (serial-tracking D3).
        units: [],
      });
    }
  }
  return { matched, steps, transitions, residue };
}

/**
 * The rule a STORED movement's `(type, custody, service)` is an instance of, or
 * `null` — the population assertion's lookup (`audit-custody-rules` in the api
 * replays every stored custody movement through it).
 *
 * ⚠️ A `flag` with NO custody pair maps to nothing. That was R2's check-in
 * flag (`flag_returned`), retired in P4 after the audit found none stored in
 * either project (2026-09-30), so one appearing now is a finding.
 */
export function custodyRuleForMovement(
  type: MovementTypeType,
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null } | null,
  service: { from: OOSReasonType | null; to: OOSReasonType | null } | null | undefined,
  bookingType: "rental" | "sale",
): CustodyRule | null {
  const matches = (side: CustodyServiceSide, r: OOSReasonType | null) => side === "none" ? r === null : r === side;
  return CUSTODY_RULES.find((rule) => {
    const arm = bookingType === "rental" ? rule.rental : rule.sale;
    if (arm?.movement !== type) return false;
    if (custody === null || custody.from !== rule.from || custody.to !== rule.to) return false;
    if (rule.service === null) return true;
    if (!service) return false;
    return matches(rule.service.from, service.from) && matches(rule.service.to, service.to);
  }) ?? null;
}

// ── the record side ──────────────────────────────────────────────────

/** A bucket a record's units can move between. `unplaced` is quantity − Σ breakdown. */
export type ServicePlace = "unplaced" | OOSBreakdownKeyType;

/** One move of `quantity` units between two of a record's buckets. */
export interface ServiceBucketMove {
  from: ServicePlace;
  to: ServicePlace;
  quantity: number;
}

/** The moves a record breakdown change makes, or why it cannot be made. */
export type ServiceMovePlan =
  | { ok: true; moves: ServiceBucketMove[] }
  | {
    ok: false;
    message: string;
    /**
     * `true` for a caller mistake rather than an operator one: units leaving
     * `written_off` must be resolved into a reversal before planning.
     */
    internal: boolean;
  };

/**
 * The moves that take an out-of-service record from its stored breakdown to
 * `next` — lifted from the api's `planBucketMoves`, which was already a
 * table-driven, refusing planner. The record PUT stays target-shaped because
 * this is deterministic: there is nothing to infer.
 *
 * Each INCREASE is fed from the buckets that DECREASED, in a fixed preference:
 *
 * | into                  | drawn from, in order   |
 * |-----------------------|------------------------|
 * | `written_off`         | `away`, `flagged`, then `unplaced` |
 * | `returned_to_service` | `away`, `flagged`, then `unplaced` |
 * | `away`                | `flagged`, then `unplaced` |
 * | `flagged`             | `away`, then `unplaced` |
 *
 * Refused: leaving `returned_to_service` (out of service again is a NEW
 * record); leaving `written_off` (resolve found units into a reversal first);
 * going back to `unplaced` (an effect that happened cannot un-happen); a `lost`
 * record's units into `flagged` (lost is a place, not a flag — R3).
 */
export function serviceMovesFor(
  record: Pick<OutOfService, "quantity" | "reason" | "breakdown">,
  next: OOSBreakdown,
): ServiceMovePlan {
  const { quantity, reason } = record;
  const placed = sumOOSBreakdown;
  const level = (b: OOSBreakdown): Record<ServicePlace, number> => ({
    unplaced: quantity - placed(b),
    flagged: b.flagged,
    away: b.away,
    written_off: b.written_off,
    returned_to_service: b.returned_to_service,
  });
  const before = level(record.breakdown);
  const after = level(next);
  const refuse = (message: string, internal = false): ServiceMovePlan => ({ ok: false, message, internal });
  if (after.unplaced < 0) return refuse(`breakdown places ${placed(next)} units but the record holds ${quantity}`);
  if (after.returned_to_service < before.returned_to_service) {
    return refuse(
      "Units returned to service cannot be taken back out of it; record a new " +
        "out-of-service record for a unit that is out of service again",
    );
  }
  if (after.written_off < before.written_off) {
    return refuse("serviceMovesFor: resolve found units into reversals before planning", true);
  }
  if (after.unplaced > before.unplaced) {
    return refuse(
      "Units that went out of service cannot go back to 'not yet in effect'; " +
        "return them to service, or cancel the record",
    );
  }
  if (reason === "lost" && after.flagged > 0) {
    return refuse(
      "A lost unit is not on a shelf, so it cannot be flagged. Return it to service " +
        "and flag it on a new record if it turned up damaged.",
    );
  }

  const places: ServicePlace[] = ["unplaced", ...OOS_BREAKDOWN_KEYS];
  const spare = {} as Record<ServicePlace, number>;
  const need = {} as Record<ServicePlace, number>;
  for (const p of places) {
    const d = after[p] - before[p];
    spare[p] = d < 0 ? -d : 0;
    need[p] = d > 0 ? d : 0;
  }
  const moves: ServiceBucketMove[] = [];
  for (const [to, sources] of SERVICE_MOVE_PREFERENCE) {
    for (const from of sources) {
      const q = Math.min(need[to], spare[from]);
      if (q <= 0) continue;
      moves.push({ from, to, quantity: q });
      need[to] -= q;
      spare[from] -= q;
    }
  }
  const stuck = places.filter((p) => spare[p] > 0);
  if (stuck.length > 0) {
    return refuse(`This breakdown change is not a move the record can make (${stuck.join(", ")} would have nowhere to go)`);
  }
  return { ok: true, moves };
}

/**
 * Each record bucket an increase lands in, and the buckets that feed it, in
 * preference order — {@link serviceMovesFor}'s table, exported so the api's
 * planner and a manager editor read the same one (api-cloudrun `serviceFlag.ts`
 * restated it as `BUCKET_MOVE_PREFERENCE`).
 */
export const SERVICE_MOVE_PREFERENCE: ReadonlyArray<readonly [ServicePlace, readonly ServicePlace[]]> = [
  ["written_off", ["away", "flagged", "unplaced"]],
  ["returned_to_service", ["away", "flagged", "unplaced"]],
  ["away", ["flagged", "unplaced"]],
  ["flagged", ["away", "unplaced"]],
];

/** One bucket move naming its units (`[]` only for an unnamed resolve). */
export interface ServiceUnitMove extends ServiceBucketMove {
  units: number[];
}

/** The moves a unit-tracked record's change makes, or why it cannot be made. */
export type ServiceUnitMovePlan = { ok: true; moves: ServiceUnitMove[] } | { ok: false; message: string };

/** Where a found unit lands: back where its write-off took it from. */
const FOUND_LANDINGS: readonly ServicePlace[] = ["away", "flagged", "returned_to_service"];

/**
 * The moves a UNIT-TRACKED record makes from its stored breakdown and unit sets
 * to `next` / `nextUnits`, each naming its units, in the journal's order —
 * lifted from api-cloudrun `src/lib/oosUnits.ts` `planUnitMoves`, with the
 * manager editor's own checks folded in, so the editor offers exactly what the
 * api accepts (gap G11 (c)).
 *
 * Refused, beside everything {@link serviceMovesFor} refuses:
 * - a unit in two buckets, or a unit the record holds left in none — an
 *   effect cannot un-happen;
 * - a unit new to the record that is not on the unflagged shelf (`shelf`, when
 *   the caller has it), or more new units than the record has not placed;
 * - a unit whose move is no row of {@link SERVICE_MOVE_PREFERENCE} — so out of
 *   `returned_to_service` is refused;
 * - a FOUND unit (leaving `written_off`) landing anywhere but `away`,
 *   `flagged` or `returned_to_service`. Found moves come FIRST, for the writer
 *   to resolve into reversals of the write-off that named each unit;
 * - a count change the named units do not account for, other than the unnamed
 *   `unplaced → returned_to_service` (a scheduled record resolved before it
 *   took effect).
 */
export function serviceUnitMovesFor(
  record: Pick<OutOfService, "quantity" | "reason" | "breakdown"> & { units: OOSUnitsType },
  next: OOSBreakdown,
  nextUnits: OOSUnitsType,
  options: { shelf?: readonly number[] } = {},
): ServiceUnitMovePlan {
  const refuse = (message: string): ServiceUnitMovePlan => ({ ok: false, message });
  if (next.written_off >= record.breakdown.written_off) {
    const counts = serviceMovesFor(record, next);
    if (!counts.ok) return refuse(counts.message);
  }
  const placements = new Map<number, number>();
  for (const key of OOS_BREAKDOWN_KEYS) for (const n of nextUnits[key]) placements.set(n, (placements.get(n) ?? 0) + 1);
  const twice = [...placements].filter(([, c]) => c > 1).map(([n]) => n);
  if (twice.length > 0) return refuse(`Unit ${twice[0]} is in two of this record's buckets; a unit is in one at a time.`);
  const held = new Set(OOS_BREAKDOWN_KEYS.flatMap((k) => record.units[k]));
  const added = [...placements.keys()].filter((n) => !held.has(n));
  if (options.shelf !== undefined) {
    const shelf = new Set(options.shelf);
    const stray = added.find((n) => !shelf.has(n));
    if (stray !== undefined) return refuse(`Unit ${stray} is not on the unflagged shelf, so this record cannot take it.`);
  }
  const unplaced = record.quantity - sumOOSBreakdown(record.breakdown);
  if (added.length > unplaced) {
    return refuse(`${added.length} unit(s) are new to this record, but only ${unplaced} of its units are not yet in effect.`);
  }

  const bucketOf = (sets: OOSUnitsType, n: number): ServicePlace =>
    OOS_BREAKDOWN_KEYS.find((k) => sets[k].includes(n)) ?? "unplaced";
  const allowed = new Set(SERVICE_MOVE_PREFERENCE.flatMap(([to, froms]) => froms.map((from) => `${from}>${to}`)));
  const groups = new Map<string, number[]>();
  for (const n of [...new Set([...held, ...placements.keys()])].sort((a, b) => a - b)) {
    const from = bucketOf(record.units, n);
    const to = bucketOf(nextUnits, n);
    if (from === to) continue;
    if (to === "unplaced") {
      return refuse(
        `Unit ${n} cannot leave this record's buckets: an effect that happened cannot un-happen. ` +
          "Return it to service, or write it off.",
      );
    }
    if (from === "written_off" && !FOUND_LANDINGS.includes(to)) {
      return refuse(
        `Unit ${n} was written off, so it comes back to where its write-off took it from — away, ` +
          `flagged or returned to service — never to ${to}`,
      );
    }
    if (from !== "written_off" && !allowed.has(`${from}>${to}`)) {
      return refuse(`Unit ${n} cannot move from ${from} to ${to} on an out-of-service record`);
    }
    groups.set(`${from}>${to}`, [...(groups.get(`${from}>${to}`) ?? []), n]);
  }

  const named: ServiceUnitMove[] = [];
  const level: OOSBreakdown = { ...record.breakdown };
  for (const to of FOUND_LANDINGS) {
    const units = groups.get(`written_off>${to}`);
    if (!units || to === "unplaced" || to === "written_off") continue;
    named.push({ from: "written_off", to, quantity: units.length, units });
    level.written_off -= units.length;
    level[to] += units.length;
  }
  for (const [to, froms] of SERVICE_MOVE_PREFERENCE) {
    for (const from of froms) {
      const units = groups.get(`${from}>${to}`);
      if (!units) continue;
      named.push({ from, to, quantity: units.length, units });
      if (from !== "unplaced") level[from] -= units.length;
      if (to !== "unplaced") level[to] += units.length;
    }
  }
  if (OOS_BREAKDOWN_KEYS.some((k) => level[k] < 0)) {
    return refuse("The named units move more units out of a bucket than the record holds there");
  }
  if (next.written_off < level.written_off) {
    return refuse("This product tracks units, so bringing written-off units back must name the units that were found");
  }
  const residual = serviceMovesFor({ quantity: record.quantity, reason: record.reason, breakdown: level }, next);
  if (!residual.ok) return refuse(residual.message);
  const unnamed = residual.moves.find((m) => !(m.from === "unplaced" && m.to === "returned_to_service"));
  if (unnamed) {
    return refuse(
      `This product tracks units, so "${unnamed.from} → ${unnamed.to}" must name the ${unnamed.quantity} ` +
        "unit(s) it moves",
    );
  }
  return { ok: true, moves: [...named, ...residual.moves.map((m) => ({ ...m, units: [] }))] };
}

/** The range an editor may put one of a record's buckets in. `max: null` is unbounded. */
export interface ServiceBucketBounds {
  min: number;
  max: number | null;
}

type BoundsRecord = Pick<OutOfService, "status" | "reason" | "quantity" | "breakdown">;

/**
 * The bounds the api enforces on one bucket, so an editor shows the limit at
 * the input rather than a failed save. Lifted from the manager's own bounds
 * util, since deleted: its out-of-service breakdown editor calls these now.
 *
 * - `returned_to_service` never goes down, on any record.
 * - A `lost` record flags nothing: its `flagged` bucket is pinned at 0.
 * - A complete/canceled record admits ONE edit: units LEAVING `written_off`
 *   ("found after write-off"), into any other bucket. The api re-opens it.
 */
export function serviceBucketBounds(
  record: Pick<BoundsRecord, "status" | "reason" | "breakdown">,
  key: OOSBreakdownKeyType,
): ServiceBucketBounds {
  const stored = record.breakdown[key];
  const closed = TERMINAL_OOS_STATUSES.has(record.status);
  if (key === "flagged" && record.reason === "lost") return { min: 0, max: 0 };
  if (closed) return key === "written_off" ? { min: 0, max: stored } : { min: stored, max: null };
  if (key === "returned_to_service") return { min: stored, max: null };
  return { min: 0, max: null };
}

/** Whether a record's breakdown can be edited at all. A closed record with nothing written off cannot. */
export function canEditServiceBreakdown(record: Pick<OutOfService, "status" | "breakdown">): boolean {
  const closed = TERMINAL_OOS_STATUSES.has(record.status);
  return !closed || record.breakdown.written_off > 0;
}

/**
 * The first rule `next` breaks, as the sentence the operator reads: a bucket
 * outside its bounds first, then the sum against the record. `null` when
 * `next` is within bounds (the planner may still refuse the MOVE).
 */
export function serviceBreakdownViolation(record: BoundsRecord, next: OOSBreakdown): string | null {
  for (const key of OOS_BREAKDOWN_KEYS) {
    const { min, max } = serviceBucketBounds(record, key);
    const value = next[key];
    if (value < min) {
      return key === "returned_to_service"
        ? "Units returned to service cannot go back out of it — record a new out-of-service record instead"
        : `${key.replace(/_/g, " ")} cannot go below ${min} on a closed record`;
    }
    if (max !== null && value > max) {
      return key === "flagged" && record.reason === "lost"
        ? "A lost unit is not on a shelf, so it cannot be flagged — return it to service and flag it on a new record"
        : `${key.replace(/_/g, " ")} can only go down on a closed record`;
    }
  }
  const sum = sumOOSBreakdown;
  if (sum(next) > record.quantity) return `Buckets place ${sum(next)} units but the record holds ${record.quantity}`;
  if (sum(next) < sum(record.breakdown)) {
    return "Units that went out of service cannot go back to 'not yet in effect' — return them to service, or cancel the record";
  }
  return null;
}

// ── generated docs ───────────────────────────────────────────────────

/**
 * The rule table as a markdown rung table — the source for the api's
 * `fulfillment-ladder` skill and the booking-action input's `/openapi.json`
 * description, so neither restates the table by hand.
 */
export function getCustodyRulesMarkdown(): string {
  const arm = (a: CustodyRule["rental"]) => (a === null ? "refused" : a.movement === null ? "no movement" : `\`${a.movement}\``);
  const svc = (r: CustodyRule) =>
    r.service === null ? "" : ` \`{${r.service.from} → ${r.service.to}}\``;
  const lines = [
    "| rule | custody | rental | sale | billable | what it means |",
    "|---|---|---|---|---|---|",
    ...CUSTODY_RULES.map((r) =>
      `| \`${r.id}\` | ${r.from === r.to ? `${r.from} (no custody)` : `${r.from} → ${r.to}`} | ${arm(r.rental)}${svc(r)} | ${arm(r.sale)} | ${
        r.billable ? "yes" : "no"
      } | ${r.description} |`
    ),
  ];
  return lines.join("\n") + "\n";
}

// ── loss-undo eligibility (stock campaign P1, api-cloudrun#1218) ─────

/** One out-of-service record as a loss undo reads it, with the mark that opened it. */
export interface LossRecordView {
  record: Pick<
    OutOfService,
    "uid" | "number" | "reason" | "quantity" | "breakdown" | "status" | "canceled_at" | "query_by_sources"
  >;
  /** The record's mark movement — the movement whose id the record carries — or `null` when none exists. */
  mark: Pick<Movement, "type" | "uid_booking" | "quantity" | "custody" | "lines"> | null;
  /**
   * Units of the record billed on an invoice, or `null` when the caller cannot
   * read invoices (the warehouse role): the refusal is then the server's alone.
   */
  billed: number | null;
}

/** Why a loss undo may not consume a record. */
export type LossUndoRefusalCode =
  | "canceled"
  | "other_booking"
  | "reclassified"
  | "split_sibling"
  | "no_mark"
  | "pre_journal_model"
  | "resolved"
  | "billed"
  | "split_original"
  | "quantity_mismatch";

/**
 * Why `view`'s record may NOT be consumed by an undo of `reason` on booking
 * `uid_booking`, or `null` when it may — the one rule behind the api's
 * `assertUndoable` and the manager's revert offer, which had drifted on billed
 * units (gap G11 (e)). Each message names the route that owns the record
 * instead, and is the api's 400 sentence verbatim.
 *
 * Checked in the api's order: a reclassified record (gap G3) and a split
 * sibling (api-cloudrun#1164) first, then a missing or wrong mark (the six
 * legacy auto-id records, #985), the pre-journal damaged model, any
 * written-off / returned-to-service progress, billed units, and a record a
 * reason edit split smaller than its mark.
 *
 * ⚠️ A PARTIAL undo of a record that passes is legal (api-cloudrun#1218): the
 * api cancels the record and re-opens the remainder with the original's
 * details and shelf, `flag_*_returned_undo` and unit-tracked bookings
 * included. A sale's loss writes no record (`sale_lost` is custody-only), so
 * this question never arises for one.
 */
export function lossUndoRefusal(
  view: LossRecordView,
  uid_booking: string,
  reason: CustodyLossKey,
): { code: LossUndoRefusalCode; message: string } | null {
  const { record, mark } = view;
  const label = `out-of-service record #${record.number}`;
  const at = `PUT /out-of-service-records/${record.uid}`;
  const refuse = (code: LossUndoRefusalCode, message: string) => ({ code, message });
  if (deriveOOSStatus(record) === "canceled") {
    return refuse("canceled", `Cannot undo ${label}: it is already canceled.`);
  }
  if (!record.query_by_sources.includes(`bookings:${uid_booking}`)) {
    return refuse("other_booking", `Cannot undo ${label}: it was not raised from this booking.`);
  }
  if (mark?.custody && mark.uid_booking === uid_booking && mark.custody.to !== record.reason) {
    return refuse(
      "reclassified",
      `Cannot decrease breakdown.${reason} via PUT /bookings — ${label} was reclassified from ` +
        `${mark.custody.to} to ${record.reason}; change it on the record (${at}).`,
    );
  }
  if (
    mark?.type === "flag" && mark.uid_booking === uid_booking && mark.custody?.from != null &&
    (OOS_FLAG_REASONS as readonly string[]).includes(mark.custody.from)
  ) {
    return refuse(
      "split_sibling",
      `Cannot decrease breakdown.${reason} via PUT /bookings — ${label} was split off another ` +
        `record when its reason changed, so it has no mark of its own to undo; adjust it on the record (${at}).`,
    );
  }
  // An in-building mark off `returned` is a `flag`; every other mark is its own type.
  const expectedType = reason === "lost"
    ? "mark_lost"
    : mark?.type === "flag" && mark.custody?.from === "returned"
    ? "flag"
    : `mark_${reason}`;
  if (
    mark === null || mark.type !== expectedType || mark.uid_booking !== uid_booking ||
    mark.custody === null || mark.custody.from === null
  ) {
    return refuse(
      "no_mark",
      `Cannot decrease breakdown.${reason} via PUT /bookings — ${label} has no mark movement ` +
        `to undo; adjust the OOS record itself (${at}).`,
    );
  }
  if (reason !== "lost" && mark.lines.some((l) => l.location.to?.collection !== "locations")) {
    return refuse(
      "pre_journal_model",
      `Cannot decrease breakdown.${reason} via PUT /bookings — ${label} predates the shelf-side ` +
        `damaged model; adjust the OOS record itself (${at}).`,
    );
  }
  if (record.breakdown.written_off > 0 || record.breakdown.returned_to_service > 0) {
    return refuse(
      "resolved",
      `Cannot undo ${label}: it already has units written off or returned to service. ` +
        `A unit that was lost and has turned up goes back through the record (${at}).`,
    );
  }
  if (view.billed !== null && view.billed > 0) {
    return refuse(
      "billed",
      `Cannot undo ${label}: ${view.billed} unit(s) of it are billed on an invoice. ` +
        `Credit the invoice, then return the units to service through the record (${at}).`,
    );
  }
  if (record.quantity < mark.quantity) {
    return refuse(
      "split_original",
      `Cannot undo ${label}: ${mark.quantity - record.quantity} of the ${mark.quantity} unit(s) its mark ` +
        `moved were split onto another record when the reason changed. Adjust it on the record (${at}).`,
    );
  }
  // More units on the record than its mark moved is a corrupt pair, not a state
  // any writer produces; refuse rather than negate a mark that undercounts.
  if (record.quantity !== mark.quantity) {
    return refuse("quantity_mismatch", `Cannot undo ${label}: it holds ${record.quantity} but its mark moved ${mark.quantity}.`);
  }
  return null;
}

/** Where a consumable record's mark took its units from: `out` or `returned`, or `null` when unreadable. */
export function lossRecordOrigin(view: LossRecordView): "out" | "returned" | null {
  const from = view.mark?.custody?.from;
  return from === "out" || from === "returned" ? from : null;
}

/**
 * How many units each loss-mark undo may take back on one booking — core's
 * {@link CustodyOfferContext.undoable}, read off the booking's records through
 * {@link lossUndoRefusal}, so the menu offers exactly what the api accepts.
 * Replaces the manager's `undoableFromRecords`, which restated the rule and
 * skipped billed units.
 */
export function undoableFromRecords(
  uid_booking: string,
  views: readonly LossRecordView[],
): Partial<Record<CustodyRuleId, number>> {
  const out: Partial<Record<CustodyRuleId, number>> = {};
  for (const view of views) {
    const reason = view.record.reason;
    if (!(OUT_OF_SERVICE_KEYS as readonly string[]).includes(reason)) continue;
    if (lossUndoRefusal(view, uid_booking, reason as CustodyLossKey) !== null) continue;
    const origin = lossRecordOrigin(view);
    if (origin === null) continue;
    const rule = undoRuleFor(reason as CustodyLossKey, origin);
    out[rule] = (out[rule] ?? 0) + view.record.quantity;
  }
  return out;
}

// ── reclassifying a record's reason (gap G3, api-cloudrun#1164) ──────

/**
 * Who owns a record's reason, read off its mark movement (the movement whose id
 * the record shares). Lifted from api-cloudrun `src/lib/recordReclassify.ts`.
 *
 * - `booking` — the mark carries custody on a booking the record's sources
 *   name: a reason edit moves that booking's bucket.
 * - `standalone` — POSTed on its own; its mark names no booking, so the edit is
 *   the record's alone.
 * - `legacy` — no mark, and the sources name a booking: units in a bucket no
 *   movement raised. Refused, as its undo is.
 */
export function recordOwner(
  record: Pick<OutOfService, "query_by_sources">,
  mark: Pick<Movement, "uid_booking" | "custody"> | null,
): { kind: "booking"; uid_booking: string } | { kind: "standalone" } | { kind: "legacy" } {
  if (mark === null) {
    return record.query_by_sources.some((s) => s.startsWith("bookings:")) ? { kind: "legacy" } : { kind: "standalone" };
  }
  if (mark.uid_booking && mark.custody && record.query_by_sources.includes(`bookings:${mark.uid_booking}`)) {
    return { kind: "booking", uid_booking: mark.uid_booking };
  }
  return { kind: "standalone" };
}

/** What a reason edit writes, or why it may not. */
export type ReclassificationPlan =
  | {
    ok: true;
    /** The one `flag {old → new}`; on a booking-raised record it carries custody `{old → new}`. */
    transition: CustodyTransition;
    /** Some units are away, written off or returned to service: they stay on the original, and a sibling takes the flagged ones. */
    split: boolean;
  }
  | { ok: false; message: string };

/**
 * The reason edit `to` on a record, or why it is refused — the one rule behind
 * the api's `planReclassification` and the manager's reason dropdown, which
 * offered edits the api refused (gap G11 (b)).
 *
 * Only the units still FLAGGED take the new reason (api-cloudrun#1164): the
 * movement is a `flag` in place, so a unit already cleared, written off or away
 * stays on the original as history and the flagged ones SPLIT onto a sibling.
 * On an UNCOUNTED product the units stand `away` and the whole record is
 * relabelled, or refused once any is resolved (api-cloudrun#1205 item 3).
 *
 * `booking` is the owning booking for a `booking`-owned record and `null`
 * otherwise. The record's VERSION is the api's precondition, not this rule.
 */
export function planReclassification(args: {
  record: Pick<OutOfService, "number" | "reason" | "status" | "quantity" | "breakdown" | "units">;
  owner: ReturnType<typeof recordOwner>["kind"];
  booking: Pick<Booking, "type" | "name" | "breakdown"> | null;
  to: OOSReasonType;
  uncounted: boolean;
}): ReclassificationPlan {
  const { record, owner, booking, to, uncounted } = args;
  const label = `out-of-service record #${record.number}`;
  const refuse = (message: string): ReclassificationPlan => ({ ok: false, message });
  if (TERMINAL_OOS_STATUSES.has(record.status)) {
    return refuse(`Cannot change the reason of ${label}: it is ${record.status}.`);
  }
  const flagReasons = OOS_FLAG_REASONS as readonly string[];
  const from = record.reason;
  if (!flagReasons.includes(from) || !flagReasons.includes(to) || from === to) {
    return refuse(`Cannot change ${label} from ${from} to ${to}.`);
  }
  if (owner === "legacy") {
    return refuse(
      `Cannot change the reason of ${label}: it has no mark movement, so the booking's bucket was never raised by one. Adjust the booking by hand.`,
    );
  }
  // Only a line that comes back carries cleaning and maintenance buckets (P2b ruling 4).
  if (owner === "booking" && (booking === null || !ownsKey(booking.type, "out"))) {
    return refuse(
      `Cannot change the reason of ${label}: a ${booking?.type ?? "missing"} booking takes no cleaning or maintenance.`,
    );
  }
  if (uncounted) {
    const resolved = record.breakdown.written_off + record.breakdown.returned_to_service;
    if (resolved > 0) {
      return refuse(
        `Cannot change the reason of ${label}: its product is uncounted, so the record is relabelled whole, ` +
          `and ${resolved} of its units are already written off or returned to service. Open a new record ` +
          "for the units still away instead.",
      );
    }
  }
  const flagged = uncounted ? record.breakdown.away : record.breakdown.flagged;
  if (flagged === 0) {
    return refuse(
      `Cannot change the reason of ${label}: none of its units is flagged on a shelf, so there is ` +
        "nothing to re-describe.",
    );
  }
  if (owner === "booking" && booking !== null) {
    const held = breakdownQuantity(booking.breakdown, from as OutOfServiceKeyType);
    if (held < flagged) {
      return refuse(
        `Cannot change the reason of ${label}: ${booking.name} holds ${held} ${from}, ` +
          `not the ${flagged} this record has flagged. Reconcile the booking by hand.`,
      );
    }
  }
  const rule = custodyRule(`reclassify_${from}_to_${to}` as CustodyRuleId);
  return {
    ok: true,
    transition: {
      rule: rule.id,
      type: "flag",
      from: rule.from,
      to: rule.to,
      quantity: flagged,
      service: serviceFor(rule),
      units: record.units?.flagged ?? [],
    },
    split: !uncounted && flagged < record.quantity,
  };
}

/** {@link planReclassification}'s refusal sentence, or `null` when the edit is legal. */
export function reclassifyRefusal(args: Parameters<typeof planReclassification>[0]): string | null {
  const plan = planReclassification(args);
  return plan.ok ? null : plan.message;
}

// ── undoing a rental extension (api-cloudrun#1235, gap G11 (d)) ──────

/** What an extension undo returns, or why it may not. */
export type ExtensionUndoPlan =
  | {
    ok: true;
    /** Leg A, the pair the units go back to. */
    pairFrom: string;
    /** The units out on leg B, all of which return to A. */
    units: number;
  }
  | { ok: false; message: string };

/**
 * Whether leg `pairUid` is an extension leg that can still be undone — the one
 * rule behind the api route's journal check, its in-transaction
 * `assertUntouched`, and the manager's offer (which skipped the unit and leg-A
 * checks, gap G11 (d)). No stored marker says a leg came from an extension; the
 * journal does.
 *
 * Refused unless:
 * - the leg holds bookings, and every movement on them is the `rebook_in` that
 *   put their units there (a check-in, mark or prep since refuses);
 * - every booking on the leg holds nothing but the `out` the order still asks
 *   for (`quantity_ordered`), exactly the quantity its `rebook_in`s brought,
 *   and on a serialized booking exactly the units they named;
 * - the `rebook_in`s name bookings on ONE other leg, A, which the order still
 *   carries.
 *
 * A live invoice billing leg B is the api's refusal alone: it needs invoices.
 * The api must evaluate this on bookings read INSIDE its transaction.
 */
export function extensionUndoRefusal(args: {
  pairUid: string;
  /** Every destination pair uid the order carries now. */
  orderPairUids: readonly string[];
  /** The order's bookings; those on leg B are picked by their id's leg segment. */
  bookings: readonly Pick<Booking, "uid" | "name" | "breakdown" | "quantity_ordered" | "units">[];
  /** Every movement on leg B's bookings. */
  movements: readonly Pick<Movement, "uid" | "type" | "uid_booking" | "sources" | "quantity" | "units">[];
}): ExtensionUndoPlan {
  const refuse = (message: string): ExtensionUndoPlan => ({ ok: false, message });
  const onLeg = args.bookings.filter((b) => parseBookingId(b.uid)?.destUid === args.pairUid);
  if (onLeg.length === 0) return refuse("This leg holds no units an extension moved");
  const ids = new Set(onLeg.map((b) => b.uid));
  const moves = args.movements.filter((m) => m.uid_booking != null && ids.has(m.uid_booking));
  const rebooksIn = moves.filter((m) => m.type === "rebook_in");
  if (rebooksIn.length === 0) return refuse("This leg was not made by an extension, so there is nothing to undo");
  const later = moves.find((m) => m.type !== "rebook_in");
  if (later !== undefined) {
    return refuse(`This leg has had a ${later.type.replaceAll("_", " ")} since the extension, so it cannot be undone`);
  }
  const legs = new Set(
    rebooksIn.flatMap((m) =>
      m.sources.filter((s) => s.collection === "bookings").map((s) => parseBookingId(s.uid)?.destUid ?? "")
    ),
  );
  const [pairFrom] = legs;
  if (legs.size !== 1 || !pairFrom || pairFrom === args.pairUid) {
    return refuse("This leg's units came from more than one leg, so it cannot be undone in one step");
  }
  if (!args.orderPairUids.includes(pairFrom)) return refuse("The leg this one was extended from is no longer on the order");

  let units = 0;
  for (const b of onLeg) {
    const out = b.breakdown.out;
    const brought = rebooksIn.filter((m) => m.uid_booking === b.uid);
    if (brought.length === 0) {
      if (sumBookingBreakdown(b.breakdown) === 0) continue;
      return refuse(`${b.name}: this leg's booking was changed after the extension, so it cannot be undone`);
    }
    if (sumBookingBreakdown(b.breakdown) !== out || b.quantity_ordered !== out) {
      return refuse(
        `${b.name}: units on this leg have moved since the extension (checked in, marked or re-ordered), so it cannot be undone`,
      );
    }
    const quantity = brought.reduce((n, m) => n + m.quantity, 0);
    if (quantity !== out) return refuse(`${b.name}: the undo returns ${quantity} of the ${out} out on this leg`);
    if (b.units != null) {
      const named = new Set(brought.flatMap((m) => m.units.map((u) => u.number)));
      if (b.units.out.length !== out || b.units.out.some((n) => !named.has(n)) || named.size !== out) {
        return refuse(`${b.name}: this leg's units changed since the extension, so it cannot be undone`);
      }
    }
    units += out;
  }
  if (units === 0) return refuse("This leg holds no units an extension moved");
  return { ok: true, pairFrom, units };
}

// ── custody moving between bookings (stock campaign decisions 1 and 11) ──

/** One booking in a custody transfer: its breakdown (and unit sets) before and after the write. */
export interface CustodyTransferMember {
  uid: string;
  /** `null` for a booking the write creates. */
  before: BookingBreakdown | null;
  /** `null` for a booking the write deletes. */
  after: BookingBreakdown | null;
  /** Unit sets before and after, on a unit-tracked booking; absent or `null` on a bulk one. */
  unitsBefore?: BookingUnitSetsType | null;
  unitsAfter?: BookingUnitSetsType | null;
}

/** One movement half a transfer journals. */
export interface CustodyTransferHalf {
  type: "rebook_out" | "rebook_in" | "unprep" | "prep";
  uid_booking: string;
  quantity: number;
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null };
  /** The booking on the other side, named in the movement's `sources[]`. */
  counterpart: string;
  /** The units it names, ascending; `[]` on a bulk booking. */
  units: number[];
}

/** One bucket's worth of a transfer: its halves, outs before ins, in apply order. */
export interface CustodyTransferStep {
  bucket: BookingBreakdownKeyType;
  halves: CustodyTransferHalf[];
}

/** What a transfer journals, or why it may not happen. */
export type CustodyTransferPlan = { ok: true; steps: CustodyTransferStep[] } | { ok: false; message: string };

/**
 * The movements that journal custody moving BETWEEN bookings — the one planner
 * behind the complete-order grain carry (api-cloudrun#1204), the rental
 * extension's rebook pair (decision 11), a substitution's prepped units
 * (decision 1) and a complete-order repoint. The caller decides each member's
 * `after`; this says whether that is a legal transfer and what records it.
 *
 * **Same product** (carry, extension, repoint): per custody-history bucket, a
 * lineless `rebook_out` `{bucket → null}` on every booking that gives units and
 * a `rebook_in` `{null → bucket}` on every one that takes them, outs before
 * ins. A `rebook_in` names the LARGEST giver as its counterpart (the legacy
 * booking, in every measured carry) and a `rebook_out` the FIRST taker, so a
 * caller minting ids from these reproduces the grain carry's byte for byte. On
 * unit-tracked members each half names the units that left or joined the
 * bucket, and the two sides must name the same ones.
 *
 * **Different products** (a substitution): only `prepped` may move, as an
 * `unprep` `{prepped → reserved}` on each giver and a `prep`
 * `{reserved → prepped}` on each taker. Refused when any custody past prepped
 * would move, or when a member is unit-tracked (its units cannot be renamed
 * onto another product). A sale has no rewind path here: the operator adds a
 * line.
 *
 * Refused in both modes when a custody bucket does not net to zero across the
 * members: a transfer moves custody, it never creates or destroys it. The plan
 * keys (`quoted`, `reserved`) are the order's and are not compared, except
 * that a cross-product `unprep`/`prep` lands in them.
 */
export function planCustodyTransfer(args: {
  members: readonly CustodyTransferMember[];
  sameProduct: boolean;
}): CustodyTransferPlan {
  const refuse = (message: string): CustodyTransferPlan => ({ ok: false, message });
  const { members, sameProduct } = args;
  const tracked = members.filter((m) => m.unitsBefore != null || m.unitsAfter != null);
  if (tracked.length > 0 && tracked.length !== members.length) {
    return refuse("Custody cannot move between a booking that tracks units and one that does not");
  }
  const steps: CustodyTransferStep[] = [];
  for (const bucket of CUSTODY_HISTORY_KEYS) {
    const deltas = members
      .map((m) => ({
        m,
        delta: (m.after ? fullBookingBreakdown(m.after)[bucket] : 0) - (m.before ? fullBookingBreakdown(m.before)[bucket] : 0),
      }))
      .filter((d) => d.delta !== 0);
    if (deltas.length === 0) continue;
    const net = deltas.reduce((n, d) => n + d.delta, 0);
    if (net !== 0) {
      return refuse(`The ${bucket} units on these bookings change by ${net} in total: a transfer cannot create or remove custody`);
    }
    if (!sameProduct) {
      if (bucket !== "prepped") {
        return refuse(
          `${deltas[0].m.uid}: ${bucket} units cannot move to another product. Only prepped units move with a substitution; ` +
            "add a line for the rest.",
        );
      }
      if (tracked.length > 0) {
        return refuse(
          `${tracked[0].uid}: its units are tracked by number, so prepped units cannot move to another product. ` +
            "Unprep them, and prep the substitute's units.",
        );
      }
    }
    const givers = deltas.filter((d) => d.delta < 0);
    const takers = deltas.filter((d) => d.delta > 0);
    const moved = (m: CustodyTransferMember, sign: 1 | -1): number[] => {
      if (m.unitsBefore == null && m.unitsAfter == null) return [];
      const key = bucket as BookingUnitBucketType;
      const before = new Set(m.unitsBefore?.[key] ?? []);
      const after = new Set(m.unitsAfter?.[key] ?? []);
      const [from, to] = sign < 0 ? [before, after] : [after, before];
      return [...from].filter((n) => !to.has(n)).sort((a, b) => a - b);
    };
    if (tracked.length > 0) {
      const out = givers.flatMap((g) => moved(g.m, -1)).sort((a, b) => a - b);
      const inn = takers.flatMap((t) => moved(t.m, 1)).sort((a, b) => a - b);
      if (JSON.stringify(out) !== JSON.stringify(inn) || out.length !== -givers.reduce((n, g) => n + g.delta, 0)) {
        return refuse(`The ${bucket} units leaving and joining these bookings are not the same units`);
      }
    }
    const main = [...givers].sort((a, b) => a.delta - b.delta)[0].m;
    const halves: CustodyTransferHalf[] = [];
    for (const g of givers) {
      halves.push(
        sameProduct
          ? { type: "rebook_out", uid_booking: g.m.uid, quantity: -g.delta, custody: { from: bucket, to: null }, counterpart: takers[0].m.uid, units: moved(g.m, -1) }
          : { type: "unprep", uid_booking: g.m.uid, quantity: -g.delta, custody: { from: "prepped", to: "reserved" }, counterpart: takers[0].m.uid, units: [] },
      );
    }
    for (const t of takers) {
      halves.push(
        sameProduct
          ? { type: "rebook_in", uid_booking: t.m.uid, quantity: t.delta, custody: { from: null, to: bucket }, counterpart: main.uid, units: moved(t.m, 1) }
          : { type: "prep", uid_booking: t.m.uid, quantity: t.delta, custody: { from: "reserved", to: "prepped" }, counterpart: main.uid, units: [] },
      );
    }
    steps.push({ bucket, halves });
  }
  return { ok: true, steps };
}

/**
 * How many of X's units a substitution may carry onto another product, or why
 * it may carry none — the picker's offer, from the same rule
 * {@link planCustodyTransfer} enforces (decision 1).
 */
export function substitutionCapacity(
  x: Pick<Booking, "uid" | "breakdown"> & Partial<Pick<Booking, "units">>,
): { prepped: number; refusal: string | null } {
  const b = fullBookingBreakdown(x.breakdown);
  const past = sumBreakdownKeys(b, CUSTODY_HISTORY_KEYS.filter((k) => k !== "prepped"));
  if (past > 0) {
    return {
      prepped: 0,
      refusal: `${past} unit(s) are already past the prep shelf (out, back or out of service), so this line cannot be ` +
        "substituted. Add a line for the replacement instead.",
    };
  }
  if (x.units != null && b.prepped > 0) {
    return { prepped: 0, refusal: "Its units are tracked by number: unprep them, then prep the substitute's units." };
  }
  return { prepped: b.prepped, refusal: null };
}
