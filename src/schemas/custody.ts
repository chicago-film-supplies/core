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
 * ## Sales
 *
 * A sale's rows are encoded as a sale behaves today, not as a sale might
 * ideally behave: `out → lost` and `out → damaged` are legal and emit NO
 * movement (the units left CFS ownership at the point of sale, so there is no
 * inventory event), and every sale rewind is refused (api-cloudrun#1054).
 *
 * @module
 */
import { z } from "zod";
import { BookingId, OutOfServiceId } from "./_uid.ts";
import type { BookingBreakdownKeyType } from "./booking.ts";
import type { MovementTypeType } from "./transaction.ts";
import type { EnforcementRef } from "./propagation/types.ts";

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
  // cleaning / maintenance on units already returned (gap G2)
  "flag_returned",
  // a booking-sourced record reclassified between damaged and a flag (gap G3)
  "reclassify_damaged_to_flag",
  "reclassify_flag_to_damaged",
] as const;

/** One custody rule id. */
export type CustodyRuleId = typeof CUSTODY_RULE_IDS[number];
/** Zod schema for {@link CustodyRuleId}. */
export const CustodyRuleIdEnum: z.ZodType<CustodyRuleId> = z.enum(CUSTODY_RULE_IDS);

/**
 * The flag reasons a custody ACTION may name: the in-place reasons a booking
 * keeps reading as `returned`. `damaged` is not one of them, because a damaged
 * unit is its own breakdown key (owner ruling R2, 2026-09-29).
 */
export const CUSTODY_FLAG_REASONS = ["cleaning", "maintenance"] as const;
/** A flag reason a custody action may name. */
export type CustodyFlagReasonType = typeof CUSTODY_FLAG_REASONS[number];
/** Zod schema for {@link CustodyFlagReasonType}. */
export const CustodyFlagReasonEnum: z.ZodType<CustodyFlagReasonType> = z.enum(CUSTODY_FLAG_REASONS);

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
 * - `damaged` — the `damaged` flag;
 * - `reason` — the cleaning/maintenance reason the ACTION names.
 */
export type CustodyServiceSide = "none" | "damaged" | "reason";

/** A flag row's service axis, in terms the action fills in. */
export interface CustodyServiceShape {
  from: CustodyServiceSide;
  to: CustodyServiceSide;
}

/**
 * One legal custody step.
 *
 * `from === to` is a step that changes no breakdown key (only `flag_returned`):
 * its movement carries no custody and names its booking in `sources[]`, not in
 * `uid_booking`. Every other row's movement carries `{from, to}` as its custody
 * pair and sets `uid_booking`.
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
    ...RENTAL_ONLY("check_out_undo"),
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
    ...RENTAL_ONLY("check_in_undo"),
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
    // Ownership left at the sale, so there is no inventory event to record.
    sale: { movement: null },
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
    ...RENTAL_ONLY("mark_lost_undo"),
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
    sale: { movement: null },
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
    ...RENTAL_ONLY("mark_damaged_undo"),
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
  // ── cleaning / maintenance (gap G2) ──
  {
    id: "flag_returned",
    from: "returned",
    to: "returned",
    ...RENTAL_ONLY("flag"),
    service: { from: "none", to: "reason" },
    direction: "forward",
    stage: "service",
    inverse: null,
    billable: false,
    description:
      "Flag returned units for cleaning or maintenance where they stand, at check-in or after it. The booking still reads returned, and it is never billed.",
    enforced_by: [TABLE_TEST],
  },
  // ── a booking-sourced record reclassified (gap G3) ──
  {
    id: "reclassify_damaged_to_flag",
    from: "damaged",
    to: "returned",
    ...RENTAL_ONLY("flag"),
    service: { from: "damaged", to: "reason" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_flag_to_damaged",
    billable: false,
    description:
      "A damaged record is reclassified to cleaning or maintenance: the booking flips damaged → returned in the same write.",
    enforced_by: [TABLE_TEST],
  },
  {
    id: "reclassify_flag_to_damaged",
    from: "returned",
    to: "damaged",
    ...RENTAL_ONLY("flag"),
    service: { from: "reason", to: "damaged" },
    direction: "forward",
    stage: "service",
    inverse: "reclassify_damaged_to_flag",
    billable: true,
    description:
      "A cleaning or maintenance record is reclassified to damaged: the booking flips returned → damaged in the same write.",
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
 * against one booking in one save collide. The exception is a flag with no
 * custody (`flag_returned`), whose id carries its reason, so cleaning and
 * maintenance in one save are two slots.
 */
export function custodyMovementSlot(
  rule: CustodyRule,
  bookingType: "rental" | "sale",
  reason?: string,
): string | null {
  const arm = bookingType === "rental" ? rule.rental : rule.sale;
  const movement = arm?.movement ?? null;
  if (movement === null) return null;
  return rule.from === rule.to ? `${movement}:${reason ?? ""}` : movement;
}

// ── The wire ─────────────────────────────────────────────────────────

/**
 * One step an operator takes on a booking.
 *
 * - `reason` — required by the rows whose service axis names `reason`
 *   (`flag_returned`, the two reclassifications); refused on every other row.
 * - `uid_out_of_service` — names the record a reclassification or an undo acts
 *   on. Optional: an undo without one consumes the booking's open loss records
 *   newest first, as the delta form always has.
 */
export interface BookingActionType {
  rule: CustodyRuleId;
  quantity: number;
  reason?: CustodyFlagReasonType;
  uid_out_of_service?: string;
}

/** Zod schema for {@link BookingActionType}. */
export const BookingAction: z.ZodType<BookingActionType> = z.object({
  rule: CustodyRuleIdEnum,
  quantity: z.int().min(1),
  reason: CustodyFlagReasonEnum.optional(),
  uid_out_of_service: OutOfServiceId.optional(),
}).superRefine((a, ctx) => {
  const rule = CUSTODY_RULES.find((r) => r.id === a.rule);
  if (!rule) return; // the enum already refused it
  const needsReason = rule.service !== null &&
    (rule.service.from === "reason" || rule.service.to === "reason");
  if (needsReason && a.reason === undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: `"${a.rule}" needs a reason: cleaning or maintenance` });
  }
  if (!needsReason && a.reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: `"${a.rule}" takes no reason` });
  }
});

/**
 * Where two actions in one list would write the same movement id. Shared by the
 * wire refine and by `applyCustodyActions`, so the two cannot disagree.
 *
 * The slot is read off the RENTAL arm: a sale's arms are a subset whose
 * movements are distinct per rule, so the rental reading is the stricter one.
 */
export function duplicateCustodySlots(actions: readonly Pick<BookingActionType, "rule" | "reason">[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const a of actions) {
    const rule = CUSTODY_RULES.find((r) => r.id === a.rule);
    if (!rule) continue;
    const slot = custodyMovementSlot(rule, "rental", a.reason) ?? custodyMovementSlot(rule, "sale", a.reason);
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
 * The loss-mark undos, which the lever applies before anything else in a save:
 * an undo returns units to wherever THAT mark took them from, a fact about the
 * record rather than the breakdown, so the ladder steps must read the breakdown
 * the undos leave.
 */
export function isLossUndo(id: CustodyRuleId): boolean {
  return id === "mark_lost_undo" || id === "mark_damaged_undo" || id === "mark_lost_returned_undo" ||
    id === "flag_damaged_returned_undo";
}

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
