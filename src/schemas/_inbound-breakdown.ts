/**
 * The INBOUND booking custody breakdown: its keys, their labels, its schema and
 * the per-type predicates — the one declaration of what a purchase's units can
 * be doing (`api-cloudrun/.claude/plans/one-document-model.md` § *7a core spec*,
 * C1).
 *
 * INTERNAL — not an entrypoint in `deno.json`'s `exports` map. `booking.ts`
 * re-exports every public name here, so `@cfs/core/schemas` is the address, as
 * it is for `_breakdown.ts`, whose shape this file copies key for key.
 *
 * ## Why a second breakdown rather than the outbound one with labels
 *
 * Each inbound stage TWINS an outbound one by PLACE ({@link INBOUND_STAGE_TWINS}),
 * but the ORDER differs:
 *
 * - outbound: `reserved → prepped → out → returned`;
 * - inbound: `ordered → transit_inbound → received → stocked → transit_outbound → sent_back`.
 *
 * The outbound arithmetic reads order (`liveCustody` is `prepped + out` for a
 * rental), so a subrent stored on the outbound keys would read its live custody
 * as `prepped + returned`. The keys are stored per direction (owner, 2026-11-07),
 * and every ladder-reading function takes the ladder as data, never as a branch.
 *
 * ## What is deliberately absent
 *
 * - **No `cleaning` or `maintenance`.** A dirty rented unit is a fact on the
 *   OUTBOUND booking that took it out (one-document-model status block 54).
 * - **No movement writes `quoted` or either transit key yet** (0b ruling 2,
 *   ruling 56). The keys are present at zero so adding a writer later is not a
 *   change to every stored booking and every partition guard.
 *
 * @module
 */
import { z } from "zod";
import { type BookingBreakdownKeyType, unitSetsSchema } from "./_breakdown.ts";

/**
 * Per-stage quantity breakdown for an inbound booking (a purchase line's units).
 *
 * 🔴 **Never add its keys up by name** — the same rule, and the same reason, as
 * `BookingBreakdown`'s: a sum spelled key by key compiles straight through the
 * arrival of a new key and silently stops counting it.
 */
export interface InboundBreakdown {
  /** A unit received damaged (a Buy), or a settled damaged Subrent unit. */
  damaged: number;
  /** A rented unit lost and settled with the supplier. */
  lost: number;
  /** Promised by the supplier; nothing has moved. */
  ordered: number;
  /** Nothing promised. No writer yet. */
  quoted: number;
  /** In CFS staging, being processed. */
  received: number;
  /** With the supplier again. */
  sent_back: number;
  /** On a CFS shelf. */
  stocked: number;
  /** On its way to CFS. No writer yet. */
  transit_inbound: number;
  /** On its way back to the supplier. No writer yet. */
  transit_outbound: number;
}

/**
 * Display label per inbound bucket — the one declaration, read by the schema's
 * `.meta()` annotations below and by any page that heads a column with one.
 *
 * ⚠️ **Every label is unique, and must stay so.** A table renders one heading
 * per key (display rule T9), so two keys sharing "In transit" would render two
 * indistinguishable columns. `tests/inbound-breakdown.test.ts` pins it.
 */
export const INBOUND_BREAKDOWN_LABELS: Record<keyof InboundBreakdown, string> = {
  quoted: "Draft",
  ordered: "Ordered",
  transit_inbound: "Arriving",
  received: "Received",
  stocked: "Stocked",
  transit_outbound: "Leaving",
  sent_back: "Sent back",
  lost: "Lost",
  damaged: "Damaged",
};

/**
 * Zod schema for {@link InboundBreakdown}. Keys alphabetical, because a schema's
 * key order is its column order (`core/CLAUDE.md`).
 */
export const InboundBreakdownSchema: z.ZodType<InboundBreakdown> = z.strictObject({
  damaged: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.damaged }),
  lost: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.lost }),
  ordered: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.ordered }),
  quoted: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.quoted }),
  received: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.received }),
  sent_back: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.sent_back }),
  stocked: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.stocked }),
  transit_inbound: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.transit_inbound }),
  transit_outbound: z.int().meta({ column: true, label: INBOUND_BREAKDOWN_LABELS.transit_outbound }),
});

/** Every inbound key, in LADDER order (not the schema's alphabetical order). */
export const INBOUND_BREAKDOWN_KEYS = [
  "quoted", "ordered", "transit_inbound", "received", "stocked", "transit_outbound", "sent_back", "lost", "damaged",
] as const;

/** The inbound PLAN keys: promised, nothing moved. Every other key is history. */
export const INBOUND_PLAN_KEYS = ["quoted", "ordered"] as const;

/**
 * Every inbound key but the plan: units something physically happened to. The
 * twin of `CUSTODY_HISTORY_KEYS`, and the set the journal replay folds an
 * inbound booking over (`net[k] === breakdown[k]`).
 */
export const INBOUND_HISTORY_KEYS = [
  "transit_inbound", "received", "stocked", "transit_outbound", "sent_back", "lost", "damaged",
] as const;

/**
 * The keys a unit sits in once it has been RECEIVED: every history key past
 * `transit_inbound`. Their sum is what the retired purchase line bucket
 * `quantity_received` counted (one-document-model C8, the C12 identity), read
 * off a booking or off the net custody of the movements naming one row.
 */
export const INBOUND_RECEIVED_KEYS = [
  "received", "stocked", "transit_outbound", "sent_back", "lost", "damaged",
] as const;

/**
 * The keys a unit sits in once it is NO LONGER OWED to the supplier: handed
 * back, or settled lost or damaged. Their sum is what the retired subrent
 * bucket `quantity_returned` counted (the C12 identity), a settled unit
 * included (api-cloudrun#1360, D3). ⚠️ On a Buy `damaged` is a unit received
 * broken, which CFS owns; nothing reads this sum on a Buy.
 */
export const INBOUND_RETURNED_KEYS = ["sent_back", "lost", "damaged"] as const;

/** One key of the inbound breakdown. */
export type InboundBreakdownKeyType = typeof INBOUND_BREAKDOWN_KEYS[number];

/** Zod enum over the inbound keys. */
export const InboundBreakdownKeyEnum: z.ZodType<InboundBreakdownKeyType> = z.enum(INBOUND_BREAKDOWN_KEYS);

/**
 * The buckets that hold NAMED units on a serialized product's inbound booking:
 * the history keys, alphabetized, as `BOOKING_UNIT_BUCKETS` is.
 */
export const INBOUND_UNIT_BUCKETS = [
  "damaged", "lost", "received", "sent_back", "stocked", "transit_inbound", "transit_outbound",
] as const;

/** One inbound bucket that holds named units. */
export type InboundUnitBucketType = typeof INBOUND_UNIT_BUCKETS[number];

/**
 * Which units sit in each bucket of an inbound booking — the twin of
 * `BookingUnitSetsType`, with the same two rules: each set is a canonical
 * `UnitSet`, the sets are pairwise disjoint, and `units[k].length ≤
 * breakdown[k]` (refined on the booking, which holds both).
 */
export type InboundUnitSetsType = Record<InboundUnitBucketType, number[]>;

/** Zod schema for {@link InboundUnitSetsType} — the outbound builder, over the inbound buckets. */
export const InboundUnitSetsSchema: z.ZodType<InboundUnitSetsType> = unitSetsSchema(INBOUND_UNIT_BUCKETS);

/** Empty sets in every inbound unit bucket. */
export function emptyInboundUnitSets(): InboundUnitSetsType {
  return { damaged: [], lost: [], received: [], sent_back: [], stocked: [], transit_inbound: [], transit_outbound: [] };
}

// Compile-time guards, both directions, on the shape and every partition.
type _Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _inboundParity: [
  _Both<InboundBreakdownKeyType, keyof InboundBreakdown>,
  _Both<typeof INBOUND_PLAN_KEYS[number] | typeof INBOUND_HISTORY_KEYS[number], InboundBreakdownKeyType>,
  _Both<InboundUnitBucketType, typeof INBOUND_HISTORY_KEYS[number]>,
  // Received is the history less what is still on its way in; returned is a subset of it.
  _Both<typeof INBOUND_RECEIVED_KEYS[number] | "transit_inbound", typeof INBOUND_HISTORY_KEYS[number]>,
  _Both<Extract<typeof INBOUND_RECEIVED_KEYS[number], typeof INBOUND_RETURNED_KEYS[number]>, typeof INBOUND_RETURNED_KEYS[number]>,
] = [true, true, true, true, true];
void _inboundParity;

/** A breakdown with every inbound key at zero. */
export function emptyInboundBreakdown(): InboundBreakdown {
  return {
    damaged: 0, lost: 0, ordered: 0, quoted: 0, received: 0,
    sent_back: 0, stocked: 0, transit_inbound: 0, transit_outbound: 0,
  };
}

// ── The inbound booking's type ──────────────────────────────────────

/**
 * An inbound booking's `type`: a Buy is a `sale` line, a Subrent a `rental`
 * line. Narrower than `ComponentTypeEnum` on purpose, so every predicate below
 * is total over it — a `service` (Charge) line moves no units and books nothing.
 */
export const INBOUND_BOOKING_TYPES = ["sale", "rental"] as const;
/** One inbound booking type. */
export type InboundBookingTypeType = typeof INBOUND_BOOKING_TYPES[number];
/** Zod enum over {@link INBOUND_BOOKING_TYPES}. */
export const InboundBookingTypeEnum: z.ZodType<InboundBookingTypeType> = z.enum(INBOUND_BOOKING_TYPES);

// ── Per-type predicates ─────────────────────────────────────────────
//
// DERIVED through predicates, never tables keyed by type, as the outbound
// `ownsKey` / `OWNED_KEYS_BY_TYPE` are (`schemas/custody.ts`). Each is a set per
// type, so the tables below ARE the definitions and the functions read them.

const OWNED: Readonly<Record<InboundBookingTypeType, ReadonlySet<InboundBreakdownKeyType>>> = {
  // A Buy's units become CFS's at handoff — including one that arrives broken.
  sale: new Set(["received", "stocked", "damaged"]),
  // A Subrent's units are the supplier's at every stage.
  rental: new Set(),
};

const TERMINAL: Readonly<Record<InboundBookingTypeType, ReadonlySet<InboundBreakdownKeyType>>> = {
  sale: new Set(["stocked", "damaged"]),
  rental: new Set(["sent_back", "lost", "damaged"]),
};

const LIVE: Readonly<Record<InboundBookingTypeType, ReadonlySet<InboundBreakdownKeyType>>> = {
  sale: new Set(["transit_inbound", "received"]),
  rental: new Set(["transit_inbound", "received", "stocked", "transit_outbound"]),
};

/**
 * Whether CFS OWNS an inbound booking's units in `key` — the inbound twin of
 * `ownsKey`. A Buy owns from `received` on; a Subrent owns nothing, ever.
 *
 * ⭐ The movement-cost rule reads this: a receive must carry a cost exactly
 * when it moves units into an owned key, so a Buy receive costs and a Subrent
 * receive does not.
 */
export function inboundOwnsKey(type: InboundBookingTypeType, key: InboundBreakdownKeyType): boolean {
  return OWNED[type].has(key);
}

/**
 * Whether `key` is TERMINAL for an inbound booking of `type`: a booking whose
 * units all sit in terminal keys is closed. A Buy ends on a shelf (or damaged);
 * a Subrent ends back with the supplier, or settled lost or damaged.
 */
export function isInboundTerminal(type: InboundBookingTypeType, key: InboundBreakdownKeyType): boolean {
  return TERMINAL[type].has(key);
}

/**
 * Whether units in `key` are LIVE custody for an inbound booking of `type` —
 * physically moving or in CFS's hands and not yet at an end. The twin of
 * `liveCustody`'s key set: a purchase line holding any is refused a cancel
 * (`inboundCancelRefusal`, the contract beta).
 */
export function isInboundLive(type: InboundBookingTypeType, key: InboundBreakdownKeyType): boolean {
  return LIVE[type].has(key);
}

// ── Stage twins ─────────────────────────────────────────────────────

/**
 * Each inbound key's outbound twin BY PLACE — for display and as the shared
 * allocator's input, never for arithmetic (the ladders' orders differ; see the
 * module docblock).
 *
 * | inbound | outbound | the shared place |
 * |---|---|---|
 * | `received` | `prepped` | CFS staging |
 * | `stocked` | `returned` | a CFS shelf |
 * | `sent_back` | `out` | away from CFS |
 *
 * ⚠️ **The transit keys map to `null` until the outbound breakdown carries
 * them.** They are named relative to CFS, so they will be literally the same
 * two keys on both ladders, but the outbound breakdown gains them only in the
 * Phase 9 window (0b). A `null` here is "no outbound key yet", not "no twin".
 */
export const INBOUND_STAGE_TWINS: Readonly<Record<InboundBreakdownKeyType, BookingBreakdownKeyType | null>> = {
  quoted: "quoted",
  ordered: "reserved",
  transit_inbound: null,
  received: "prepped",
  stocked: "returned",
  transit_outbound: null,
  sent_back: "out",
  lost: "lost",
  damaged: "damaged",
};
