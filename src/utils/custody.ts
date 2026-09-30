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
  type Booking,
  type BookingActionType,
  type BookingBreakdown,
  type BookingBreakdownKeyType,
  CUSTODY_FLAG_REASONS,
  CUSTODY_RULES,
  type CustodyFlagReasonType,
  type CustodyRule,
  type CustodyRuleId,
  custodyRule,
  duplicateCustodySlots,
  isLossUndo,
  type MovementTypeType,
  type OOSBreakdown,
  type OOSBreakdownKeyType,
  OOS_BREAKDOWN_KEYS,
  type OOSReasonType,
  type OutOfService,
} from "../schemas/mod.ts";

/** The breakdown keys, ladder order. */
const KEYS: readonly BookingBreakdownKeyType[] = [
  "quoted",
  "reserved",
  "prepped",
  "out",
  "returned",
  "lost",
  "damaged",
];

/** A booking as the ruleset reads it. */
export type CustodyBooking = Pick<Booking, "type" | "breakdown" | "quantity" | "status">;

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
  /** The flag's service axis with the action's reason filled in; `null` off the flag rows. */
  service: { from: OOSReasonType | null; to: OOSReasonType | null } | null;
}

/** The arm a booking type takes under a rule, or `null`: the type may not take it. */
function armFor(rule: CustodyRule, type: Booking["type"]) {
  if (type === "rental") return rule.rental;
  if (type === "sale") return rule.sale;
  return null;
}

function serviceFor(rule: CustodyRule, reason: CustodyFlagReasonType | undefined): CustodyTransition["service"] {
  if (rule.service === null) return null;
  const side = (s: "none" | "damaged" | "reason"): OOSReasonType | null =>
    s === "none" ? null : s === "damaged" ? "damaged" : (reason ?? null);
  return { from: side(rule.service.from), to: side(rule.service.to) };
}

// ── status ───────────────────────────────────────────────────────────

/**
 * A booking's status, read off its breakdown. ONE rule for every custody
 * write; the manager had two (a forward one and a regression one), and this is
 * the regression one, because it is a function of the state alone.
 *
 * | breakdown                        | status          |
 * |----------------------------------|-----------------|
 * | returned + lost + damaged = qty  | `complete`      |
 * | out > 0                          | `active`        |
 * | prepped = qty                    | `prepped`       |
 * | prepped > 0 and reserved > 0     | `part-prepped`  |
 * | reserved = qty                   | `reserved`      |
 * | anything else                    | unchanged       |
 *
 * ⚠️ A sale fully `out` reads `active`, not `complete`, exactly as the manager's
 * check-out has always sent it. Whether a sale's `out` closes the booking is
 * `isBookingClosed`'s question (`utils/bookings.ts`), and it answers per order,
 * at finalize.
 */
export function deriveCustodyStatus(
  breakdown: BookingBreakdown,
  quantity: number,
  current: Booking["status"],
): Booking["status"] {
  const terminal = breakdown.returned + breakdown.lost + breakdown.damaged;
  if (terminal === quantity) return "complete";
  if (breakdown.out > 0) return "active";
  if (breakdown.prepped === quantity) return "prepped";
  if (breakdown.prepped > 0 && breakdown.reserved > 0) return "part-prepped";
  if (breakdown.reserved === quantity) return "reserved";
  return current;
}

// ── apply ────────────────────────────────────────────────────────────

/** What a list of actions does to a booking. */
export interface CustodyApplication {
  breakdown: BookingBreakdown;
  status: Booking["status"];
  /** One per action that writes a movement, in action order. */
  transitions: CustodyTransition[];
}

/** Server knowledge the pure booking cannot carry. */
export interface CustodyApplyContext {
  /**
   * Returned units carrying no flag, before this save. Bounds the flags a save
   * may add (`flag_returned`, `flag_damaged_returned`). Defaults to
   * `breakdown.returned`, which is right for a caller that cannot see the shelf
   * and is re-checked by the server against the shelves.
   */
  unflaggedReturned?: number;
}

/**
 * Apply `actions`, in order, to the booking's CURRENT state.
 *
 * Throws {@link CustodyRefusal} on an unknown rule, a rule the booking type may
 * not take, a short source bucket, a missing or stray reason, two actions that
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
  const breakdown: BookingBreakdown = { ...booking.breakdown };
  let unflagged = ctx.unflaggedReturned ?? breakdown.returned;
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
    const needsReason = rule.service !== null && (rule.service.from === "reason" || rule.service.to === "reason");
    if (needsReason !== (action.reason !== undefined)) {
      throw new CustodyRefusal(
        needsReason ? `"${rule.id}" needs a reason: ${CUSTODY_FLAG_REASONS.join(" or ")}` : `"${rule.id}" takes no reason`,
        rule.id,
      );
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
    if (rule.id === "flag_returned" || rule.id === "flag_damaged_returned") {
      if (unflagged < action.quantity) {
        throw new CustodyRefusal(
          `"${rule.id}" flags ${action.quantity}, but only ${unflagged} returned unit(s) are unflagged`,
          rule.id,
        );
      }
      unflagged -= action.quantity;
    }
    breakdown[rule.from] -= action.quantity;
    breakdown[rule.to] += action.quantity;
    if (rule.id === "check_in") unflagged += action.quantity;

    if (arm.movement !== null) {
      transitions.push({
        rule: rule.id,
        type: arm.movement,
        from: rule.from,
        to: rule.to,
        quantity: action.quantity,
        service: serviceFor(rule, action.reason),
      });
    }
  }
  return {
    breakdown,
    status: deriveCustodyStatus(breakdown, booking.quantity, booking.status),
    transitions,
  };
}

// ── offers ───────────────────────────────────────────────────────────

/**
 * One action the UI may offer on a booking row.
 *
 * `key` is what a menu de-duplicates on — the rule id, plus the reason for the
 * two `flag_returned` offers. Expand an offer into the actions to send with
 * {@link expandCustodyOffer}; a `check_out` over reserved units is two steps.
 */
export interface CustodyOffer {
  key: string;
  rule: CustodyRuleId;
  reason?: CustodyFlagReasonType;
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
   * Absent, every `lost`/`damaged` unit is read as marked off `out` and
   * undoable, which is the reading the delta form always planned with
   * (`canonicalLossUndos`); the server re-checks against the records.
   */
  undoable?: Partial<Record<"mark_lost_undo" | "mark_damaged_undo" | "mark_lost_returned_undo" | "flag_damaged_returned_undo", number>>;
}

/**
 * Every action the UI may offer on this booking, natural next first, then
 * forward in ladder order, then undos.
 *
 * Replaces `actionAlternatesForBooking`, `regressionAlternatesForBooking`,
 * `sourceBucketSizeForBooking` and `actionableQtyTowardTarget`. Two behaviours
 * change, both by owner ruling (2026-09-29):
 *
 * - **No pre-departure loss.** `reserved`/`prepped` units are never offered
 *   Lost or Damaged (gap G1). The fulfillment offers `unprep` plus a shelf
 *   out-of-service record instead.
 * - **Returned units get their own losses and flags** (gap G5): Lost, Damaged,
 *   Flag Cleaning and Flag Maintenance off `returned`, so `‹ Out` is no longer
 *   the only way to reach them.
 */
export function custodyActionsFor(booking: CustodyBooking, ctx: CustodyOfferContext): CustodyOffer[] {
  if (booking.type !== "rental" && booking.type !== "sale") return [];
  const b = booking.breakdown;
  const unflagged = Math.min(ctx.unflaggedReturned ?? b.returned, b.returned);
  const undoable = ctx.undoable ?? { mark_lost_undo: b.lost, mark_damaged_undo: b.damaged };
  const natural: CustodyRuleId | null = b.reserved > 0
    ? "prep"
    : b.prepped > 0
    ? "check_out"
    : b.out > 0 && booking.type === "rental"
    ? "check_in"
    : null;

  const maxFor = (id: CustodyRuleId): number => {
    switch (id) {
      case "prep":
        return ctx.canPrepCheckout ? b.reserved : 0;
      case "check_out":
        return ctx.canPrepCheckout ? b.reserved + b.prepped : 0;
      case "flag_returned":
      case "flag_damaged_returned":
        return unflagged;
      case "mark_lost_undo":
      case "mark_damaged_undo":
      case "mark_lost_returned_undo":
      case "flag_damaged_returned_undo":
        return Math.min(undoable[id] ?? 0, b[custodyRule(id).from]);
      // Record-page actions, never a booking-row offer.
      case "reclassify_damaged_to_flag":
      case "reclassify_flag_to_damaged":
        return 0;
      default:
        return b[custodyRule(id).from];
    }
  };

  const offers: CustodyOffer[] = [];
  for (const rule of CUSTODY_RULES) {
    if (armFor(rule, booking.type) === null) continue;
    const max = maxFor(rule.id);
    if (max <= 0) continue;
    const reasons: (CustodyFlagReasonType | undefined)[] = rule.id === "flag_returned" ? [...CUSTODY_FLAG_REASONS] : [undefined];
    for (const reason of reasons) {
      offers.push({
        key: reason ? `${rule.id}:${reason}` : rule.id,
        rule: rule.id,
        ...(reason ? { reason } : {}),
        max,
        natural: rule.id === natural,
        direction: rule.direction,
        stage: rule.stage,
      });
    }
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
  offer: Pick<CustodyOffer, "rule" | "reason">,
  quantity: number,
): BookingActionType[] {
  if (offer.rule === "check_out") {
    const toPrep = Math.max(0, quantity - booking.breakdown.prepped);
    return [
      ...(toPrep > 0 ? [{ rule: "prep" as const, quantity: toPrep }] : []),
      { rule: "check_out", quantity },
    ];
  }
  return [{ rule: offer.rule, quantity, ...(offer.reason ? { reason: offer.reason } : {}) }];
}

// ── decomposing a delta ──────────────────────────────────────────────

/** A loss key a delta may lower, and where its mark took the units from. */
export interface CustodyLossUndo {
  reason: "lost" | "damaged";
  origin: BookingBreakdownKeyType;
  quantity: number;
}

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
function undoRuleFor(reason: "lost" | "damaged", origin: BookingBreakdownKeyType): CustodyRuleId {
  if (origin === "out") return reason === "lost" ? "mark_lost_undo" : "mark_damaged_undo";
  if (origin === "returned") return reason === "lost" ? "mark_lost_returned_undo" : "flag_damaged_returned_undo";
  throw new Error(`a ${reason} mark cannot have come from "${origin}"`);
}

/**
 * Every fallen loss unit read as marked off `out` — for PLANNING, where no
 * record is at hand. The server reads the real origin off each consumed
 * record's mark movement.
 */
export function canonicalLossUndos(prev: BookingBreakdown, next: BookingBreakdown): CustodyLossUndo[] {
  const undos: CustodyLossUndo[] = [];
  for (const reason of ["lost", "damaged"] as const) {
    const fall = prev[reason] - next[reason];
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
 * pre-departure key into `lost`/`damaged` has no row at all (gap G1); and a sale
 * rewind is refused (api-cloudrun#1054). A service or surcharge booking holds no
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
  const mid: BookingBreakdown = { ...prev };
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
  for (const key of KEYS) {
    const delta = next[key] - mid[key];
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
        service: serviceFor(rule, undefined),
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
 * A flag's reason side reads as `reason` when it is cleaning or maintenance.
 */
export function custodyRuleForMovement(
  type: MovementTypeType,
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null } | null,
  service: { from: OOSReasonType | null; to: OOSReasonType | null } | null | undefined,
  bookingType: "rental" | "sale",
): CustodyRule | null {
  const sideOf = (r: OOSReasonType | null) => (r === null ? "none" : r === "damaged" ? "damaged" : "reason");
  return CUSTODY_RULES.find((rule) => {
    const arm = bookingType === "rental" ? rule.rental : rule.sale;
    if (arm?.movement !== type) return false;
    const carriesCustody = rule.from !== rule.to;
    if (!carriesCustody) {
      if (custody !== null) return false;
    } else if (custody === null || custody.from !== rule.from || custody.to !== rule.to) return false;
    if (rule.service === null) return true;
    if (!service) return false;
    return sideOf(service.from) === rule.service.from && sideOf(service.to) === rule.service.to;
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
  const placed = (b: OOSBreakdown) => b.flagged + b.away + b.written_off + b.returned_to_service;
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
 * the input rather than a failed save. Lifted from
 * `manager/src/utils/oosBreakdownBounds.ts`.
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
  const closed = record.status === "complete" || record.status === "canceled";
  if (key === "flagged" && record.reason === "lost") return { min: 0, max: 0 };
  if (closed) return key === "written_off" ? { min: 0, max: stored } : { min: stored, max: null };
  if (key === "returned_to_service") return { min: stored, max: null };
  return { min: 0, max: null };
}

/** Whether a record's breakdown can be edited at all. A closed record with nothing written off cannot. */
export function canEditServiceBreakdown(record: Pick<OutOfService, "status" | "breakdown">): boolean {
  const closed = record.status === "complete" || record.status === "canceled";
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
  const sum = (b: OOSBreakdown) => b.flagged + b.away + b.written_off + b.returned_to_service;
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
