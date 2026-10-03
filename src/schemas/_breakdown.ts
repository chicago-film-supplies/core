/**
 * The booking custody breakdown: its keys, their labels and its schemas — the
 * ONE declaration of what a booking's units can be doing.
 *
 * INTERNAL — not an entrypoint in `deno.json`'s `exports` map. `booking.ts`
 * re-exports every public name here, so `@cfs/core/schemas` is still the
 * address. It is its own module for one reason: `order.ts` needs the key list
 * for its `bookings_breakdown` roll-up, and `booking.ts` already imports
 * `order.ts`, so the list living in `booking.ts` would make the two a cycle.
 *
 * ## `cleaning` and `maintenance` (api-cloudrun custody-actions P2b)
 *
 * Owner, 2026-09-30, reversing ruling R2: every out-of-service reason is a
 * booking bucket. A unit that came back dirty reads `cleaning`, not `returned`
 * with a flag beside it. The buckets are HISTORY — the condition a unit came
 * back in — exactly as `lost`/`damaged` already are: clearing, cleaning or
 * returning the unit to service on its record never moves the booking; only a
 * correction does (an undo, or a reclassification among the three flag
 * reasons).
 *
 * Both keys are REQUIRED, reached through the add-field order
 * (`cfs-release-order`): `beta.570` added them optional and read an absent key
 * as 0, the writers then stated them (api v0.311.0), a backfill zero-filled
 * every stored booking and order roll-up (2026-09-30, 0 misses in both envs by
 * `api-cloudrun/scripts/audit-breakdown-keys.ts`), and this `feat!` made them
 * required. Prod held 0 cleaning/maintenance records when the keys were added,
 * so nothing but the zero-fill was migrated.
 *
 * @module
 */
import { z } from "zod";
import { UnitSet } from "./unit.ts";

/**
 * Per-status quantity breakdown for a booking.
 *
 * ⚠️ It is no longer embedded anywhere in the stock projection. `stock/{P}`'s
 * entries are PRE-REDUCED and anonymous — `unavailableFromBooking` folds this
 * breakdown down to a single `quantity` — so the breakdown reaches availability
 * as a number and never as a structure.
 *
 * 🔴 **Never add its keys up by name.** A sum spelled `returned + lost +
 * damaged` compiled through the arrival of `cleaning` and `maintenance` and
 * silently stopped counting them; that pattern is what made the P2b inventory
 * long. Sum through `sumBreakdownKeys` (`utils/bookings.ts`), which
 * `tests/breakdown-sums.test.ts` enforces.
 */
export interface BookingBreakdown {
  damaged: number;
  lost: number;
  out: number;
  prepped: number;
  quoted: number;
  reserved: number;
  returned: number;
  /** Came back needing cleaning. */
  cleaning: number;
  /** Came back needing maintenance. */
  maintenance: number;
}

/**
 * Display label per breakdown bucket — the ONE declaration, read both by the
 * `.meta({ column: true, label })` annotations below (which drive every
 * collection-table heading) and by the warehouse picker's column headers.
 *
 * ⚠️ **It is declared as a table rather than inline on each `.meta()` because
 * the picker had its own copy.** The now-deleted
 * `manager/src/utils/fulfillmentStage.ts` carried a hand-written `BUCKET_LABEL`
 * restating all seven — which is exactly the drift the repo's *"columns are
 * declared, not generated"* rule exists to stop, and the two had diverged on
 * `out`: the copy said "Out" and this declaration said "Checked Out".
 *
 * ⭐ **The copy's word is now the canonical one — owner's call, 2026-09-09 — so
 * the drift is resolved the other way round from how it was first resolved.**
 * "Checked Out" was kept because it pairs with `FULFILLMENT_STAGE_LABELS`, where
 * every state here reads as the past participle of an action there (`prep` →
 * `Prepped`, `return` → `Returned`, `checkout` → `Checked Out`). `out` no longer
 * follows that pattern, and that is the cost of the change rather than an
 * oversight: it is the longest heading on the pick sheet, where the shorter
 * word buys real width and "Out" reads as a state on its own.
 *
 * ⚠️ **What does NOT change is that there is one declaration.** The lesson of
 * the deleted copy was never which word to use — it was that two places spelling
 * it is how they diverge. `tests/fulfillment-stage.test.ts` pins this string, so
 * a reappearing copy still goes red.
 *
 * ⚠️ Reflection is deliberately NOT the mechanism. `resolveFieldMeta` could
 * read these back off the schema, but `BookingBreakdownSchema` is annotated
 * `z.ZodType<BookingBreakdown>`, so reaching its shape needs a cast and the
 * result is typed `unknown`. A shared literal in the one file that owns the
 * declaration is the same guarantee with none of that.
 */
export const BOOKING_BREAKDOWN_LABELS: Record<keyof BookingBreakdown, string> = {
  quoted: "Quoted",
  reserved: "Reserved",
  prepped: "Prepped",
  out: "Out",
  returned: "Returned",
  lost: "Lost",
  damaged: "Damaged",
  cleaning: "Cleaning",
  maintenance: "Maintenance",
};

/**
 * Zod schema for BookingBreakdown.
 *
 * ⚠️ The keys stay in alphabetical order, NOT lifecycle order: a schema's key
 * order is its Firestore-surface column order (`core/CLAUDE.md`), so reordering
 * the seven would move every existing breakdown column in the picker.
 */
export const BookingBreakdownSchema: z.ZodType<BookingBreakdown> = z.strictObject({
  cleaning: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.cleaning }),
  damaged: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.damaged }),
  lost: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.lost }),
  maintenance: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.maintenance }),
  out: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.out }),
  prepped: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.prepped }),
  quoted: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.quoted }),
  reserved: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.reserved }),
  returned: z.int().meta({ column: true, label: BOOKING_BREAKDOWN_LABELS.returned }),
});

/**
 * Every key of the booking custody breakdown, in lifecycle order (which is NOT
 * the schema's alphabetical field order — the UI reads left to right).
 *
 * These live beside the schema rather than in `utils/bookings.ts` because
 * schema modules cannot import utils (the dependency runs strictly one way) and
 * the movement journal needs the key union to type a custody transition.
 * `utils/bookings.ts` re-exports them, so existing importers are unaffected.
 */
export const BOOKING_BREAKDOWN_KEYS = [
  "quoted", "reserved", "prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance",
] as const;

/**
 * Keys representing units that have reached a terminal state: back, or out of
 * service with a reason. A booking is `complete` when these hold all its units.
 */
export const BOOKING_BREAKDOWN_TERMINAL_KEYS = [
  "returned", "lost", "damaged", "cleaning", "maintenance",
] as const;

/** One key of the booking lifecycle breakdown. */
export type BookingBreakdownKeyType = typeof BOOKING_BREAKDOWN_KEYS[number];

/** Zod enum over the breakdown keys — the custody axis of a movement. */
export const BookingBreakdownKeyEnum: z.ZodType<BookingBreakdownKeyType> = z.enum(
  BOOKING_BREAKDOWN_KEYS,
);

// Compile-time guard: the key list and the breakdown shape cannot drift apart.
// Either direction failing is a type error, so adding a key to one without the
// other does not compile.
type _KeysCoverBreakdown = BookingBreakdownKeyType extends keyof BookingBreakdown ? true : never;
type _BreakdownCoversKeys = keyof BookingBreakdown extends BookingBreakdownKeyType ? true : never;
const _keyParity: [_KeysCoverBreakdown, _BreakdownCoversKeys] = [true, true];
void _keyParity;

/**
 * A breakdown object schema DERIVED from {@link BOOKING_BREAKDOWN_KEYS}, for the
 * breakdown's two other stored or wire spellings: the order's
 * `bookings_breakdown` roll-up and `UpdateBookingInput.breakdown`. Each used to
 * be a hand-written copy of the seven keys, and the input's copy was a
 * non-strict `z.object` — so a new key would have been STRIPPED off the wire
 * with nothing failing.
 *
 * `leaf` is each key's schema. Every key is required.
 */
export function breakdownObjectSchema(
  leaf: () => z.ZodType<number>,
  mode: "strict" | "strip",
): z.ZodType<BookingBreakdown> {
  const shape: Record<string, z.ZodType> = {};
  for (const key of BOOKING_BREAKDOWN_KEYS) shape[key] = leaf();
  const schema = mode === "strict" ? z.strictObject(shape) : z.object(shape);
  return schema as unknown as z.ZodType<BookingBreakdown>;
}

// ── Unit sets (serialized products) ─────────────────────────────────

/**
 * The breakdown buckets that hold NAMED units on a serialized product's
 * booking (`api-cloudrun/.claude/plans/serial-tracking.md` D2). Alphabetical,
 * because key order is column order.
 *
 * `quoted` and `reserved` are absent on purpose: a reserved unit is a count
 * against the shelf, not a particular radio. Units are named from `prep` on.
 *
 * Every TERMINAL bucket carries a set too, because a shrinking `out` set alone
 * cannot say which units came back and which were lost.
 */
export const BOOKING_UNIT_BUCKETS = [
  "cleaning", "damaged", "lost", "maintenance", "out", "prepped", "returned",
] as const;

/** One bucket that holds named units. */
export type BookingUnitBucketType = typeof BOOKING_UNIT_BUCKETS[number];

// Compile-time guard: every unit bucket is a breakdown key.
type _UnitBucketsAreKeys = BookingUnitBucketType extends BookingBreakdownKeyType ? true : never;
const _unitBucketSubset: _UnitBucketsAreKeys = true;
void _unitBucketSubset;

/**
 * Which units sit in each bucket of a booking. Each set is a canonical
 * `UnitSet` (ascending, unique), and the sets are pairwise disjoint.
 *
 * `units[k].length` may be LESS than `breakdown[k]`: the difference is the
 * bucket's UNTRACKED count, units a bulk → serialized conversion found already
 * prepped or out and could not name. It is derived, never stored —
 * `untrackedUnitCount` (`@cfs/core/utils/bookings`).
 */
export type BookingUnitSetsType = Record<BookingUnitBucketType, number[]>;

/** Zod schema for {@link BookingUnitSetsType}, built the way {@link breakdownObjectSchema} is. */
export const BookingUnitSetsSchema: z.ZodType<BookingUnitSetsType> = (() => {
  const shape: Record<string, z.ZodType> = {};
  for (const key of BOOKING_UNIT_BUCKETS) shape[key] = UnitSet;
  return (z.strictObject(shape) as unknown as z.ZodType<BookingUnitSetsType>).superRefine((sets, ctx) => {
    const seen = new Map<number, BookingUnitBucketType>();
    for (const key of BOOKING_UNIT_BUCKETS) {
      for (const n of sets[key]) {
        const other = seen.get(n);
        if (other !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `unit ${n} is in both "${other}" and "${key}"; a unit is in one bucket at a time`,
          });
        }
        seen.set(n, key);
      }
    }
  });
})();

/** Empty sets in every unit bucket: a seeded booking that names no unit yet. */
export function emptyBookingUnitSets(): BookingUnitSetsType {
  return { cleaning: [], damaged: [], lost: [], maintenance: [], out: [], prepped: [], returned: [] };
}
