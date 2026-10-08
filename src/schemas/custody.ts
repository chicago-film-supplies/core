/**
 * The custody ruleset: which change to a booking's breakdown is LEGAL, and
 * which movement records it.
 *
 * One row per legal step. The api's booking lever refuses anything that is not
 * a sequence of these rows, the manager builds its menus from them, and a
 * repair script decomposes a breakdown delta into them. Before this table the
 * rule lived in three places — the manager's menus and its breakdown flattening,
 * the alternates vocabulary in `utils/fulfillment-stage.ts`, and the api's
 * `deriveCustodyTransitions`, which reverse-engineered movements from an
 * absolute breakdown — and they had drifted: the manager offered
 * `reserved → lost` and the api accepted it with no movement and no record.
 *
 * ## What a row does NOT restate
 *
 * Places, cost, booking, custody mode and service mode belong to
 * {@link MOVEMENT_CONTRACTS}, and a row names only its movement TYPE. What the
 * contracts lack, and what this table adds, is the binding between a type and
 * the custody pair it carries: nothing checked that a `check_in` moves
 * `out → returned` until this existed. `tests/custody.test.ts` cross-checks
 * every row against the contracts and {@link CUSTODY_PLACE_KINDS}.
 *
 * ## Kept apart from the propagation catalog, on purpose
 *
 * `@cfs/core/schemas/propagation` says which DATA flows between collections;
 * this says which STATE CHANGE is legal and which EVENT records it. The two
 * share conventions (typed ids, `enforced_by`, one exported table) and nothing
 * else.
 *
 * ## Sales (stock campaign decision 5)
 *
 * A sale's `out` is the customer's (`ownsKey`), so its rows split two ways:
 *
 * - `out → lost` / `out → damaged` and their undos write `sale_lost` /
 *   `sale_damaged` (and `_undo`): CUSTODY-ONLY movements with no place and no
 *   cost, so the journal replays. They wrote nothing until P1 (gap G6).
 * - the rewinds `check_out_undo` / `check_in_undo` write `sale_undo` /
 *   `sale_return_undo`: TYPED REVERSALS that move ownership and carry the exact
 *   basis back (api-cloudrun#1054).
 *
 * A sale never takes a shelf loss or flag, nor `cleaning`/`maintenance` (P2b
 * ruling 4).
 *
 * @module
 */
import { z } from "zod";
import { BookingId, OutOfServiceId } from "./_uid.ts";
import { UnitSet } from "./unit.ts";
import {
  BOOKING_BREAKDOWN_KEYS,
  type BookingBreakdownKeyType,
  OUT_OF_SERVICE_KEYS,
  type OutOfServiceKeyType,
} from "./_breakdown.ts";
import type { MovementTypeType } from "./transaction.ts";
import type { EnforcementRef } from "./propagation/types.ts";
import { COMPONENT_TYPES, type ComponentTypeType, type OOSFlagReasonType } from "./common.ts";
import { isCollectionLineType } from "./order.ts";

// ── Ownership ────────────────────────────────────────────────────────

/**
 * The breakdown keys a booking's units reach only by LEAVING the building with
 * the customer: `out`, and every out-of-service key a unit can only reach from
 * `out` or from a return of it. Whether CFS still owns units there depends on
 * whether the line comes back.
 */
const LEFT_WITH_THE_CUSTOMER: ReadonlySet<BookingBreakdownKeyType> = new Set([
  "out", "lost", "damaged", "cleaning", "maintenance",
]);

/**
 * Whether CFS still OWNS a booking's units in `key` — **the one author of "a
 * sale's `out` is no longer CFS's"** (stock campaign, P1).
 *
 * | booking type | owns |
 * |---|---|
 * | a line that comes back (`rental`, {@link isCollectionLineType}) | every key |
 * | anything else (`sale`, `service`, `surcharge`) | the plan keys, `prepped` and `returned` — never `out` or an out-of-service key |
 *
 * A sale's units leave CFS ownership at the check-out (the `sale` movement
 * draws cost) and re-enter it only on a `sale_return`, so the units a sale
 * holds in `out`, or in `lost`/`damaged` after leaving, are the customer's.
 *
 * Everything that asks "is this `out` in flight?", "does this booking still
 * hold units?", "is it closed?" reads this predicate rather than testing
 * `type === "rental"` or `type === "sale"`: about twenty hand-written copies
 * of that test had drifted (core `deriveCustodyStatus` read a fully-out sale
 * as `active` while `isBookingClosed` read it closed).
 *
 * ⚠️ **`service` and `surcharge` read like a sale, and that settles a split.**
 * `heldByBooking` used to keep their `out` held while `isBookingClosed` and
 * `liveCustody` read it terminal. Neither type carries an inventory ledger, so
 * no availability answer moves; the rule just stops having two answers.
 */
export function ownsKey(bookingType: string, key: BookingBreakdownKeyType): boolean {
  return isCollectionLineType(bookingType) || !LEFT_WITH_THE_CUSTOMER.has(key);
}

/**
 * {@link ownsKey}, tabulated per booking type in breakdown order — for a reader
 * that wants the key list rather than the predicate. Derived, so it cannot
 * drift from the predicate.
 */
export const OWNED_KEYS_BY_TYPE: Readonly<Record<ComponentTypeType, readonly BookingBreakdownKeyType[]>> = (() => {
  const table = {} as Record<ComponentTypeType, readonly BookingBreakdownKeyType[]>;
  for (const t of COMPONENT_TYPES) table[t] = BOOKING_BREAKDOWN_KEYS.filter((k) => ownsKey(t, k));
  return table;
})();

// ── Rule ids ─────────────────────────────────────────────────────────

/**
 * Every custody rule id. A literal list with its union derived from it, the
 * same spelling as `MOVEMENT_TYPES`: the wire validates against it at runtime,
 * and `tests/custody.test.ts` asserts it equals the table's ids in both
 * directions, so a row with no id here and an id with no row both fail.
 *
 * The manager de-duplicates its menus by these ids, never by a label.
 */
export const CUSTODY_RULE_IDS = [
  // the ladder
  "prep",
  "unprep",
  "check_out",
  "check_out_undo",
  "check_in",
  "check_in_undo",
  // a loss at the customer
  "mark_lost",
  "mark_lost_undo",
  "mark_damaged",
  "mark_damaged_undo",
  // a loss found after the return (api-cloudrun#1118)
  "mark_lost_returned",
  "mark_lost_returned_undo",
  "flag_damaged_returned",
  "flag_damaged_returned_undo",
  // cleaning / maintenance as booking buckets (P2b, owner 2026-09-30) — the
  // `mark_damaged` / `flag_damaged_returned` rows, once per reason
  "mark_cleaning",
  "mark_cleaning_undo",
  "mark_maintenance",
  "mark_maintenance_undo",
  "flag_cleaning_returned",
  "flag_cleaning_returned_undo",
  "flag_maintenance_returned",
  "flag_maintenance_returned_undo",
  // a record reclassified among the three flag reasons: a bucket move (gap G3)
  "reclassify_damaged_to_cleaning",
  "reclassify_damaged_to_maintenance",
  "reclassify_cleaning_to_damaged",
  "reclassify_cleaning_to_maintenance",
  "reclassify_maintenance_to_damaged",
  "reclassify_maintenance_to_cleaning",
] as const;

/** One custody rule id. */
export type CustodyRuleId = typeof CUSTODY_RULE_IDS[number];
/** Zod schema for {@link CustodyRuleId}. */
export const CustodyRuleIdEnum: z.ZodType<CustodyRuleId> = z.enum(CUSTODY_RULE_IDS);

// ── The row ──────────────────────────────────────────────────────────

/**
 * What one booking type does under a rule. `movement: null` is LEGAL WITH NO
 * MOVEMENT (a sale's `out → lost`); a type that may not take the rule at all has
 * no arm (`null` on the row).
 */
export interface CustodyArm {
  movement: MovementTypeType | null;
}

/**
 * One side of a flag row's service axis.
 *
 * - `none` — in service on that side;
 * - `damaged` / `cleaning` / `maintenance` — that flag.
 */
export type CustodyServiceSide = "none" | "damaged" | "cleaning" | "maintenance";

/** A flag row's service axis. */
export interface CustodyServiceShape {
  from: CustodyServiceSide;
  to: CustodyServiceSide;
}

/**
 * One legal custody step. Every row moves units between two breakdown keys
 * (`from !== to`, asserted by `tests/custody.test.ts`), so its movement carries
 * `{from, to}` as its custody pair and sets `uid_booking`.
 */
export interface CustodyRule {
  id: CustodyRuleId;
  from: BookingBreakdownKeyType;
  to: BookingBreakdownKeyType;
  /** `null` ⇒ a rental may not take this step. */
  rental: CustodyArm | null;
  /** `null` ⇒ a sale may not take this step. */
  sale: CustodyArm | null;
  /** The flag movement's service axis; `null` on every non-flag row. */
  service: CustodyServiceShape | null;
  /** `undo` ⇒ says the forward step never happened. Undos apply first in a save. */
  direction: "forward" | "undo";
  /** Menu grouping: which stage of the ladder the step belongs to. */
  stage: "prep" | "checkout" | "return" | "service";
  /** The rule that walks this one back, or `null`. */
  inverse: CustodyRuleId | null;
  /** Whether the out-of-service record the step opens may be billed to the customer. */
  billable: boolean;
  /** One sentence for a reader, and for the generated rung table. */
  description: string;
  /** What enforces the row, in the propagation catalog's terms. */
  enforced_by: EnforcementRef[];
}

const RENTAL_ONLY = (movement: MovementTypeType): Pick<CustodyRule, "rental" | "sale"> => ({
  rental: { movement },
  sale: null,
});

const TABLE_TEST: EnforcementRef = {
  kind: "test",
  ref: "core/tests/custody.test.ts::every row agrees with MOVEMENT_CONTRACTS",
  clause: "the row's movement carries its custody pair in places of the right kind",
  gates: true,
};

/**
 * The table. Order is display order within a stage; nothing reads position as
 * meaning.
 *
 * ⚠️ **There is no row for `quoted`/`reserved`/`prepped → lost/damaged`, and
 * that is gap G1 closing rather than a hole.** A unit that never left the
 * building is not lost at a customer; the fulfillment offers `unprep` plus a
 * shelf out-of-service record instead (owner ruling, 2026-09-29).
 *
 * ⚠️ **Multi-hop moves are SEQUENCES of rows** — `reserved → out` is
 * `[prep, check_out]` — so the table never needs a skip-ahead row.
 */
export const CUSTODY_RULES: readonly CustodyRule[] = [
  // ── the ladder ──
  {
    id: "prep",
    from: "reserved",
    to: "prepped",
    rental: { movement: "prep" },
    sale: { movement: "prep" },
    service: null,
    direction: "forward",
    stage: "prep",
    inverse: "unprep",
    billable: false,
    description: "Pick reserved units onto the prep shelf. Nothing moves physically.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "unprep",
    from: "prepped",
    to: "reserved",
    rental: { movement: "unprep" },
    // Never crosses the ownership boundary, so a sale has no basis question here.
    sale: { movement: "unprep" },
    service: null,
    direction: "undo",
    stage: "prep",
    inverse: "prep",
    billable: false,
    description: "Put prepped units back as merely reserved.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "check_out",
    from: "prepped",
    to: "out",
    rental: { movement: "check_out" },
    sale: { movement: "sale" },
    service: null,
    direction: "forward",
    stage: "checkout",
    inverse: "check_out_undo",
    billable: false,
    description: "Send prepped units to the customer. A sale's units leave CFS ownership here.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "check_out_undo",
    from: "out",
    to: "prepped",
    rental: { movement: "check_out_undo" },
    // A typed reversal of the sale: ownership comes back with its exact basis.
    sale: { movement: "sale_undo" },
    service: null,
    direction: "undo",
    stage: "checkout",
    inverse: "check_out",
    billable: false,
    description: "A check-out that never happened: the units go back to the shelf they left.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "check_in",
    from: "out",
    to: "returned",
    rental: { movement: "check_in" },
    sale: { movement: "sale_return" },
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "check_in_undo",
    billable: false,
    description: "Units come back from the customer onto the store's arrival location.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "check_in_undo",
    from: "returned",
    to: "out",
    rental: { movement: "check_in_undo" },
    // Relieves exactly what the return restored, refunded or not.
    sale: { movement: "sale_return_undo" },
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "check_in",
    billable: false,
    description: "A return that never happened: the units are back at the customer.",
    enforced_by: [TABLE_TEST],
  },
  // ── a loss at the customer ──
  {
    id: "mark_lost",
    from: "out",
    to: "lost",
    rental: { movement: "mark_lost" },
    // Ownership left at the sale: custody only, no place and no cost (gap G6).
    sale: { movement: "sale_lost" },
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "mark_lost_undo",
    billable: true,
    description: "Units the customer had are lost. They move to this event's out-of-service record.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_lost_undo",
    from: "lost",
    to: "out",
    rental: { movement: "mark_lost_undo" },
    sale: { movement: "sale_lost_undo" },
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "mark_lost",
    billable: false,
    description:
      "The loss never happened. NOT a unit that was lost and turned up: that is return_to_service on the record, and the booking keeps lost.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_damaged",
    from: "out",
    to: "damaged",
    rental: { movement: "mark_damaged" },
    sale: { movement: "sale_damaged" },
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "mark_damaged_undo",
    billable: true,
    description: "Units come back broken: a return onto the arrival location, flagged damaged by its custody.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_damaged_undo",
    from: "damaged",
    to: "out",
    rental: { movement: "mark_damaged_undo" },
    sale: { movement: "sale_damaged_undo" },
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "mark_damaged",
    billable: false,
    description: "The damage never happened: the units are back at the customer.",
    enforced_by: [TABLE_TEST],
  },
  // ── a loss found after the return ──
  {
    id: "mark_lost_returned",
    from: "returned",
    to: "lost",
    ...RENTAL_ONLY("mark_lost"),
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "mark_lost_returned_undo",
    billable: true,
    description: "A returned unit cannot be found: it leaves the shelf the return put it on.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_lost_returned_undo",
    from: "lost",
    to: "returned",
    ...RENTAL_ONLY("mark_lost_undo"),
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "mark_lost_returned",
    billable: false,
    description: "The shelf loss never happened: the unit goes back on the shelf it left.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_damaged_returned",
    from: "returned",
    to: "damaged",
    ...RENTAL_ONLY("flag"),
    service: { from: "none", to: "damaged" },
    direction: "forward",
    stage: "return",
    inverse: "flag_damaged_returned_undo",
    billable: true,
    description: "A returned unit is found broken. Flagged where it stands; it never leaves the shelf.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_damaged_returned_undo",
    from: "damaged",
    to: "returned",
    ...RENTAL_ONLY("flag"),
    service: { from: "damaged", to: "none" },
    direction: "undo",
    stage: "return",
    inverse: "flag_damaged_returned",
    billable: false,
    description: "The shelf damage never happened: a clearing flag, and the unit stays where it is.",
    enforced_by: [TABLE_TEST],
  },
  // ── cleaning and maintenance: the `damaged` rows, once per reason (P2b) ──
  {
    id: "mark_cleaning",
    from: "out",
    to: "cleaning",
    ...RENTAL_ONLY("mark_cleaning"),
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "mark_cleaning_undo",
    billable: false,
    description: "Units come back needing cleaning: a return onto the arrival location, flagged cleaning by its custody.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_cleaning_undo",
    from: "cleaning",
    to: "out",
    ...RENTAL_ONLY("mark_cleaning_undo"),
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "mark_cleaning",
    billable: false,
    description: "The cleaning never happened: the units are back at the customer.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_cleaning_returned",
    from: "returned",
    to: "cleaning",
    ...RENTAL_ONLY("flag"),
    service: { from: "none", to: "cleaning" },
    direction: "forward",
    stage: "return",
    inverse: "flag_cleaning_returned_undo",
    billable: false,
    description: "A returned unit is found needing cleaning. Flagged where it stands; it never leaves the shelf.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_cleaning_returned_undo",
    from: "cleaning",
    to: "returned",
    ...RENTAL_ONLY("flag"),
    service: { from: "cleaning", to: "none" },
    direction: "undo",
    stage: "return",
    inverse: "flag_cleaning_returned",
    billable: false,
    description: "The shelf cleaning flag never happened: a clearing flag, and the unit stays where it is.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_maintenance",
    from: "out",
    to: "maintenance",
    ...RENTAL_ONLY("mark_maintenance"),
    service: null,
    direction: "forward",
    stage: "return",
    inverse: "mark_maintenance_undo",
    billable: false,
    description: "Units come back needing maintenance: a return onto the arrival location, flagged maintenance by its custody.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "mark_maintenance_undo",
    from: "maintenance",
    to: "out",
    ...RENTAL_ONLY("mark_maintenance_undo"),
    service: null,
    direction: "undo",
    stage: "return",
    inverse: "mark_maintenance",
    billable: false,
    description: "The maintenance never happened: the units are back at the customer.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_maintenance_returned",
    from: "returned",
    to: "maintenance",
    ...RENTAL_ONLY("flag"),
    service: { from: "none", to: "maintenance" },
    direction: "forward",
    stage: "return",
    inverse: "flag_maintenance_returned_undo",
    billable: false,
    description: "A returned unit is found needing maintenance. Flagged where it stands; it never leaves the shelf.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "flag_maintenance_returned_undo",
    from: "maintenance",
    to: "returned",
    ...RENTAL_ONLY("flag"),
    service: { from: "maintenance", to: "none" },
    direction: "undo",
    stage: "return",
    inverse: "flag_maintenance_returned",
    billable: false,
    description: "The shelf maintenance flag never happened: a clearing flag, and the unit stays where it is.",
    enforced_by: [TABLE_TEST],
  },
  // ── a record reclassified among the three flag reasons (gap G3) ──
  // A CORRECTION, so the booking moves with the record: the buckets are the
  // condition a unit came back in, and the operator is saying it was wrong.
  {
    id: "reclassify_damaged_to_cleaning",
    from: "damaged",
    to: "cleaning",
    ...RENTAL_ONLY("flag"),
    service: { from: "damaged", to: "cleaning" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_cleaning_to_damaged",
    billable: false,
    description: "A damaged record is reclassified to cleaning: the booking moves damaged → cleaning in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_damaged_to_maintenance",
    from: "damaged",
    to: "maintenance",
    ...RENTAL_ONLY("flag"),
    service: { from: "damaged", to: "maintenance" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_maintenance_to_damaged",
    billable: false,
    description: "A damaged record is reclassified to maintenance: the booking moves damaged → maintenance in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_cleaning_to_damaged",
    from: "cleaning",
    to: "damaged",
    ...RENTAL_ONLY("flag"),
    service: { from: "cleaning", to: "damaged" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_damaged_to_cleaning",
    // As the damaged rows: a record reclassified TO damaged may be billed.
    billable: true,
    description: "A cleaning record is reclassified to damaged: the booking moves cleaning → damaged in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_cleaning_to_maintenance",
    from: "cleaning",
    to: "maintenance",
    ...RENTAL_ONLY("flag"),
    service: { from: "cleaning", to: "maintenance" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_maintenance_to_cleaning",
    billable: false,
    description: "A cleaning record is reclassified to maintenance: the booking moves cleaning → maintenance in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_maintenance_to_damaged",
    from: "maintenance",
    to: "damaged",
    ...RENTAL_ONLY("flag"),
    service: { from: "maintenance", to: "damaged" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_damaged_to_maintenance",
    // As the damaged rows: a record reclassified TO damaged may be billed.
    billable: true,
    description: "A maintenance record is reclassified to damaged: the booking moves maintenance → damaged in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_maintenance_to_cleaning",
    from: "maintenance",
    to: "cleaning",
    ...RENTAL_ONLY("flag"),
    service: { from: "maintenance", to: "cleaning" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_cleaning_to_maintenance",
    billable: false,
    description: "A maintenance record is reclassified to cleaning: the booking moves maintenance → cleaning in the same write.",
    enforced_by: [TABLE_TEST],
  },
];

/** The rule with `id`. Total over {@link CustodyRuleId}; the table test proves it. */
export function custodyRule(id: CustodyRuleId): CustodyRule {
  const rule = CUSTODY_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`custody rule "${id}" has no row`);
  return rule;
}

/**
 * The movement-id slot an action occupies in one save, or `null` when it writes
 * no movement for that booking type.
 *
 * A movement's id is `{session}|{type}|{booking}`, so two actions of one type
 * against one booking in one save collide. The exception is a `flag` into or
 * out of `cleaning`/`maintenance`, whose id is its reason's own (the api's
 * `transitionMovementId`), so `flag_cleaning_returned` and
 * `flag_damaged_returned` in one save are two slots.
 */
export function custodyMovementSlot(rule: CustodyRule, bookingType: "rental" | "sale"): string | null {
  const arm = bookingType === "rental" ? rule.rental : rule.sale;
  const movement = arm?.movement ?? null;
  if (movement === null) return null;
  if (movement !== "flag") return movement;
  const own = FLAG_SLOT_REASONS.find((r) => rule.from === r || rule.to === r);
  return own === undefined ? movement : `${movement}:${own}`;
}

/**
 * The reasons whose `flag` takes its own movement id — see
 * {@link custodyMovementSlot}. Exported so the api's movement-id minting reads
 * the same list (it restated it as `FLAG_ID_REASONS`).
 */
export const FLAG_SLOT_REASONS = ["cleaning", "maintenance"] as const;

/**
 * The flag reasons in the order an exchange's checkout takes units back off
 * `out` (the api's swap rider). `damaged` first: it is the billable state, so
 * under-recording it is the costly miss. Every flag reason, once — pinned
 * against `OOS_FLAG_REASONS` at compile time.
 */
export const TAKE_BACK_ORDER = ["damaged", "cleaning", "maintenance"] as const;
type _TakeBackCoversFlags = [OOSFlagReasonType] extends [typeof TAKE_BACK_ORDER[number]]
  ? ([typeof TAKE_BACK_ORDER[number]] extends [OOSFlagReasonType] ? true : never)
  : never;
const _takeBackParity: _TakeBackCoversFlags = true;
void _takeBackParity;

/**
 * The out-of-service reason a MARK movement puts units into — `mark_lost` →
 * `lost`, `mark_cleaning` → `cleaning`, … — or `null` for any other type.
 *
 * Read off {@link CUSTODY_RULES}: the forward row off `out` whose rental arm
 * writes `type`. A script that hand-mapped only `mark_damaged`/`mark_lost`
 * attributed every cleaning and maintenance mark to nothing (api-cloudrun
 * `_ledgerReplayRebuild.ts`, gap G15). A `flag` carries its reason on the
 * service axis, not here.
 */
export function markReasonOf(type: MovementTypeType): OutOfServiceKeyType | null {
  const rule = CUSTODY_RULES.find((r) =>
    r.direction === "forward" && r.from === "out" && r.rental?.movement === type && OUT_OF_SERVICE_FROM.has(r.to)
  );
  return rule ? rule.to as OutOfServiceKeyType : null;
}

/**
 * Whether a movement of `type` carrying `custody` is a step that happens
 * entirely on the CUSTOMER's side: some rule whose `{from, to}` it carries has
 * an arm writing `type` for a booking type that owns NEITHER end (`ownsKey`).
 * Today that is a sale's `sale_lost` / `sale_damaged` and their undos.
 *
 * Keyed on the property, not on type names, so a new custody-only step past
 * the ownership boundary is covered without an edit. The roster fold reads it:
 * such a step names units that are no longer on any roster, and changes none.
 */
export function isCustomerCustodyStep(
  type: MovementTypeType,
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null } | null,
): boolean {
  if (custody === null || custody.from === null || custody.to === null) return false;
  const { from, to } = custody;
  return CUSTODY_RULES.some((rule) =>
    rule.from === from && rule.to === to &&
    (["rental", "sale"] as const).some((bt) =>
      (bt === "rental" ? rule.rental : rule.sale)?.movement === type && !ownsKey(bt, from) && !ownsKey(bt, to)
    )
  );
}

// ── The wire ─────────────────────────────────────────────────────────

/**
 * One step an operator takes on a booking.
 *
 * - `uid_out_of_service` — names the record a reclassification or an undo acts
 *   on. Optional: an undo without one consumes the booking's open loss records
 *   newest first, as the delta form always has.
 *
 * No action names a reason: since P2b every reason is its own breakdown key and
 * its own rule (`mark_cleaning`, `flag_maintenance_returned`, …).
 */
export interface BookingActionType {
  rule: CustodyRuleId;
  quantity: number;
  uid_out_of_service?: string;
  /**
   * Which units this step moves, on a serialized product: a canonical
   * `UnitSet` of exactly `quantity` numbers. Absent on a bulk product.
   *
   * Each rung names the units it moves and a rewind names the units it
   * rewinds, so a booking's unit sets are a fold of its actions
   * (`applyCustodyActions`) with nothing inferred. Once a product's roster is
   * seeded, the api refuses a serialized row's action WITHOUT units, except an
   * `unprep` of an untracked prepped count, which drains a count no unit was
   * ever named for (`api-cloudrun/.claude/plans/serial-tracking.md` D1).
   *
   * ⚠️ **Release order:** this schema is a `z.object`, so an api older than
   * this field STRIPS `units` silently. The api release that reads it must be
   * live in prod before the manager sends it.
   */
  units?: number[];
}

/** Zod schema for {@link BookingActionType}. */
export const BookingAction: z.ZodType<BookingActionType> = z.object({
  rule: CustodyRuleIdEnum,
  quantity: z.int().min(1),
  uid_out_of_service: OutOfServiceId.optional(),
  units: UnitSet.optional(),
}).refine((a) => a.units === undefined || a.units.length === a.quantity, {
  message: "an action that names units names exactly `quantity` of them",
  path: ["units"],
});

/**
 * Where two actions in one list would write the same movement id. Shared by the
 * wire refine and by `applyCustodyActions`, so the two cannot disagree.
 *
 * The slot is read off the RENTAL arm: a sale's arms are a subset whose
 * movements are distinct per rule, so the rental reading is the stricter one.
 */
export function duplicateCustodySlots(actions: readonly Pick<BookingActionType, "rule">[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const a of actions) {
    const rule = CUSTODY_RULES.find((r) => r.id === a.rule);
    if (!rule) continue;
    const slot = custodyMovementSlot(rule, "rental") ?? custodyMovementSlot(rule, "sale");
    if (slot === null) continue;
    if (seen.has(slot)) dup.push(slot);
    seen.add(slot);
  }
  return dup;
}

/**
 * An ordered list of actions on ONE booking. Undos come first, as the delta
 * form has always applied them; two actions that would write one movement id
 * are refused (make them two saves).
 */
export const BookingActions: z.ZodType<BookingActionType[]> = z.array(BookingAction).min(1).superRefine(
  (actions, ctx) => {
    for (const slot of duplicateCustodySlots(actions)) {
      ctx.addIssue({
        code: "custom",
        message: `two actions would write the same "${slot.split(":")[0]}" movement; make them two separate saves`,
      });
    }
    let seenForward = false;
    actions.forEach((a, i) => {
      const rule = CUSTODY_RULES.find((r) => r.id === a.rule);
      if (!rule) return;
      if (rule.direction === "forward") seenForward = true;
      else if (seenForward && isLossUndo(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: `"${a.rule}" undoes a loss mark and must come before every forward action`,
        });
      }
    });
  },
);

/**
 * The out-of-service-mark undos — every undo OUT OF `lost`, `damaged`,
 * `cleaning` or `maintenance` — which the lever applies before anything else in
 * a save: an undo returns units to wherever THAT mark took them from, a fact
 * about the record rather than the breakdown, so the ladder steps must read the
 * breakdown the undos leave.
 *
 * Read off the table rather than listed, so the P2b rows joined without an edit
 * here; the name predates them.
 */
export function isLossUndo(id: CustodyRuleId): boolean {
  const rule = CUSTODY_RULES.find((r) => r.id === id);
  return rule !== undefined && rule.direction === "undo" && OUT_OF_SERVICE_FROM.has(rule.from);
}

const OUT_OF_SERVICE_FROM: ReadonlySet<BookingBreakdownKeyType> = new Set(OUT_OF_SERVICE_KEYS);

/**
 * One booking's actions in a bulk write — the action-shaped twin of
 * `BookingUpdate`. `status` is derived by the server, never sent.
 */
export interface BookingActionsInputType {
  uid: string;
  version: number;
  actions: BookingActionType[];
}

/** Zod schema for {@link BookingActionsInputType}. */
export const BookingActionsInput: z.ZodType<BookingActionsInputType> = z.object({
  uid: BookingId,
  version: z.int().min(0),
  actions: BookingActions,
});
