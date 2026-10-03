/**
 * UnitRoster document schema — Firestore collection: `unit-rosters`.
 *
 * The cross-booking index of a serialized product: where each of its units is
 * right now. One document per product, id = the product uid (the `stock-locks`
 * pattern in `schemas/stock.ts`).
 *
 * ## One author: the ledger writer
 *
 * The roster is a FOLD of the movement journal — `foldRosterUnits`
 * (`@cfs/core/utils/units`) over every movement's `units` / `lines[].units` —
 * and only api-cloudrun's ledger writer (`commitLedgerMovements`) writes it,
 * once per serialized product per batch, under its `updateTime` precondition.
 * Booking, out-of-service, store-transfer, unit-admin and conversion writers
 * never touch it; they put units on their movements and that is all. The one
 * lifecycle writer (seed and delete, on a `stock_method` change or a create) is
 * `api-cloudrun/src/services/products.ts`, as it already is for the ledger.
 * `api-cloudrun/.claude/plans/serial-tracking.md` D5 has the reasoning.
 *
 * ## Why one document per product
 *
 * A 200-radio check-out against one document per unit is 200 writes inside
 * two 450-write budgets, and a product cannot be split across chunks. The
 * roster costs one. Its keys are the product's ACTIVE numbers exactly, so
 * `count(keys) === inventory-ledgers/{P}.quantity_held` on a seeded product.
 *
 * ⚠️ **`units` needs a single-field index EXEMPTION** (api-cloudrun Terraform).
 * Without it every subfield is re-indexed on every write, against Firestore's
 * 40,000 index entries per document.
 *
 * Availability never reads this. `stock/{P}` stays anonymous counts, and no
 * unit identity reaches it.
 *
 * @module
 */

import { z } from "zod";
import { BookingId, FirestoreId, OutOfServiceId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType, OOS_FLAG_REASONS, type OOSFlagReasonType } from "./common.ts";

/** The states a rostered unit can be in. See {@link UnitRosterEntryType}. */
export const UNIT_ROSTER_STATES = ["shelf", "prepped", "out", "away", "unattributed_out"] as const;
/** One roster state. */
export type UnitRosterStateType = typeof UNIT_ROSTER_STATES[number];

/**
 * Where one unit is.
 *
 * - `shelf` — on a CFS shelf. `flag` is the out-of-service reason it carries
 *   there (damaged, cleaning, maintenance), with the record that flagged it;
 *   both `null` for a unit in service. A flagged unit is never offered for
 *   prep or check-out.
 * - `prepped` — picked onto a booking's prep shelf; still physically at
 *   `uid_location`.
 * - `out` — at a customer, on `uid_booking`.
 * - `away` — standing AT an out-of-service record: lost, or at the record's
 *   destination (a vendor). Never offered.
 * - `unattributed_out` — written only by the bulk → serialized conversion: a
 *   unit that is out on some booking, but which booking's number it is was
 *   never recorded. The physical count resolves these as ordinary custody.
 *
 * The id fields are typed per state rather than a polymorphic `DocSource`,
 * because the discriminant already fixes which collection each names.
 * `OutOfServiceId`, not `FirestoreId`: a loss record's id is its opening
 * movement's (`MovementId`-shaped), so `FirestoreId` would refuse every
 * `mark_lost` unit.
 */
export type UnitRosterEntryType =
  | {
    state: "shelf";
    uid_location: string;
    flag: OOSFlagReasonType | null;
    uid_out_of_service: string | null;
  }
  | { state: "prepped"; uid_booking: string; uid_location: string }
  | { state: "out"; uid_booking: string }
  | { state: "away"; uid_out_of_service: string }
  | { state: "unattributed_out" };

const OOSFlagReasonEnum: z.ZodType<OOSFlagReasonType> = z.enum(OOS_FLAG_REASONS);

/** Zod schema for {@link UnitRosterEntryType}. */
export const UnitRosterEntry: z.ZodType<UnitRosterEntryType> = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("shelf"),
    uid_location: FirestoreId,
    flag: OOSFlagReasonEnum.nullable(),
    uid_out_of_service: OutOfServiceId.nullable(),
  }).refine((e) => (e.flag === null) === (e.uid_out_of_service === null), {
    message: "a flagged shelf unit names the record that flagged it, and an unflagged one names none",
    path: ["uid_out_of_service"],
  }),
  z.strictObject({ state: z.literal("prepped"), uid_booking: BookingId, uid_location: FirestoreId }),
  z.strictObject({ state: z.literal("out"), uid_booking: BookingId }),
  z.strictObject({ state: z.literal("away"), uid_out_of_service: OutOfServiceId }),
  z.strictObject({ state: z.literal("unattributed_out") }),
]);

/**
 * A roster key: a unit number as Firestore spells a map key — decimal, no
 * leading zero, never `0`. The same spelling as `UnitId`'s number segment.
 */
export const UnitRosterKey: z.ZodType<string> = z.string().regex(
  /^[1-9][0-9]*$/,
  "Must be a unit number without leading zeros",
);

/** One serialized product's roster. See the module docblock. */
export interface UnitRoster {
  /** The product uid. */
  uid: string;
  uid_product: string;
  /** Unit number (as a string key) → where it is. Keys are the ACTIVE numbers exactly. */
  units: Record<string, UnitRosterEntryType>;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for {@link UnitRoster}. */
export const UnitRosterSchema: z.ZodType<UnitRoster> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  units: z.record(UnitRosterKey, UnitRosterEntry),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Unit Roster",
  collection: "unit-rosters",
  displayDefaults: {
    columns: ["updated_at"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
