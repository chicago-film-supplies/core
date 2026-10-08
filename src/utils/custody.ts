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
  type MovementTypeType,
  type OOSBreakdown,
  type OOSBreakdownKeyType,
  OOS_BREAKDOWN_KEYS,
  type OOSReasonType,
  type OutOfService,
  OUT_OF_SERVICE_KEYS,
  type OutOfServiceKeyType,
  ownsKey,
  CUSTODY_PLACE_KINDS,
  MOVEMENT_CONTRACTS,
  type PlaceKindType,
} from "../schemas/mod.ts";
import {
  breakdownQuantity,
  type FullBookingBreakdown,
  fullBookingBreakdown,
  isBookingClosed,
  sumBreakdownKeys,
  terminalQuantity,
} from "./bookings.ts";
import { sumOOSBreakdown } from "./out-of-service.ts";
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
 * The actions an offer sends for `quantity` units.
 *
 * Every offer is one action except `check_out` over units still `reserved`:
 * those are prepped on the way, so the offer sends `[prep, check_out]`. It
 * draws the already-prepped units FIRST — the ones on the prep shelf are the
 * ones going out — and preps only the shortfall.
 */
export function expandCustodyOffer(
  booking: CustodyBooking,
  offer: Pick<CustodyOffer, "rule">,
  quantity: number,
): BookingActionType[] {
  if (offer.rule === "check_out") {
    const toPrep = Math.max(0, quantity - booking.breakdown.prepped);
    return [
      ...(toPrep > 0 ? [{ rule: "prep" as const, quantity: toPrep }] : []),
      { rule: "check_out", quantity },
    ];
  }
  return [{ rule: offer.rule, quantity }];
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
 * pre-departure key into `lost`/`damaged` has no row at all (gap G1); a sale
 * rewind is refused (api-cloudrun#1054); and a sale never takes `cleaning` or
 * `maintenance` (P2b ruling 4). A service or surcharge booking holds no
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
  const mid = fullBookingBreakdown(prev);
  if (!isSale) {
    const grouped = new Map<CustodyRuleId, number>();
    for (const u of undos) {
      mid[u.reason] -= u.quantity;
      mid[u.origin] += u.quantity;
      const id = undoRuleFor(u.reason, u.origin);
      grouped.set(id, (grouped.get(id) ?? 0) + u.quantity);
    }
    for (const [id, q] of grouped) add(id, q);
  }

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
  if (isSale) {
    // Legal, and no movement: the units already left CFS ownership.
    add("mark_damaged", take("out", "damaged"));
    add("mark_lost", take("out", "lost"));
    add("unprep", unprepDirect);
  } else {
    add("mark_damaged", take("out", "damaged"));
    add("mark_lost", take("out", "lost"));
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

    const outFromReturned = take("returned", "out");
    const preppedFromOut = take("out", "prepped");
    const reservedFromOut = take("out", "reserved");
    const preppedFromReturned = take("returned", "prepped");
    const reservedFromReturned = take("returned", "reserved");
    add("check_in_undo", outFromReturned + preppedFromReturned + reservedFromReturned);
    add("check_out_undo", preppedFromOut + reservedFromOut + preppedFromReturned + reservedFromReturned);
    add("unprep", unprepDirect + reservedFromOut + reservedFromReturned);
  }

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
  const PREFERENCE: ReadonlyArray<[ServicePlace, readonly ServicePlace[]]> = [
    ["written_off", ["away", "flagged", "unplaced"]],
    ["returned_to_service", ["away", "flagged", "unplaced"]],
    ["away", ["flagged", "unplaced"]],
    ["flagged", ["away", "unplaced"]],
  ];
  const moves: ServiceBucketMove[] = [];
  for (const [to, sources] of PREFERENCE) {
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
